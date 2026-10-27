# Specification Deviations

## D-1 2026-10-27 specs/tui-architecture.md
Spec edit: R4.2-R4.5 and R15.2-R15.6 added — the TUI client must write
  lifecycle records to the shared opencode.log (client lifecycle logging);
  R4 and R15 became group captions with the former leaf text at R4.1/R15.1.
Was: the TUI client writes no record to any file log on any host; the only
  observable trace of an attach client is server-side SSE stream
  connected/disconnected lines, so a client incident cannot be dated.
Now: every event-stream subscription attempt, normal termination, and error;
  every unhandled event-handler exception; every fatal bootstrap failure; and
  every exit with its cause, reason when set, and process exit code
  (including the SIGHUP path) are recorded at LIFECYCLE_LOG_INFO /
  LIFECYCLE_LOG_ERROR; a handler exception never terminates the subscription.
Code impact: packages/tui/src/context/sdk.tsx (subscription lifecycle
  records; per-handler isolation in the flush/emit cycle so an exception is
  logged and the loop continues); packages/tui/src/app.tsx (exit, SIGHUP, and
  fatal-bootstrap records; the lifecycle log channel to opencode.log via the
  accepted Global narrow import); new-CLI entry point (packages/cli default
  command) must open the same opencode.log channel — no Effect file logger
  is installed in that process today; log-level constants
  LIFECYCLE_LOG_INFO / LIFECYCLE_LOG_ERROR.
Tests: tui-architecture T1.4, T1.5, T2.1, T2.2 prescribe the assertions
  (app-lifecycle cases with a captured lifecycle log; SDKProvider mounted
  without injected events to drive the real SSE loop).
Review focus: exactly one exit record per exit path; handler-exception
  isolation covers the direct flush, the timer flush, and the post-stream
  drain flush; the new-CLI process actually appends to opencode.log; log
  writes never block or crash the UI thread; SIGHUP records survive the
  path that bypasses exit().
