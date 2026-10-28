# Session LLM Serialization

Status: draft
Reference: session-llm-serialization
Spec source of truth for: the provider-facing serialization of unsettled tool calls in session history — the fixed pending-result-placeholder that both runtimes substitute for a tool call whose recorded settlement state is pending or running at provider-request assembly time, so every serialized tool call carries exactly one successful tool result that asserts no outcome.

## Overview

Both runtimes assemble provider requests from projected session history. The tool-use provider families in use require every serialized tool call to carry a tool result; a request with a dangling tool call is rejected or misread. History can still contain a tool call whose recorded settlement state is pending or running when a request is assembled — for example a runtime re-entry that reloads history while a call of the same session is still executing. This spec fixes what the provider sees for such a call: one successful tool result carrying the pending-result-placeholder, a fixed text stating that the call is still executing and that the text is not the call's outcome.

The placeholder changes no durable settlement. The drain-start durable failing of abandoned tools fixed by core-session and the V1 interruption finalization keep their behavior; this spec governs only the provider-facing serialization of calls whose recorded state is unsettled at request-assembly time.

## Scope

In:

- The serialization of a tool call whose recorded settlement state is pending or running at provider-request assembly time, in the V1 history replay and in the V2 history lowering.
- The pending-result-placeholder: its fixed literal, its placement as a successful tool result, and the prohibitions its wording satisfies.
- The guarantee that every serialized tool call of a provider request carries exactly one tool result.

Out (non-goals):

- Durable tool settlement and its state machine, the drain-start failing of abandoned tools, and interruption finalization (core-session).
- The completed and error replay clauses of the V1 history replay (core-tools-permissions keeps them beside this spec's rule).
- Provider transport, request assembly beyond tool results, and compaction serialization.
- The task tool's asynchronous launch and completion delivery (tool-task).

## Definitions

- **session-llm-serialization/unsettled-tool-call**: a projected tool part whose recorded settlement state is pending or running at the time a provider request is assembled.
- **session-llm-serialization/pending-result-placeholder**: the fixed tool-result text of PENDING_TOOL_RESULT_PLACEHOLDER in Configuration, the sole provider-facing result of an unsettled tool call.

## Interface

The serialized form of an unsettled tool call in a provider request:

| Field | Value |
|---|---|
| tool call id | the call id of the unsettled tool part |
| result kind | successful tool result |
| result text | exactly PENDING_TOOL_RESULT_PLACEHOLDER |

No error result, no error text, and no provider-native error marker represents an unsettled tool call. The placeholder is a serialization-time projection only: it settles nothing and writes nothing durable.

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| PENDING_TOOL_RESULT_PLACEHOLDER | `fixed` the literal `[Tool execution is still in progress; this message is a placeholder, not the call's outcome. Do not treat it as a failure, an interruption, or a completion, and do not retry or duplicate the call.]` | — | The provider-facing result text of an unsettled tool call (R2.1) |

## Requirements

- R1. Result presence:
- R1.1. verification=automated; A provider request assembled from session history by either runtime carries exactly one tool result for every serialized tool call, an unsettled tool call included.
- R2. Placeholder contract:
- R2.1. verification=automated; An unsettled tool call serializes to a successful tool result whose text is exactly PENDING_TOOL_RESULT_PLACEHOLDER.
- R2.2. verification=automated; PENDING_TOOL_RESULT_PLACEHOLDER states that the call is still executing, that the message is a placeholder and not the call's outcome, and that the call must not be retried or duplicated, and it asserts neither failure, interruption, nor completion of the call.
- R2.3. verification=automated; A settled tool call never serializes to PENDING_TOOL_RESULT_PLACEHOLDER: a completed call serializes to its recorded output and an errored call to its recorded error text.
- R3. Runtime application:
- R3.1. verification=automated; The V1 history replay serializes an unsettled tool part as the successful placeholder result of R2.1, in place of an error output.
- R3.2. verification=automated; The V2 history lowering serializes an unsettled tool part as the successful placeholder result of R2.1, in place of an omitted result.

## Implementation

- I1. The V1 replay site is the pending and running branch of the history replay (`packages/opencode/src/session/message-v2.ts`): it emits the successful placeholder result in place of the interrupted error output; the completed and error branches are unchanged.
- I2. The V2 lowering site is the tool-result constructor of the history lowering (`packages/core/src/session/runner/to-llm-message.ts`): pending and running states emit the placeholder result in place of no result, for locally settled and provider-executed calls alike.
- I3. Placeholder substitution performs no durable write and never settles the tool part; the recorded state keeps its pending or running value.

## Examples

- E1. Result presence:
- E1.1. A re-entered V1 loop reloading history while a tool call of the same session is executing serializes that call with the placeholder result of R2.1, and the assembled request carries a result for every tool call.
- E2. Placeholder contract:
- E2.3. A completed tool part serializes to its recorded output and an error part to its recorded error text; neither ever carries PENDING_TOOL_RESULT_PLACEHOLDER.
- E3. Runtime application:
- E3.2. The V2 lowering of an assistant tool part still recorded running emits the call followed by the placeholder result, leaving no dangling tool call in the request.

## Tests

- T1. Result presence:
- T1.1. R-ID=R1.1, R3.1; procedure=V1 replay test assembling a provider request over history containing one running tool part; conditions=one tool part recorded running; expected=the assembled request carries exactly one result for every tool call, the running call's result being the placeholder text as a successful result.
- T2. Placeholder contract:
- T2.1. R-ID=R2.1, R2.2; procedure=placeholder literal check in both runtimes' lowering output; conditions=history containing one pending and one running tool part; expected=each unsettled call's result text equals PENDING_TOOL_RESULT_PLACEHOLDER exactly, as a successful result, and the literal's wording makes no failure, interruption, or completion claim.
- T2.3. R-ID=R2.3; procedure=settled replay test in both runtimes; conditions=history with completed and error tool parts; expected=a completed call lowers to its recorded output, an errored call to its recorded error text, and no settled call carries the placeholder.
- T3. Runtime application:
- T3.2. R-ID=R3.2, R1.1; procedure=V2 lowering test over projected history with one pending locally settled tool part; conditions=one tool part recorded pending; expected=the lowered message list emits the call followed by the placeholder result with no dangling tool call.

## Justification

- J1. Why a successful result instead of an error result (R2.1): an error-typed result invites the provider to treat the call as failed and re-issue it, duplicating live side effects and burying a running subagent; a successful result with explicit still-executing text keeps the call's outcome open.
- J2. Why one fixed literal for both runtimes (R2.2, see Configuration): a single literal is testable byte for byte in both lowering paths and cannot drift into wording that asserts an outcome the recorded state does not support.
- J3. Why serialization-only substitution (I3): the recorded state is the truth available at lowering time; the placeholder must not mutate durable history or race the real settlement, which keeps the rule compatible with the drain-start failing of abandoned tools owned by core-session.

## Dependencies

- core-session — the V2 history lowering path and the V1 history replay boundary whose unsettled-call serialization this spec fixes; the drain-start failing of abandoned tools and the durable settlement states stay there.

## Used by

- core-tools-permissions — the unsettled-call clause of its history-replay contract (R24) is delegated to this spec.
