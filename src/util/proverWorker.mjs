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


// MORE THAN ONE CIRCUIT NOW, AND STILL ONE PROCESS. `size-gate` proves the discrete-Kelly identity
// against `kelly_plonk.zkey`; `perp-gate` proves the liquidation identity against
// `liquidation_plonk.zkey`. The obvious implementation is one worker per circuit and it is the wrong
// shape: each fork costs ~80 MB resident before it has proved anything, and a service that adds a
// circuit would add a permanently-idle process. So the artifacts are loaded LAZILY and cached PER
// CIRCUIT — a deploy where nobody ever asks size-gate for a proof never reads the 2.2 MB Kelly key,
// and a deploy where both are used pays for both exactly once.
//
// The names are a closed set, deliberately. `msg.circuit` arrives from the parent, and joining an
// arbitrary string onto a filesystem path is a traversal primitive; an unknown name is refused here
// rather than resolved.
const require = createRequire(import.meta.url);
const ZK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'zk');

const CIRCUITS = {
  liquidation: { zkey: 'liquidation_plonk.zkey', dir: 'liquidation_js', wasm: 'liquidation.wasm' },
  kelly: { zkey: 'kelly_plonk.zkey', dir: 'kelly_js', wasm: 'kelly.wasm' },
  concentration: { zkey: 'concentration_plonk.zkey', dir: 'concentration_js', wasm: 'concentration.wasm' },
  // 7.8 MB — the largest key this service carries, and the reason the lazy load above is not an
  // optimisation but the thing that makes a fourth circuit affordable at all. A deploy where nobody
  // asks exec-verify for a proof never reads it.
  execadverse: { zkey: 'execadverse_plonk.zkey', dir: 'execadverse_js', wasm: 'execadverse.wasm' },
  // 10.3 MB, the largest key on this host — 26 range-checked truncating multiplies and a 45-bit
  // decomposition cost more constraints than any arithmetic identity here. It is also the strongest
  // case yet for the lazy load: a deploy where nobody asks event-vol for a proof never reads it, and
  // reading it is 10,262,700 bytes (measured; a share of assets/zk would go stale as siblings land).
  ncdf: { zkey: 'ncdf_plonk.zkey', dir: 'ncdf_js', wasm: 'ncdf.wasm' },
};
// The default is `liquidation` and it is load-bearing rather than tidy: a message from an older
// parent, or from any caller that has not been taught the field, must keep proving exactly the
// circuit it proved before this file learned a second one.
const DEFAULT_CIRCUIT = 'liquidation';

let snarkjs = null;
const loaded = new Map();   // circuit -> { zkey: Uint8Array, calc }

async function ready(name = DEFAULT_CIRCUIT) {
  const spec = CIRCUITS[name];
  if (!spec) throw new Error(`unknown circuit "${name}" — this prover holds ${Object.keys(CIRCUITS).join(', ')}`);
  if (!snarkjs) {
    const m = await import('snarkjs');
    snarkjs = m.default ?? m;
  }
  let entry = loaded.get(name);
  if (!entry) {
    const wasm = readFileSync(join(ZK, spec.dir, spec.wasm));
    entry = {
      zkey: new Uint8Array(readFileSync(join(ZK, spec.zkey))),
      calc: await require(join(ZK, spec.dir, 'witness_calculator.cjs'))(wasm),
    };
    loaded.set(name, entry);
  }
  return entry;
}

process.on('message', async (msg) => {
  // A bare warm signal loads the artifacts and says nothing back except that it is ready. Sent at
  // boot so the first real request does not pay for the import. It warms ONE circuit — the caller
  // says which — because warming every circuit at boot would put the cost this file exists to defer
  // straight back into startup for a deploy that may never prove that identity at all.
  if (msg && msg.warm) {
    try { await ready(msg.circuit || DEFAULT_CIRCUIT); process.send({ warmed: true, circuit: msg.circuit || DEFAULT_CIRCUIT }); }
    catch (e) { process.send({ warmed: false, error: String(e && e.message || e) }); }
    return;
  }
  const { id, witness, circuit } = msg || {};
  try {
    const { zkey, calc } = await ready(circuit || DEFAULT_CIRCUIT);
    const wtns = await calc.calculateWTNSBin(witness, 0);
    const { proof, publicSignals } = await snarkjs.plonk.prove(zkey, wtns);
    process.send({ id, proof, publicSignals });
  } catch (e) {
    process.send({ id, error: String(e && e.message || e).slice(0, 200) });
  }
});
