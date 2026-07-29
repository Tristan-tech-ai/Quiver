// A minimal S3-compatible HTTP server, for gate A to point the durable store at.
//
// WHY THIS EXISTS AND WHAT IT IS NOT
// There are no AWS credentials on the machine this was written on and none in CI, so a gate that
// could only run against real S3 would be a gate that never runs — and the thing gate A is for is
// being runnable unattended by anyone with a clone. This server holds objects in the memory of the
// process that starts it, which for gate A is the TEST RUNNER: the child process that builds a proof
// exits, and the object is still here, in a store that was never inside it. That is the durability
// property, tested the same way the filesystem half is tested.
//
// It is NOT a proof that our S3 usage works against Amazon. It does not verify SigV4 — it will serve
// a request signed with any key at all — so it cannot catch a credential or signing mistake, and it
// implements the five operations this store uses and nothing else. Gate A is therefore also runnable
// against a real S3 implementation by setting QUIVER_TEST_S3_ENDPOINT (MinIO, for example), and the
// gate says out loud which of the two it ran against. See PHASE_A_S3.md for exactly what each of the
// two can and cannot establish.
//
// Operations: PUT object · GET object · DELETE object · GET bucket (list-type=2) · POST bucket ?delete
import { createServer } from 'node:http';

const XML = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function errorXml(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(XML(`<Error><Code>${code}</Code><Message>${esc(message)}</Message><RequestId>gateA</RequestId></Error>`));
}

/**
 * Start the server.
 * @param opts.buckets  bucket names that exist. Anything else answers NoSuchBucket, which is how the
 *                      gate produces a "you pointed me at a bucket that is not there" refusal without
 *                      needing an AWS account to be refused by.
 * @param opts.fault    null | 'deny' (403 AccessDenied on every request) | 'error' (500 on writes).
 *                      Fault injection is the point: a store that cannot be made to fail cannot be
 *                      shown to report failure honestly.
 */
export async function startS3(opts = {}) {
  const buckets = new Set(opts.buckets || ['proofs']);
  let fault = opts.fault || null;
  // bucket -> Map(key -> { body: Buffer, at: Date })
  const data = new Map();
  for (const b of buckets) data.set(b, new Map());
  const seen = [];   // every request, so a test can assert on what the SDK actually sent

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://s3.local');
      // Path style only: /<bucket>/<key…>. Virtual-host style would need DNS we do not control, and
      // the store forces path style whenever a custom endpoint is configured for exactly that reason.
      const parts = url.pathname.replace(/^\/+/, '').split('/');
      const bucket = parts.shift();
      const key = parts.join('/');
      seen.push({ method: req.method, bucket, key, query: url.search, headers: req.headers });

      if (fault === 'deny') return errorXml(res, 403, 'AccessDenied', 'Access Denied');
      if (!buckets.has(bucket)) return errorXml(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
      const objs = data.get(bucket);

      // ── DeleteObjects ──────────────────────────────────────────────────────────────────────────
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        const keys = [...String(body).matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
        for (const k of keys) objs.delete(k);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(XML('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>'));
      }

      // ── ListObjectsV2 ──────────────────────────────────────────────────────────────────────────
      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        const maxKeys = Number(url.searchParams.get('max-keys') || 1000);
        const after = url.searchParams.get('continuation-token') || '';
        const all = [...objs.entries()]
          .filter(([k]) => k.startsWith(prefix) && k > after)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const page = all.slice(0, maxKeys);
        const truncated = all.length > page.length;
        const contents = page.map(([k, v]) =>
          `<Contents><Key>${esc(k)}</Key><LastModified>${v.at.toISOString()}</LastModified><ETag>&quot;${v.body.length}&quot;</ETag><Size>${v.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(XML(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
          + `<Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>`
          + `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>`
          + (truncated ? `<NextContinuationToken>${esc(page.at(-1)[0])}</NextContinuationToken>` : '')
          + contents + `</ListBucketResult>`));
      }

      // ── PutObject ──────────────────────────────────────────────────────────────────────────────
      if (req.method === 'PUT') {
        if (fault === 'error') return errorXml(res, 500, 'InternalError', 'We encountered an internal error');
        objs.set(key, { body, at: new Date() });
        res.writeHead(200, { etag: `"${body.length}"` });
        return res.end();
      }

      // ── GetObject ──────────────────────────────────────────────────────────────────────────────
      if (req.method === 'GET' || req.method === 'HEAD') {
        const o = objs.get(key);
        if (!o) return errorXml(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': o.body.length });
        return res.end(req.method === 'HEAD' ? undefined : o.body);
      }

      // ── DeleteObject ───────────────────────────────────────────────────────────────────────────
      if (req.method === 'DELETE') {
        objs.delete(key);
        res.writeHead(204);
        return res.end();
      }

      return errorXml(res, 405, 'MethodNotAllowed', `${req.method} is not implemented by this emulator`);
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint,
    seen,
    keys: (bucket = [...buckets][0]) => [...(data.get(bucket) || new Map()).keys()],
    get: (k, bucket = [...buckets][0]) => (data.get(bucket)?.get(k)?.body ?? null),
    /** Corrupt an object in place, to check that a damaged record reads as a miss and not a crash. */
    poke: (k, text, bucket = [...buckets][0]) => data.get(bucket).set(k, { body: Buffer.from(text), at: new Date() }),
    setFault: (f) => { fault = f; },
    close: () => new Promise((r) => server.close(r)),
  };
}
