# Phase 3f relay reviews (Fable, 2026-10-21)

## Round 1: CHANGES_REQUESTED
- **Blocking:** head-of-line blocking. One per-issue Linear error aborted the whole cycle, and Linear's "Entity not found" was not mapped.
- **Non-blocking:**
  - title cap;
  - comment/attachment ordering;
  - pruning finished records;
  - per-message warning budgets;
  - await the relay on shutdown;
  - `[Linear comment]` / `[Linear link]` markers;
  - unseeded records for recently created issues;
  - the shape of Linear's system comment.
- All fixed in gateway 2451d6e. A live probe confirmed Linear returns `INPUT_ERROR` / "invalid input" for an unknown issue id.

## Round 2: APPROVED
Live: CYR-8 was deleted mid-watch (with M's OK). In the same poll cycle it finished as `archived` and CYR-11's update was still posted. M confirmed the new message format, with no system-note line.

Non-blocking items and carry-forward are recorded in PLAN §13 "3f relay result".
