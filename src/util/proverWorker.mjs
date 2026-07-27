// The prover, exiled to its own thread.
//
// Node runs one thread, and proving is ~700ms of unbroken WASM arithmetic. Measured on the main
// thread it blocked the event loop for 506ms at worst, which showed up in production as a p95 of
// one full second on requests that had asked for nothing at all — they simply arrived while someone
// else's proof was being built. Deferring the work off the REQUEST path was not enough; it has to
// leave the thread that serves requests.
//
// Everything expensive lives here: the snarkjs import, the 5.3MB zkey, the witness WASM, and the
// proving itself. The parent keeps only the cheap integer encoding and a message queue, so its event
// loop stays free no matter how much proving is in flight.
//
// A CHILD PROCESS, NOT A WORKER THREAD. The obvious implementation was worker_threads and it does not
// work: snarkjs builds its curve through ffjavascript, which treats any non-main thread as one of its
// OWN workers and reads a workerData field that is not there — every proof died with "Cannot
// destructure property mod of threads.workerData". A forked process looks like a main thread to it,
// costs an extra ~80 MB of resident memory, and is the price of not patching a dependency.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


const require = createRequire(import.meta.url);
const ZK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'zk');

let snarkjs = null;
let zkey = null;
let calcP = null;

async function ready() {
  if (!snarkjs) {
    const m = await import('snarkjs');
    snarkjs = m.default ?? m;
  }
  if (!zkey) zkey = new Uint8Array(readFileSync(join(ZK, 'liquidation_plonk.zkey')));
  if (!calcP) {
    const wasm = readFileSync(join(ZK, 'liquidation_js', 'liquidation.wasm'));
    calcP = require(join(ZK, 'liquidation_js', 'witness_calculator.cjs'))(wasm);
  }
  return calcP;
}

process.on('message', async (msg) => {
  // A bare warm signal loads the artifacts and says nothing back except that it is ready. Sent at
  // boot so the first real request does not pay for the import.
  if (msg && msg.warm) {
    try { await ready(); process.send({ warmed: true }); }
    catch (e) { process.send({ warmed: false, error: String(e && e.message || e) }); }
    return;
  }
  const { id, witness } = msg || {};
  try {
    const calc = await ready();
    const wtns = await calc.calculateWTNSBin(witness, 0);
    const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
    process.send({ id, proof, publicSignals });
  } catch (e) {
    process.send({ id, error: String(e && e.message || e).slice(0, 200) });
  }
});
