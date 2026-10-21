# Phase 3c reviews (Fable, 2026-10-21): Telegram transport

## Round 1: CHANGES_REQUESTED
- **Blocking:** no live round-trip yet. The code itself had no defects.
- **Non-blocking (fixed in gateway 3e36873):**
  - drain in-flight updates on shutdown;
  - send a failure notice to allowlisted senders;
  - answer 200 to an oversized body once the secret has passed;
  - retry registration with backoff;
  - strict env shapes for the token and secret;
  - private chats ignore `message_thread_id`;
  - a test that the catch-all content-type parser does not widen sibling routes;
  - an empty-reply guard;
  - the unauthorized WARN logs only `hasHeader`.
- Infra: the journal dump filters by secret shape only.

## Round 2: CHANGES_REQUESTED
- **Blocking:** evidence that a reply actually reached M at the deployed build.
- **Changes between rounds:**
  - `TELEGRAM_ALLOWED_USERS` env allowlist (e7939e8);
  - a Telegram transport using `node:https` with no keep-alive, a reply retry, and no resend notice after handling (4e0c55c, 5491b52).
- **Non-blocking (fixed in d779735):**
  - an `EBADSTATUS` guard;
  - post-create resilience;
  - a 15-min webhook self-check;
  - env test assertions.
- Also done: the Telegram user id is redacted in committed transcripts, and A17 records the thread-key and reply-delivery decisions.

## Round 3: APPROVED
Evidence:
- the 5491b52 and d779735 deploy transcripts;
- three delivered replies with M's confirmation;
- forged requests get 401/401/401/404;
- `/ticket` → CYR-9 → PR #4 → In Review (via Linear's GitHub integration);
- a non-allowlisted sender is dropped silently;
- secret-shape grep returns 0.

Non-blocking items and carry-forward are recorded in PLAN §13 ("3c result").
