# The four adversarial refutations, rescued from a temp directory

On 30 July 2026 four adversaries were briefed to refute four "cannot" verdicts about
`portfolio-gate`, `exec-verify`, `lp-risk` and `options-risk`. All four succeeded, with real
measurements: Groth16 builds on the ceremony file already on disk, two locally generated
powers-of-tau, a closed-form LP circuit, a Poseidon-committed exec circuit.

**Every artifact they produced lived in a session-scoped temp directory.** `zk/build` held exactly two
`.ptau`, both power 12 — and they are byte-identical to each other, so it held *one* ceremony file
twice. The refutations were real and the repository could not reproduce them, which is the same defect
as a measurement that exists only in a scrollback.

This directory is the repair. Nothing here is a new claim; it is the same work, runnable from a clone.

## Reproduce

```
npm run gate:z                     # from the service tree — reproduces the whole cheap set
npm run gate:z-revert              # prove the gate can go red, four ways

node zk/scripts/adversary/repro.mjs                            # the same thing, directly
ADV_WORK=/some/empty/dir node zk/scripts/adversary/repro.mjs    # into a clean directory
```

Everything the cheap set needs is already in the repository: `build/hez_final_12.ptau`, the committed
circuits, the committed probes. **Nothing is downloaded and nothing is written into the tree** — every
rebuilt artifact lands under `ADV_WORK`, default `zk/build/adv`.

Two claims need a bigger ceremony file than the repository carries. Neither needs a download:

```
node zk/scripts/adversary/ptau.mjs make 13     #  ~31 s,   ~9.0 MiB   -> options-risk route B
node zk/scripts/adversary/ptau.mjs make 17     # ~11 min, ~144 MiB    -> lpexpectation's real cost
node zk/scripts/adversary/lp/expsetup.mjs      # then this, ~10 s, writes a ~231 MiB zkey
```

## What is reproducible, and in which sense

Three different strengths of claim live here and conflating them would be the false claim.

| | reproducible? | why |
|---|---|---|
| committed circuits and probes | **byte-for-byte**, sha256 in `MANIFEST.json` | they are text in the repo |
| `.r1cs` from circom | **byte-for-byte**, pinned | circom 2.2.3 is deterministic |
| Plonk `.zkey` on `hez_final_12` | **byte-for-byte**, pinned | `plonk setup` has no randomness, and both inputs are committed |
| the `ncdf` variant circuits | **byte-for-byte** from `gen-variant.mjs` | the generator is the trust root; `repro.mjs` regenerates and diffs |
| constraint counts, domains, public-signal counts | **exact integers**, pinned | read out of artifact headers, not from a log |
| a locally generated `.ptau` | **not byte-reproducible** | `powersoftau new` mixes fresh entropy |
| anything built on a local `.ptau` | **counts yes, bytes no** | inherits the ceremony file's entropy |
| Groth16 `.zkey` | **counts yes, bytes no** | phase-2 contribution mixes entropy |
| verify gas | **within ~1.22%** | measured run-to-run spread, about 3,500 gas, plus a 7,500-gas EIP-2929 cold/warm gap |

Three independent 2^13 files generated in this project measure **9,438,629**, **9,438,644** and
**9,438,657** bytes. That is why `ptau.mjs make` asserts `powersoftau verify` and the power in the file
header rather than a digest: a digest pinned to a locally generated ceremony is a check that always
fails, and the honest check is the structural one. `ptau.mjs fetch` does pin a digest, and **refuses**
any power whose digest nobody in this project has measured, rather than accepting whatever arrives.

## Layout

```
zk/circuits/adv/          37 circuits — the wide N=5..7 and batched N=4..11 portfolio shapes,
                          the exec-verify minimal/private/Poseidon variants, the closed-form LP
                          circuit, and the generated CDF family
zk/scripts/adversary/
  paths.mjs               resolves the zk tree, the service tree and the work directory
  build-adv.mjs           compile (and optionally set up) one circuit into the work directory
  ptau.mjs                make | fetch | check a ceremony file
  repro.mjs               the gate — source integrity, byte identity, and the figures
  MANIFEST.json           pinned digests. Rewritten only by `repro.mjs --write-manifest`
  portfolio/              probe1..probe5 and the N-leg witness builder
  exec/                   gas, the direct-Solidity check, the witness window, the 13-witness equality
  lp/                     the closed form three ways, the gates, the 2^17 setup
  options/                the generator, the two-proof route, the single-circuit route
  original-results/       probe1..5.json exactly as the original run wrote them
```

## Which probes reproduce their own recorded defects

Two rescued scripts are the adversaries' **first** passes and fail exactly where their authors said they
failed. They are kept, unpatched, because a report that says "three of my checks failed before they
passed" is worth more with the failing versions on disk:

- `lp/gate-lpclosed.mjs` — prints a field element as a magnitude (so the worst-residual row reads
  `r-1`) and crashes calling `plonk.verify` without a logger. `lp/gate-lpclosed2.mjs` is the repair,
  and `lp/gate-lpclosed-evm.mjs` is the EVM half it reached for the wrong module for.
- `exec/advgas.mjs` — runs four circuits in one process and stalls. `exec/advgas2.mjs` is the
  one-circuit-per-process rewrite its author replaced it with.

`gate-lpclosed2.mjs` also still shows **6 of 8** breakeven cases certified. That is the unfixed
tolerance defect its own author recorded and did not repair, reproducing as red.

`exec/directcheck.mjs` shows **three red rows** — `xHat+1`, `yHat+1` and `outHat+1` accepted. Those red
rows *are* the finding: the shipped statement admits those tuples, so a perturbation test that moves a
public signal after proving is measuring Plonk's input binding, not this statement's strength.
