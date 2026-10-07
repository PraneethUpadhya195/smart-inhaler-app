# PRISM Smart Inhaler App — Claude Code Instructions

This is the React Native (Expo) mobile app for PRISM. It runs the PRISM
inference contract on-device: PCM audio → DSP → ONNX event detector →
Inhale events → scoreability → V2 features → frozen baseline → `SCORE_ONLY`
result.

The research pipeline that defines this contract lives in the sibling
repository `../PRISM smart inhaler`.

## 1. Read before doing anything

Do not assume a previous Claude session's context is available. The
repository is the source of truth. Read, in this order:

1. `claude_implementation.md` — Claude's append-only work log for this app (latest entry first in importance)
2. `IMPLEMENTATION_LOG.md` — the existing stage log (Stages 00–15) written before Claude's log
3. `README.md` — note that it may still describe the older simulation-only app
4. `assets/ml/v2_validation/inference_contract_v2.json` — the authoritative inference contract
5. `pipeline/` — the on-device implementation of the contract

For anything scientific or contract-related, the authoritative sources are in
`../PRISM smart inhaler`, in this order:
1. `results/v2_validation/inference_contract_v2.json`
2. `ARCHITECTURE.md` (§6 DSP parity, §8.6 inference flow, §9.4 display rules, §13 output schema)
3. `PRISM_RESEARCH_LOG.md`
4. `src/prism_inference.py`, the reference implementation

Read them; do not modify that repository from this one.

`plan.md`, `ML.md` and `ARCHITECTURE.md` are git-ignored here and may not
exist. Do not rely on them.

## 2. Do not break what already exists

- **Default to read-only.** For questions, audits and status reports, read and report; do not edit code.
- **Never rewrite or delete existing files or history** unless the user explicitly asks. This includes `IMPLEMENTATION_LOG.md`, `README.md`, tests, assets and git history.
- **Make the smallest change that solves the stated problem.** Keep existing exports, function signatures and file locations unless the change requires otherwise and says so.
- **Never modify `assets/ml/`** except to copy an updated artefact verbatim from `../PRISM smart inhaler/results/`. The model, baseline, contract, schemas and golden vectors must stay byte-identical to the research outputs; line endings are the only accepted difference.
- **Never commit `firebase/config.js`** or any credentials.
- **Commit only when the user asks.** Work on the current branch (`ml-integration`) unless told otherwise; never force-push or rewrite history.
- **Ask first before any destructive or external action**, such as deleting Firestore data or publishing.

## 3. Priorities

**Functionality first, UI later.** Make the pipeline, data flow and persistence
correct and contract-conformant before any visual or UX work. Do not restyle
screens while functional defects remain open in `claude_implementation.md`.

## 4. Contract and science rules (from the PRISM research repo)

- **The output is `SCORE_ONLY`.** `anomaly_score` is a distance from a global reference baseline. It has no threshold, and there is no NORMAL/ANOMALY label.
- **Forbidden outputs.** Never produce or display:
  - NORMAL/ANOMALY;
  - quality percentages;
  - GOOD/POOR or Correct/Incorrect labels;
  - technique error codes (e.g. "too short", "late actuation", "missed dose");
  - clinical or alert states.

  The dataset has no technique ground truth.
- **What users may see** (research `ARCHITECTURE.md` §9.4):
  - recording status;
  - event times and durations;
  - not-scoreable reasons, phrased as measurement conditions.

  `anomaly_score`, z-scores and `mean_rms` are internal/diagnostic while the contract is `DRAFT_NOT_FROZEN`.
- **`NO_INHALATION_DETECTED` is a recording state,** never an anomalous inhalation.
- **Drug/Exhale analytics are not part of the contract** and are not validated. This covers actuation, coordination and pre-exhale analytics.
- **Device audio:** use `input_domain = "prism_hardware"`, which means `baseline_domain_validated = false`. The baseline is fitted on the reference dataset and is not validated for PRISM hardware.
- **Never fabricate results.** No mocked detector outputs presented as real, and no invented thresholds. Simulation output must be clearly marked as simulation.

## 5. Verification

- `npm test` runs `node pipeline/test_harness.js`. It tests stages in isolation with hand-built inputs; it does **not** exercise `InferencePipeline.run()` end to end. Do not treat a pass as proof of end-to-end correctness.
- **Run tests before and after a change, and report failures with their output.**
- **The conformance target is the research contract.** The 9 golden cases (`assets/ml/v2_validation/golden/`) must pass with the contract tolerances:
  - recording status, event count, statuses, reasons and times: exact;
  - `detector_confidence`: ±1e-4;
  - `feature_values` and `mean_rms`: ±1e-4 relative;
  - `feature_z_scores` and `anomaly_score`: ±0.01.

  End-to-end parity against the 361 reference recordings is the stronger check (see the latest entry in `claude_implementation.md` for how it was run).
- **Some tests depend on files that are not in the repository** (e.g. `pipeline/parity_data.json`). Say so; never fabricate the missing data.

## 6. Logging work: `claude_implementation.md` (append-only)

Every substantial piece of Claude work in this repository (audit, fix, feature,
test change) is recorded in `claude_implementation.md`.

- **Append only.** Never edit, reorder or delete existing entries. If later evidence contradicts an entry, append a new entry that says so and leave the old one intact.
- **Separate from `IMPLEMENTATION_LOG.md`,** which is the pre-existing stage log. Do not write Claude entries there and do not modify it.
- **One entry per session or task**, using this template:

```
# Entry N — YYYY-MM-DD: <title>

## Objective
## What was inspected / changed
## Results (with exact commands and numbers; only what was actually run)
## Files changed
## Tests (command and outcome)
## Open issues / next step
```

- **Separate evidence from inference:** distinguish verified (run), observed (read in code), and not verified.

At the end of substantial work, leave the repository so that another Claude
session can continue from `claude_implementation.md` alone.
