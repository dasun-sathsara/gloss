# Working on Gloss

Keep changes focused and follow the scoped guidance under `frontend/`. Verify user-facing changes through the normal entry point with `GLOSS_CONFIG_DIR` pointing to a temporary library. Use synthetic cards and audio for performance measurements and manual smoke checks. Keep credentials and personal libraries out of that work.

Use disposable fixtures and manual verification. Add a checked-in test suite only when a maintainer explicitly requests one. Keep the existing lint, type, build, and package gates.

## Review rubric

Rate each applicable area from 0 to 2 before handing off. A 2 means the work meets the bar below and has evidence. A 1 means evidence is partial or there is a bounded concern. A 0 means a known failure or a missing essential check. Mark an area N/A when the change cannot affect it.

| Area | What earns a 2 |
| --- | --- |
| Correctness | The normal entry point works, including existing inputs, and relevant failure or retry behavior was exercised. |
| Data safety | Saved cards, audio, and destinations are preserved. Any migration or interrupted write was checked against representative disposable data. |
| Measured performance | A reproducible before/after comparison names the operation, data size, environment, sample count, and any tradeoff. |
| Simplicity | The diff reuses existing paths and each new dependency or abstraction has a concrete job. |
| Design and accessibility | Relevant desktop and mobile views, keyboard focus, and reduced motion were checked in the running UI. |
| Evidence | The handoff gives exact commands or steps, results, and any limits on what was verified. |

A known data-loss or wrong-destination path, a broken normal workflow, or a failed build, lint, or type check blocks a ready-for-review handoff. Fix and rerun the affected check. If access or tooling still blocks a check, identify the exact blocker, finish independent verification, and report the affected result as unverified. A performance claim requires a measured comparison.
