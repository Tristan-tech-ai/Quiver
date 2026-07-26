# Research artifact manifest

The crash study in Section 6 of the technical documentation rests on the files below. This manifest exists so a reader can establish two things without our cooperation.

**First, that these files have not changed.** Recompute the SHA-256 of each file in a clone of this repository and compare against the table. Every hash must match. Feeding those fourteen hashes, in the order listed, to Quiver's own `risk-attest` service (or any Merkle implementation using the same ordering and the same leaf/node tagging) must reproduce this root:

```
merkleRoot     0xd376b71f94d54967325fbddc60b5d35d478884f1a70e63e0844532c24642c784
itemCount      14
engineVersion  q1-68fae54ea919492c
```

**Second, what this does and does not prove.** It proves the bytes are unchanged relative to this published manifest, which is itself timestamped by this repository's commit history. It does **not** prove those files existed on the dates the study reports. A hash published today cannot back-date itself, and no wording in the paper claims otherwise.

What supports the pre-registration claim is narrower, and should be read as narrow: the calibration file contains only 2025 stress episodes; the decision thresholds appear in `h2.sql` and `h2b.sql` as literal constants rather than as anything fitted at query time; and the commit history shows the order in which those files appeared. All three are author-controlled. A reader who wants the strong form of this guarantee should want an anchor made *before* the results existed. We did not make one, and it cannot be obtained retroactively.

## The root changed twice on 26 July 2026, for two different reasons

Both are worth stating, because one of them means an earlier version of this file did not do what it told you to do.

**First, the tree was wrong.** The root `0x5f9da9985453d65dc30c2d94c20d3313b9138bb8386c9c57bef83c23cf3a8369` was produced by a defective `risk-attest`: it folded the hashes as ASCII hex **text** rather than as packed 32-byte words, so no on-chain verifier could check a proof it issued, and it did not domain-separate leaves from internal nodes, so an internal node of the tree verified against the root as though it were a member. An adversarial reviewer with live access found both. The engine was fixed (build `q1-bce7e7bccb16ea1b` → `q1-68fae54ea919492c`), a soundness self-check that presents an internal node as a leaf now runs on every call, and the root over the same fourteen files became `0x79965facc7f122e2a48bf0f39be79c2e1375d24e9915bfa163f54e49d34ab0d5`. The fourteen per-file hashes did not change, and that is the part which actually pins the research.

**Second, one of those fourteen hashes was not reproducible from a clone — which is the whole point of this file.** `h2b.sql` sat in the working copy carrying a single CRLF while git stored it with LF, so the published hash was computed over 2,013 bytes and anyone following the instructions below would compute it over the 2,012 bytes a checkout actually gives them, and get a different answer. `git status` cannot see this: with `text=auto` it compares files after normalising line endings, so the divergence is invisible exactly where it does damage. It was caught by running this file's own instructions against a fresh clone instead of trusting them. The file is now normalised, `.gitattributes` pins `*.sql` to LF explicitly rather than relying on content sniffing, and the root is `0xd376b71f94d54967325fbddc60b5d35d478884f1a70e63e0844532c24642c784`.

The honest consequence: **before this revision, the manifest could not be fully verified by the procedure it published** — thirteen of fourteen hashes matched a clone and the fourteenth did not, which for a document about verifiability is a failure and not a footnote. It is fixed, and the fix is checked by the same procedure a reader would run.

If you are checking whether the study's inputs were edited, check the fourteen file hashes; the root is a convenience for checking all of them at once, and a change in the root with the file hashes intact means the tree or the encoding moved, not the research.

## Files

| File | SHA-256 | Bytes |
|---|---|---|
| `research/crash-study/QUIVER_CRASH_STUDY.md` | `aaf6eaf381fafd2a094c356b6a5945e9dc0bdf31928fb16c810d25ac092c2e45` | 15907 |
| `research/reservoir-data/beta-calibration.json` | `40f4a87eb458d6bac59010692ee652e6feea3fe76205ad2a2c1dfd7c27ec8c68` | 2077 |
| `research/reservoir-data/episode-betas.json` | `1e9d58a0fb77639735c4f21a8f2f36eb39d7ba291dc4555bee48dadd12a928c7` | 16559 |
| `research/reservoir-data/episodes.json` | `49e87b3959c08c7552b086f814c199a20ee029c8804c81176d2142688f20a707` | 5892 |
| `research/reservoir-data/h1-result.json` | `1e5c5eb9820bced10b1bd8112517a3852ce010c28ca2d9abf61c3c72d6c5832a` | 548 |
| `research/reservoir-data/h2.sql` | `92285d5457b236ea8602f418b4fcea954322430ceec559268f69e1dcae93de65` | 2004 |
| `research/reservoir-data/h2b.sql` | `2e9d76d204d29b4c04795ddf33635d2d072203194f9970a0b956ecb96ca22af2` | 2012 |
| `research/reservoir-data/gen-h2.mjs` | `10bd819528ef620e9529df0a66b2835691193185bbda865b49634f914bee2261` | 2667 |
| `research/reservoir-data/measure-betas-episodes.mjs` | `d51687df2a419b79b9c0427f39817f5472e7e254e5eb0720eff00f68d4dbb485` | 5900 |
| `research/reservoir-data/detect-episodes.mjs` | `4701c02391400211b376f46afc5c16deedafed5f4898828af4ddf4f22d7dccba` | 3441 |
| `research/reservoir-data/replay-analysis.sql` | `9d65dea40c3b7902a5a6a806bdb27554507435e1fc001705cab32a026b23705d` | 4760 |
| `research/reservoir-data/ablation.sql` | `9fd6e77aa1a998411e430f4fe1f79419aa450b96bd5596841b844f9e97fc58b4` | 4758 |
| `research/reservoir-data/ablation-feb.sql` | `5f5b96f528f739dac7acb94d87869cb2bb4819a3170a4ab292505d39a1fc520a` | 4758 |
| `research/reservoir-data/ablation-result.json` | `2aec24984012f686f7c3933529f93f30fa23b370d1462f00f8c76ecebe42c195` | 2702 |

## Reproducing the root

```bash
git clone https://github.com/Tristan-tech-ai/Quiver.git && cd Quiver
sha256sum \
  research/crash-study/QUIVER_CRASH_STUDY.md \
  research/reservoir-data/beta-calibration.json \
  research/reservoir-data/episode-betas.json \
  research/reservoir-data/episodes.json \
  research/reservoir-data/h1-result.json \
  research/reservoir-data/h2.sql \
  research/reservoir-data/h2b.sql \
  research/reservoir-data/gen-h2.mjs \
  research/reservoir-data/measure-betas-episodes.mjs \
  research/reservoir-data/detect-episodes.mjs \
  research/reservoir-data/replay-analysis.sql \
  research/reservoir-data/ablation.sql \
  research/reservoir-data/ablation-feb.sql \
  research/reservoir-data/ablation-result.json
```

Then batch those hashes through `POST /api/risk-attest` with `{ "contentHashes": [ ... ] }` in the order above, and compare `merkleRoot`. The service also returns the tagging rule and a Solidity verifier for the tree, so the root can be recomputed without calling us at all: leaf = `sha256(0x00 || fileHash)`, node = `sha256(0x01 || min(a,b) || max(a,b))` over packed bytes, pairing left to right and promoting an odd trailing node.

## On-chain anchor

An attestation of this root under the `risk-attest` EAS schema on Base (`0x59a8587b287d3f13776dccbe49e19d2e887f90b5e16650464b07e613d89287e0`, schema string `bytes32 merkleRoot, uint256 itemCount, string engineVersion`) is prepared but **not yet submitted**: the anchoring wallet holds no gas on Base, since the x402 payment path never needs any. When it is submitted the attestation UID will be added here and to Appendix C of the paper. Until then, treat the guarantee above as "unchanged relative to a git-timestamped manifest", which is weaker than an on-chain anchor and stronger than nothing.
