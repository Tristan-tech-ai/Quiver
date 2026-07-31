# Fixes that are committed but not live

Some repairs change served behaviour and some do not. This page is the list of the ones that **do**, so a
fix never sits in the repository unnoticed just because the deploy window happened to be shut when it
landed.

The rule it exists to enforce: when a claim turns out to be hiding a bug, the bug gets fixed rather than
the claim reworded. If the fix needs a deploy and no window is open, it is recorded here and shipped in
the next one.

**Nothing on this page is live yet.** The live container is whatever the last row of
`gates/deploy-log.tsv` describes.

## Pending

| # | fix | why it needs a deploy | risk if it waits | landed in |
|---|---|---|---|---|
| 1 | `lp-risk` serves a `divergence` sibling correcting `expectedDivergence.note` | it adds a field to a served response, so the live container will not carry it until shipped | low. The wrong sentence stays live: it calls the leading-order term a divergence from the exact expectation when it is that expectation’s **logarithm**. A reader may distrust a figure that is exact | 31 Jul 2026 |

## Not pending, and why

Every repair from the 30–31 July round is already live, or provably cannot affect the served surface.
Recording the second category matters as much as the first, because "not deployed" and "does not need
deploying" look identical from outside.

| fix | why no deploy is needed |
|---|---|
| `gen-ncdf-circom.mjs` refuses to overwrite a live circuit | build tooling; the service never runs it |
| `gateLP1-bracket-sweep.mjs` records each encoder refusal | a gate, not served code |
| `probe-direct-vs-snark-gas` publishes its estimator | a probe and its artifact |
| `parity.circom` and `greekssigned.circom` headers corrected | comments only, and both circuits recompile to identical constraint counts (1,153 and 1,952); neither circuit is wired |
| `revert-guard.mjs`, `revert-heal.mjs` | repository hygiene; not imported by `src/` |
| every defect-register and report correction | documentation |
| README, `docs/` depersonalisation | documentation |

## How a row leaves this page

It ships, `gates/deploy-log.tsv` gains a row with a marker only that deploy could produce, the change is
verified from outside against the live container, and the row moves to the changelog entry that describes
it. It does not leave by being reclassified.
