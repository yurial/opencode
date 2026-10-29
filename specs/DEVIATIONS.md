# Specification Deviations

## D1. `wait` argument still blocks the launch in code

- Date: `2026-10-29`
- Spec: tool-task (R1.1, R1.9; Interface "Tool arguments"; R3.1; T1.1, T3.1)
- Spec edit: the blocking `wait` argument is removed from the task tool launch — every launch is asynchronous (R1.1), no argument requests blocking settlement and the completion message is the only channel of a settled outcome (R1.9), and the description contract drops the blocking guidance (R3.1).
- Was: `packages/opencode/src/tool/task.ts` advertises the optional boolean `wait` and routes a `true` value into a blocking settlement branch of the launch; the description in `packages/opencode/src/tool/task.txt` tells the model to pass it whenever it needs the result before continuing.
- Now: the advertised schema exposes no blocking argument, the blocking branch is gone, and a settled outcome reaches the parent session only through the completion message.
- Code impact: `packages/opencode/src/tool/task.ts` (drop the `wait` schema entry and the blocking settlement branch), `packages/opencode/src/tool/task.txt` (drop the blocking guidance sentence per R3.1).
- Tests: T1.1 and T3.1 of tool-task; the async-launch regression test pinning the running result before settle (R1.1, R1.2) exists on branch task-async-default (commit `283c1f05a6`) and moves with the code change.
- Review focus: no schema or description remnant of the blocking argument; the settled outcome arrives only through the completion message; the removal breaks no continuation, status, or abort path.
