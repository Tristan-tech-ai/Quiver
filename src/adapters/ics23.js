// ICS-23 existence-proof verification + a minimal protobuf wire reader.
//
// Venue-agnostic: this is the Cosmos/IAVL commitment format, used here for dYdX v4 (§4.2 of
// PHASE_D_RESEARCH.md) and reusable for any CometBFT chain. It sits OUTSIDE src/engine/, so nothing
// here can move the published build hash.
//
// WHAT A VERIFIED PROOF ACTUALLY SAYS. `calculateRoot` recomputes a Merkle root from the leaf up. It
// does not fetch that root, and it does not know whether the root is real. Verification is only
// meaningful once the caller compares the returned root against an app_hash obtained some other way,
// and the strength of the whole claim is the strength of THAT step, never this one. See the trust-chain
// header in dydx-attest.js.
//
// The spec checks below are not decoration. ICS-23 without them is forgeable: an attacker supplies a
// leaf op whose prefix matches an inner op (or vice versa) and reshapes the tree. `CheckAgainstSpec` is
// the reason the ops are pinned to the IAVL / Tendermint specs rather than trusted from the proof.
import { createHash } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();

// ---------------------------------------------------------------- protobuf wire reader

/** Decode a protobuf message into a flat list of {field, wire, varint|bytes|fixed32|fixed64}. */
export function pbFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, n1] = uvarint(buf, i); i = n1;
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) { const [v, n2] = uvarint(buf, i); i = n2; out.push({ field, wire, varint: v }); }
    else if (wire === 2) {
      const [len, n2] = uvarint(buf, i); i = n2;
      const L = Number(len);
      if (i + L > buf.length) throw new Error('pb: length-delimited field overruns buffer');
      out.push({ field, wire, bytes: buf.subarray(i, i + L) }); i += L;
    } else if (wire === 5) { out.push({ field, wire, fixed32: buf.subarray(i, i + 4) }); i += 4; }
    else if (wire === 1) { out.push({ field, wire, fixed64: buf.subarray(i, i + 8) }); i += 8; }
    else throw new Error(`pb: unsupported wire type ${wire}`);
  }
  return out;
}

function uvarint(buf, i) {
  let x = 0n, s = 0n;
  for (;;) {
    if (i >= buf.length) throw new Error('pb: varint overruns buffer');
    const b = buf[i++];
    x |= BigInt(b & 0x7f) << s;
    if ((b & 0x80) === 0) return [x, i];
    s += 7n;
    if (s > 70n) throw new Error('pb: varint longer than 10 bytes');
  }
}

/** Protobuf unsigned varint encoder (also the LengthOp VAR_PROTO prefix). */
export function uvarintEnc(n) {
  const out = [];
  let x = BigInt(n);
  if (x < 0n) throw new Error('pb: uvarint of a negative number');
  do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; out.push(b); } while (x > 0n);
  return Buffer.from(out);
}

/** proto3 sint32/sint64 zigzag decode. */
export const zigzag = (u) => (u >> 1n) ^ -(u & 1n);

/**
 * Decode a PACKED repeated-varint field body into its raw unsigned varints.
 *
 * A packed field's bytes are a bare varint stream, NOT tag/value pairs, so running `pbFields` over
 * them reads the first value as a tag and produces confident nonsense. Callers still have to apply
 * the right interpretation on top: `sint32` means every element goes through `zigzag`, and skipping
 * that is what turns dYdX's premium samples into roughly -2x their true value.
 */
export function uvarints(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) { const [v, n] = uvarint(buf, i); i = n; out.push(v); }
  return out;
}

/** First field with this number, or undefined. */
export const pbFirst = (fs, field) => fs.find((f) => f.field === field);

// ---------------------------------------------------------------- ICS-23 message parsing

const HASH_NO = 0, HASH_SHA256 = 1;
const LEN_NO = 0, LEN_VAR_PROTO = 1;

function parseLeafOp(buf) {
  const fs = pbFields(buf);
  return {
    hash: Number(pbFirst(fs, 1)?.varint ?? 0n),
    prehashKey: Number(pbFirst(fs, 2)?.varint ?? 0n),
    prehashValue: Number(pbFirst(fs, 3)?.varint ?? 0n),
    length: Number(pbFirst(fs, 4)?.varint ?? 0n),
    prefix: pbFirst(fs, 5)?.bytes ?? Buffer.alloc(0),
  };
}

function parseInnerOp(buf) {
  const fs = pbFields(buf);
  return {
    hash: Number(pbFirst(fs, 1)?.varint ?? 0n),
    prefix: pbFirst(fs, 2)?.bytes ?? Buffer.alloc(0),
    suffix: pbFirst(fs, 3)?.bytes ?? Buffer.alloc(0),
  };
}

export function parseExistenceProof(buf) {
  const fs = pbFields(buf);
  const leaf = pbFirst(fs, 3);
  return {
    key: pbFirst(fs, 1)?.bytes ?? Buffer.alloc(0),
    value: pbFirst(fs, 2)?.bytes ?? Buffer.alloc(0),
    leaf: leaf ? parseLeafOp(leaf.bytes) : null,
    path: fs.filter((f) => f.field === 4).map((f) => parseInnerOp(f.bytes)),
  };
}

/** CommitmentProof oneof: exist(1) / nonexist(2) / batch(3) / compressed(4). */
export function parseCommitmentProof(buf) {
  const fs = pbFields(buf);
  const ex = pbFirst(fs, 1), nex = pbFirst(fs, 2);
  if (ex) return { kind: 'exist', exist: parseExistenceProof(ex.bytes) };
  if (nex) {
    const nfs = pbFields(nex.bytes);
    return {
      kind: 'nonexist',
      key: pbFirst(nfs, 1)?.bytes ?? Buffer.alloc(0),
      left: pbFirst(nfs, 2) ? parseExistenceProof(pbFirst(nfs, 2).bytes) : null,
      right: pbFirst(nfs, 3) ? parseExistenceProof(pbFirst(nfs, 3).bytes) : null,
    };
  }
  return { kind: fs.length ? `unsupported:${fs[0].field}` : 'empty' };
}

// ---------------------------------------------------------------- specs

// Transcribed from ics23's proofs.go. Deviating from these is how forged proofs get in, so they are
// constants here rather than anything the proof itself is allowed to influence.
export const IAVL_SPEC = {
  name: 'iavl',
  leaf: { hash: HASH_SHA256, prehashKey: HASH_NO, prehashValue: HASH_SHA256, length: LEN_VAR_PROTO, prefix: Buffer.from([0]) },
  inner: { hash: HASH_SHA256, minPrefixLength: 4, maxPrefixLength: 12, childSize: 33 },
};

export const TENDERMINT_SPEC = {
  name: 'simple',
  leaf: { hash: HASH_SHA256, prehashKey: HASH_NO, prehashValue: HASH_SHA256, length: LEN_VAR_PROTO, prefix: Buffer.from([0]) },
  inner: { hash: HASH_SHA256, minPrefixLength: 1, maxPrefixLength: 1, childSize: 32 },
};

const doHash = (op, data) => {
  if (op === HASH_NO) return data;
  if (op === HASH_SHA256) return sha256(data);
  throw new Error(`ics23: unsupported hash op ${op}`);
};

const doLength = (op, data) => {
  if (op === LEN_NO) return data;
  if (op === LEN_VAR_PROTO) return Buffer.concat([uvarintEnc(data.length), data]);
  throw new Error(`ics23: unsupported length op ${op}`);
};

/**
 * Recompute the root an existence proof commits to, checking every op against `spec` first.
 * Throws on any deviation — a proof that does not match its spec is refused, never "mostly verified".
 */
export function calculateRoot(ex, spec) {
  if (!ex || !ex.leaf) throw new Error('ics23: existence proof has no leaf op');
  const L = ex.leaf, S = spec.leaf;
  if (L.hash !== S.hash) throw new Error(`ics23/${spec.name}: leaf hash op ${L.hash} != spec ${S.hash}`);
  if (L.prehashKey !== S.prehashKey) throw new Error(`ics23/${spec.name}: leaf prehash_key ${L.prehashKey} != spec ${S.prehashKey}`);
  if (L.prehashValue !== S.prehashValue) throw new Error(`ics23/${spec.name}: leaf prehash_value ${L.prehashValue} != spec ${S.prehashValue}`);
  if (L.length !== S.length) throw new Error(`ics23/${spec.name}: leaf length op ${L.length} != spec ${S.length}`);
  if (!L.prefix.subarray(0, S.prefix.length).equals(S.prefix)) throw new Error(`ics23/${spec.name}: leaf prefix does not start with the spec prefix`);
  if (ex.key.length === 0) throw new Error('ics23: empty key');
  if (ex.value.length === 0) throw new Error('ics23: empty value');

  let h = doHash(L.hash, Buffer.concat([
    L.prefix,
    doLength(L.length, doHash(L.prehashKey, ex.key)),
    doLength(L.length, doHash(L.prehashValue, ex.value)),
  ]));

  const IS = spec.inner;
  const maxPrefix = IS.maxPrefixLength + IS.childSize; // two children, child order [0,1]
  for (const [i, op] of ex.path.entries()) {
    if (op.hash !== IS.hash) throw new Error(`ics23/${spec.name}: inner[${i}] hash op ${op.hash} != spec ${IS.hash}`);
    // The confusion attack: an inner op that can be read as a leaf lets a prover reshape the path.
    if (op.prefix.subarray(0, S.prefix.length).equals(S.prefix)) throw new Error(`ics23/${spec.name}: inner[${i}] prefix starts with the leaf prefix`);
    if (op.prefix.length < IS.minPrefixLength) throw new Error(`ics23/${spec.name}: inner[${i}] prefix ${op.prefix.length} < min ${IS.minPrefixLength}`);
    if (op.prefix.length > maxPrefix) throw new Error(`ics23/${spec.name}: inner[${i}] prefix ${op.prefix.length} > max ${maxPrefix}`);
    if (op.suffix.length !== 0 && op.suffix.length !== IS.childSize) throw new Error(`ics23/${spec.name}: inner[${i}] suffix ${op.suffix.length} is neither 0 nor ${IS.childSize}`);
    h = doHash(op.hash, Buffer.concat([op.prefix, h, op.suffix]));
  }
  return h;
}

/**
 * Verify the two-op Cosmos store proof: ics23:iavl roots the key/value into one store, ics23:simple
 * roots that store into app_hash. Returns { appRoot, storeRoot, bytes }. Throws on any mismatch.
 *
 * `ops` is the `proofOps.ops` array from an abci_query response (base64 `data`, base64 `key`).
 */
export function verifyStoreProof({ ops, store, key, value }) {
  if (!Array.isArray(ops) || ops.length !== 2) throw new Error(`ics23: expected 2 proof ops, got ${ops?.length ?? 0}`);
  if (ops[0].type !== 'ics23:iavl') throw new Error(`ics23: op[0] type ${ops[0].type} != ics23:iavl`);
  if (ops[1].type !== 'ics23:simple') throw new Error(`ics23: op[1] type ${ops[1].type} != ics23:simple`);

  const p0 = parseCommitmentProof(Buffer.from(ops[0].data, 'base64'));
  const p1 = parseCommitmentProof(Buffer.from(ops[1].data, 'base64'));
  if (p0.kind !== 'exist') throw new Error(`ics23: iavl op is a ${p0.kind} proof, not an existence proof`);
  if (p1.kind !== 'exist') throw new Error(`ics23: simple op is a ${p1.kind} proof, not an existence proof`);

  // The proof must be about the key and value we asked for. Without this a node can answer with a
  // perfectly valid proof of a DIFFERENT key and the root check would still pass.
  if (!p0.exist.key.equals(Buffer.from(key))) throw new Error(`ics23: proof key ${p0.exist.key.toString('hex')} != requested ${Buffer.from(key).toString('hex')}`);
  if (!p0.exist.value.equals(Buffer.from(value))) throw new Error('ics23: proof value != returned value');
  if (!p1.exist.key.equals(Buffer.from(store, 'utf8'))) throw new Error(`ics23: store proof key ${p1.exist.key.toString('latin1')} != ${store}`);

  const storeRoot = calculateRoot(p0.exist, IAVL_SPEC);
  if (!p1.exist.value.equals(storeRoot)) throw new Error('ics23: simple-op value is not the iavl store root');
  const appRoot = calculateRoot(p1.exist, TENDERMINT_SPEC);

  return {
    appRoot,
    storeRoot,
    bytes: ops.reduce((a, o) => a + Buffer.from(o.data, 'base64').length, 0),
    depth: [p0.exist.path.length, p1.exist.path.length],
  };
}
