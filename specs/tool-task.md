# Task Tool

Status: draft
Reference: tool-task
Spec source of truth for: the V1 `task` tool launch and completion contract — asynchronous launch by default with an immediate running result, the optional blocking `wait` argument, and completion delivery into the parent session as exactly one synthetic user message through the ordinary prompt admission of the host's single runtime graph.

## Overview

The `task` tool delegates work to a subagent session. This spec fixes the launch modes and the completion-delivery contract: a launch returns immediately with a running result identifying the run and promising a completion message; when the run settles, the parent session receives exactly one synthetic user message carrying the outcome. Blocking settlement remains available through an explicit argument.

Completion delivery presupposes the process topology of the host: the synthetic message must reach the runtime services that own the parent session's prompt admission. The scheduler spec fixes that topology property for fire deliveries — all schedule mutations and fire deliveries of one process serialize through the single delivery loop of the scheduler service (scheduler R8.3) — and this spec introduces no second delivery path.

## Scope

In:

- Launch modes: the asynchronous default with its immediate running result, and the `wait` argument requesting blocking settlement.
- The result grammar of a launch result and of a blocking settlement result.
- The completion message: its grammar, its synthetic admission into the parent session, and exactly-once delivery per settled run.
- The process-topology precondition of completion delivery, citing the single-delivery-loop property of scheduler R8.3.
- The model-facing description contract of the tool.

Out (non-goals):

- Tool registration, the `task` permission ask, subagent-depth enforcement, and the child session permission derivation (core-tools-permissions, config-agents).
- The subagent prompt template and the agent catalog.
- Background job identity, persistence, and liveness; jobs live in process memory only.
- The scheduler tool and its fires (scheduler); the V2 tool execution model (v2-tools).

## Definitions

- **tool-task/subagent-run**: one execution of a subagent session launched through the task tool, identified by its child session id (the run id, reusable as `task_id` to resume the same subagent session).
- **tool-task/blocking-wait**: the `wait` argument value `true`, requesting that a launch return only after its subagent-run settles.
- **tool-task/completion-message**: the synthetic user message a settled subagent-run delivers into the parent session, following the completion grammar of the Interface section.

## Interface

### Tool arguments

| Argument | Allowed values | Meaning |
|---|---|---|
| `wait` | optional boolean, default `false` | `true` requests blocking settlement of the launched run (R1.3); the default launches asynchronously (R1.1) |

The remaining arguments (`description`, `prompt`, `subagent_type`, `task_id`, `command`) and the permission gating stay with the core-tools-permissions tool contract. The former experimental `background` argument is removed: immediate return with a running result and completion by notification are the default behavior.

### Result grammar

```
<task id="<run id>" state="running|completed|error">
[<summary>...</summary>]
<task_result>...</task_result> | <task_error>...</task_error>
</task>
```

- A launch result carries `state="running"`, the run id, and text stating that completion will arrive as a separate session message.
- A blocking-wait result carries the settled state, the run id, and the final output text (`task_result`) or the failure text (`task_error`).
- The completion message body follows the same grammar with the settled state, a summary naming the run, and the final or failure text.

### Description contract

The tool description states that launches run asynchronously by default and return immediately with a running result, that completion arrives as a separate session message, and that a launch needing the result before continuing passes `wait`.

## Requirements

- R1. Launch modes:
- R1.1. verification=automated; A launch without `wait` starts its subagent-run and returns a tool result without waiting for the run's settlement.
- R1.2. verification=automated; An asynchronous launch result carries the run id and the running state and states that completion will arrive as a separate session message.
- R1.3. verification=automated; A launch with `wait` of `true` returns only after its subagent-run settles, carrying the run's final output on completion or the run's failure text on error.
- R1.4. verification=automated; Asynchronous launch is the default path of the tool, and no experimental flag gates it.
- R2. Completion delivery:
- R2.1. verification=automated; When an asynchronously launched subagent-run settles, the parent session receives exactly one synthetic user message following the completion grammar, carrying the run id and the settled state.
- R2.2. verification=automated; The completion message is admitted through the ordinary prompt admission path of the parent session's runtime.
- R2.3. verification=scenario; Completion delivery rides the single runtime service graph of the host process — the process-global serialization property fixed by scheduler R8.3 for fire deliveries — and the task tool defines no second delivery path.
- R2.4. verification=automated; A resumed subagent-run (a launch reusing `task_id`) keeps the same launch and completion contract as a fresh run.
- R3. Model-facing contract:
- R3.1. verification=automated; The tool description documents the asynchronous default, the completion notification, and the `wait` argument.

## Implementation

- I1. The existing background mechanism becomes the main path: the job start, the completion watcher, and the synthetic injection of the completion message (`packages/opencode/src/tool/task.ts`); the blocking branch keeps its acquire-use-release wait as the implementation of `wait`.
- I2. The `background` argument, its experimental flag, and its description gating are removed; the background guidance text merges into the base description per R3.1.
- I3. The completion message renders through the same result grammar as a blocking result, so the model reads one shape on both paths.

## Examples

- E1. Launch modes:
- E1.1. A launch of `description: "fix tests"` with a registered subagent type and no `wait` returns immediately, carrying `state="running"`, the run id, and the notification promise; the parent model continues other work.
- E1.3. The same launch with `wait: true` returns after the run settles, carrying the final output text, or the failure text when the run errors.
- E2. Completion delivery:
- E2.1. The run of E1.1 settling with a summary delivers exactly one synthetic user message with `state="completed"` and the final text into the parent session, and nothing else is delivered for that run.
- E2.4. A launch reusing the `task_id` of E1.1 returns a running result for the same run id and receives a completion message when the resumed run settles.

## Tests

- T1. Launch modes:
- T1.1. R-ID=R1.1, R1.4; procedure=task tool launch test with no flags and no `wait`; conditions=a registered subagent type; expected=the tool result returns before the run settles, carrying the running state, with no experimental flag set.
- T1.2. R-ID=R1.2; procedure=launch result content test; conditions=an asynchronous launch; expected=the result follows the result grammar with the run id and `state="running"` and states that completion will arrive as a separate session message.
- T1.3. R-ID=R1.3; procedure=blocking launch test with `wait: true`; conditions=a run that settles successfully and a run that errors; expected=the result carries the final output text or the failure text, and only after settlement.
- T2. Completion delivery:
- T2.1. R-ID=R2.1, R2.2; procedure=completion delivery test; conditions=an asynchronously launched run settling while the parent session is idle; expected=exactly one synthetic user message following the completion grammar appears in the parent session through the ordinary prompt admission path.
- T2.3. R-ID=R2.3; procedure=host-topology scenario against one host process serving the parent session through a single runtime graph; conditions=an asynchronously launched run settling; expected=the completion message reaches the owning runner and drives the parent's next turn, with no second delivery path involved.
- T2.4. R-ID=R2.4; procedure=resume launch test reusing `task_id` of a prior run; conditions=a launch against an existing subagent session; expected=the launch returns a running result for the same run id and a completion message arrives when the resumed run settles.
- T3. Model-facing contract:
- T3.1. R-ID=R3.1; procedure=description content check at registry build; conditions=the composed tool description; expected=it names the asynchronous default, the completion notification, and the `wait` argument.

## Justification

- J1. Why asynchronous by default (R1.1, R1.4): a blocking default parks the parent model behind each subagent and invites duplicate work whenever history serialization misrepresents a live call as interrupted; an immediate running result with a promised completion message keeps the parent productive and honest about the run's liveness.
- J2. Why completion rides the ordinary prompt admission of the single runtime graph (R2.2, R2.3): a delivery path outside the owning runner reproduces the double-delivery divergence class that the scheduler single-delivery-loop property (scheduler R8.3) exists to prevent.
- J3. Why `wait` instead of the former `background` (Interface): the default inverted, so the opt-in names the exceptional mode — blocking — and the description stops advertising an argument whose former meaning is the default.

## Dependencies

- core-tools-permissions — the task tool is a V1 built-in under its tool contract, registry, and `task` permission ask; this spec changes only launch and completion behavior.
- core-session — the completion message is admitted through the V1 prompt boundary it documents.
- scheduler — the completion-delivery topology precondition cites its single-delivery-loop property (R8.3); no scheduler behavior changes here.
