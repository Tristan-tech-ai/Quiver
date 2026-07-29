import app from './app.js';
import { config } from './config.js';
import { backendName } from './adapters/data.js';
import { flushProofWrites } from './util/snark.js';

const server = app.listen(config.port, () => {
  console.log(`veritape listening on :${config.port} (adapter=${backendName}, devMode=${config.devMode})`);
});

// A redeploy is a SIGTERM, and with a durable store the proof that was `ready` a millisecond ago may
// still be in flight to S3. Losing it is survivable — the caller polls, gets a 404 and re-asks, and it
// is rebuilt — but "survivable" is not the claim Phase A makes, so the container spends up to five
// seconds letting the writes land. Bounded, because a shutdown that will not finish is worse than a
// lost proof: the platform SIGKILLs it and the deploy is held up for everyone.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);   // a second signal means "stop waiting", and it is honoured
    shuttingDown = true;
    const hard = setTimeout(() => process.exit(0), 5000);
    hard.unref();
    server.close();
    flushProofWrites()
      .catch(() => { /* a failed write is already recorded by the store, and /build reports it */ })
      .finally(() => process.exit(0));
  });
}
