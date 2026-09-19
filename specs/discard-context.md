# Discard Context Specification

Status: stable
Spec source of truth for: the `discard_context` config flag and model-facing tool in both the V2 and V1 runtimes, the runner history filtering it drives in each runtime, and the discard markers rendered by session-ui, the TUI, and exported transcripts.

## Overview

The model can mark parts of its own earlier assistant turns as no longer needed by calling the `discard_context` tool. Each call persists as an ordinary tool part in session history; from the next provider turn on, marked parts, the discard calls themselves, and assistant messages emptied by removal are excluded from the provider request while remaining in durable history. Filtering runs after runner history selection, before history lowering, and before both compaction paths, so marked content is never baked into a summary or a conversation checkpoint. Marker surfaces (the session-ui divider, the TUI inline marker, and the transcript export line) render one line per call with an exact session-wide token suffix; the marked ids themselves are never rendered. The mechanism is bounded against tui-session-display/meta-part: a meta part is a display-only part type excluded from provider context and transcripts by construction, while a core-discard-context/discard-call is a regular tool part excluded from provider context by filtering and kept in transcripts as a marker line.

The same mechanism runs in the V1 (legacy) runtime. The flag is a root key of the V1 config surface and its value is carried into the V2 surface by config migration; the tool is a V1 wrapper whose call persists as an ordinary V1 tool part that existing tool-part surfaces render unchanged; the fixed instruction joins the per-turn system parts that the provider request flattens into one combined system message; and a mirrored filter runs once per loop iteration over the reloaded history before any consumer reads it. The V1 filter matches tool parts by core-discard-context/provider-call-id as well as by part id, because the model sees only provider tool-call ids in a V1 context.

## Scope

In: the `discard_context` config flag; the `discard_context` tool contract, registration gate, and system instruction; runner history filtering semantics (marked-id union, part removal, discard-call removal, empty-message drop, ordering, application point before lowering and both compactions); the V1 runtime surface of the same mechanism (V1 config key read and its migration carry into the V2 surface, tool wrapper and per-turn registry gate, per-turn instruction and loop-iteration filtering, provider-call-id matching, decoded-input id collection); marker rendering in session-ui and the TUI; the transcript marker; exact token attribution.

Out (non-goals): deletion or mutation of session history; the meta-part mechanism (tui-session-display); user-initiated discards; compaction itself (core-session); undoing or expiring markings; TUI attribution changes for V1 provider-call-id markings (the token suffix may be absent or under-report; see Usage constraints).

## Definitions

- `core-discard-context/discard-call` — an assistant tool part whose tool name is `discard_context`; the durable record of one marking invocation, carrying the marked part ids in its input.
- `core-discard-context/marked-ids` — the deduplicated union of string ids collected from the inputs of every core-discard-context/discard-call in the session history.
- `core-discard-context/marked-part` — an assistant content part whose id is a member of core-discard-context/marked-ids; in the V1 runtime a tool part is also a marked-part when its core-discard-context/provider-call-id is a member.
- `core-discard-context/provider-call-id` — the tool-call id under which a tool part appears in the provider context; in the V1 runtime it differs from the tool part's own id.
- `core-discard-context/fully-discarded-message` — an assistant message whose every eligible content part (text, reasoning, or tool other than a core-discard-context/discard-call) is a core-discard-context/marked-part; the unit of exact token attribution.
- `core-discard-context/discarded-token-total` — the session-wide sum of output and reasoning tokens over core-discard-context/fully-discarded-messages; identical for every marker surface of the session.

## Interface

- Config key `discard_context` (boolean; a root key of both the V2 and V1 config surfaces, read in the V1 runtime through the V1 config service, with the V1 document value carried into the V2 surface by config migration): name and type here; allowed values, default, and effect in Configuration.
- Tool `discard_context`:
  - input: `{ ids: string[] }` — ids of assistant message parts (text, reasoning, or tool call parts) to hide from the model's own later context; every element must be a string.
  - output: `{ ids: string[] }` — equals the input ids.
  - model-facing output: one text line stating the marked count.
  - execution performs no permission assertion (V2: the internal built-in-only exception of v2-tools; V1: no permission ask is issued).
- System instruction: a fixed instruction appended after the agent system prompt and the context-epoch baseline on provider turns where the flag is enabled; in the V1 runtime the same fixed text is appended to the per-turn system parts, which the provider request joins into one combined system message. It explains the tool, the origin of part ids, that unknown ids are ignored, and that the discard calls themselves are hidden.
- Marker surfaces:
  - session-ui: one divider line per discard-call, localized through the i18n keys `ui.messagePart.context.discarded`, `ui.messagePart.context.discardedTokens`, and `ui.tool.discardContext`.
  - TUI: one inline marker line per discard-call with fixed English labels (pending label, failure label, and the discarded-count label).
  - transcript export: one marker line per discard-call, optionally with the token suffix.

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `discard_context` | boolean | `false` (key optional; absence disables; a root key of both the V2 and V1 config surfaces, with the V1 document value carried into the V2 surface by config migration) | Gates tool registration at Location layer construction (R2.1, R2.2) and the per-turn instruction (R2.4) and filtering (R2.5) in the V2 runtime, and the per-turn tool set, instruction, and filtering in the V1 runtime (R2.7–R2.9); on turns that resolve the flag as disabled no filtering is applied and marked parts and discard-calls return to provider context (R2.5, R2.10) |
| `tokens-k-threshold` | `magic` 1000 tokens (nameless literal in the code) | — | Lower compact-format bound: totals below it render as a plain count in the token suffix (R7.5) |
| `tokens-m-threshold` | `magic` 1000000 tokens (nameless literal in the code) | — | Upper compact-format bound: totals below it and at or above `tokens-k-threshold` render with a `k` suffix, totals at or above it with an `M` suffix (R7.5) |

## Requirements

- R1. Tool contract:
- R1.1. The structured output of a settled `discard_context` call equals its input `ids` array.
- R1.2. The model-facing output of a settled call is a single text line stating the count of marked parts.
- R1.3. Tool execution performs no permission assertion.
- R1.4. Tool execution performs no effect other than the durable persistence of the tool part that records the call.
- R1.5. Input that does not match the input schema is rejected before execution as a model-visible settlement error.
- R1.6. Ids that name no existing part are accepted and echoed like any other ids.
- R2. Gating:
- R2.1. The tool is registered into a Location's tool registry at Location layer construction only when the `discard_context` flag is enabled there.
- R2.2. Tool visibility changes only when the Location layer is rebuilt: a rebuild with the flag disabled removes the tool from materialized model-facing definitions, and a rebuild with the flag enabled adds it.
- R2.3. The flag value is re-resolved from the Location's config-v2/entry-list on every provider turn.
- R2.4. The system instruction is included in the system parts of a provider request only on turns where the flag is enabled.
- R2.5. On a provider turn where the flag is disabled, no discard filtering is applied, and marked parts and discard-calls appear in the provider-visible context.
- R2.6. A registration made while the flag was enabled persists until the next Location layer rebuild, even on later turns that resolve the flag as disabled.
- R2.7. In the V1 runtime the tool is offered to the model on a provider turn only when the flag is enabled for that turn.
- R2.8. In the V1 runtime the flag is re-resolved from the V1 configuration on every provider turn, so the tool set, the system instruction, and filtering follow the current value together.
- R2.9. In the V1 runtime the system instruction is appended to the per-turn system parts and reaches the provider request inside the combined system message.
- R2.10. On a V1 provider turn where the flag is disabled, the tool and the system instruction are absent from the request and no discard filtering is applied, so marked parts and discard-calls appear in the provider-visible context.
- R3. Marked-id collection:
- R3.1. core-discard-context/marked-ids is the deduplicated union of the id arrays carried by every core-discard-context/discard-call in the loaded history, independent of call order.
- R3.2. Only string elements of an ids array contribute to the union.
- R3.3. A discard-call whose input is not a record carrying an ids array contributes nothing to the union.
- R3.4. A pending discard-call's raw JSON input string is parsed to collect its ids, and input that fails to parse contributes nothing.
- R3.5. In the V1 runtime a discard-call's ids are read from its decoded input record for every call status, and the raw JSON parsing of R3.4 never applies.
- R4. History filtering:
- R4.1. When the loaded history contains no discard-call, filtering returns the entries unchanged.
- R4.2. Filtering removes every core-discard-context/marked-part from assistant messages.
- R4.3. Filtering removes every core-discard-context/discard-call part from assistant messages, so a marked tool call and its result disappear together.
- R4.4. An assistant message whose content becomes empty after filtering is dropped entirely.
- R4.5. Filtering preserves entry order and leaves non-assistant messages unchanged.
- R4.6. Marked ids that name no part of the loaded history are ignored by filtering.
- R4.7. In the V1 runtime a marked-id matches a tool part when it equals the part's id or the part's core-discard-context/provider-call-id.
- R5. Application point:
- R5.1. Filtering is applied after runner history selection and before the selected history is lowered into provider messages.
- R5.2. Pressure compaction and overflow compaction both consume the filtered entries, so marked content never enters a summary or a conversation checkpoint.
- R5.3. Every provider turn reloads history from the database before filtering, so discard filtering survives session resume and process restart.
- R5.4. Filtering alters only the provider request projection: durable history and session reads keep marked parts and discard-calls.
- R5.5. In the V1 runtime filtering is applied once per loop iteration to the reloaded history, after entries covered by an earlier compaction are removed and before the history is lowered for the provider request.
- R5.6. In the V1 runtime the provider request, both compaction paths, subtask replay, and reminders consume the same filtered history.
- R6. Marker surfaces:
- R6.1. Each marker surface renders one single-line marker per core-discard-context/discard-call and never renders the marked ids.
- R6.2. The marker count is the number of ids in the discard-call's input; a missing or malformed ids array renders as a count of zero.
- R6.3. The TUI marker remains visible while tool details are hidden.
- R6.4. A marker appends the token suffix only when the session's core-discard-context/discarded-token-total is positive.
- R6.5. An exported transcript keeps exactly one marker line per discard-call and never contains the marked ids.
- R7. Token attribution:
- R7.1. The core-discard-context/discarded-token-total sums the output and reasoning tokens of every core-discard-context/fully-discarded-message in the session.
- R7.2. An assistant message that is not a core-discard-context/fully-discarded-message contributes no tokens to the total.
- R7.3. Input and cache tokens are never counted in the total.
- R7.4. Every marker surface of one session shows the same total.
- R7.5. The suffix renders the total as a plain count below `tokens-k-threshold`, with a `k` suffix below `tokens-m-threshold`, and with an `M` suffix otherwise.
- R7.6. A compact suffix carries one decimal place, and a trailing zero decimal is trimmed.

## Examples

- A1.6. A call with ids naming one existing text part and one nonexistent id settles successfully and echoes both ids.
- A2.5. The flag is enabled at Location build, a marking call settles, and the flag is then disabled without a rebuild: the next provider turn's request again contains the marked parts and the discard-call, and the system instruction is absent.
- A2.7. In the V1 runtime turning the flag off between turns removes the tool from the very next provider turn's tool set, with no rebuild step.
- A3.1. One discard-call marks `text-plan`, a later one marks `text-plan` and `call-read`; the union is `text-plan` plus `call-read` regardless of call order.
- A3.4. A pending call whose raw input is the JSON string `{"ids": ["text-plan"]}` contributes `text-plan`; raw input `not-json` contributes nothing.
- A3.5. In the V1 runtime a discard-call's ids come from its decoded input record whatever the call status; a call not yet launched has empty input and contributes nothing.
- A4.3. An assistant message whose `read` tool call is marked loses the call part and its locally-settled result, which lowering would otherwise emit as a separate result message after the assistant turn.
- A4.4. An assistant message whose only content part is marked disappears from the lowered context; the surrounding user messages remain, so message roles keep alternating.
- A4.7. In the V1 runtime a marked id equal to a tool part's core-discard-context/provider-call-id removes that tool part and its result even though the id differs from the part's own id.
- A5.6. On a V1 turn after a marking call, the next provider request, an auto-compaction summary, and a subtask replay all see the same history without the marked parts.
- A7.1. A fully marked assistant message with output tokens and reasoning tokens contributes their sum, and every marker of the session shows that same session total.
- A7.2. A message with a text part and a reasoning part where only the text part is marked contributes nothing, and its tokens appear in no suffix.
- A7.5. Session totals render as `950`, `4.2k`, and `1.3M` across the compact-format bounds.

## Tests

- T1. Tool registration and contract (packages/core/test/tool-discard-context.test.ts):
- T1.1. flag-off build registers no tool definitions (R2.1, R2.2).
- T1.2. flag-on build registers the tool, echoes the ids, and settles without a permission layer (R1.1, R1.2, R1.3).
- T1.3. invalid input is rejected as a settlement error (R1.5).
- T2. Filtering units (packages/core/test/session-runner-discard-context.test.ts, filterEntries describe):
- T2.1. removes marked parts, hides discard calls, preserves order (R4.2, R4.3, R4.5).
- T2.2. drops assistant messages emptied by filtering (R4.4).
- T2.3. removes a marked tool call together with its result pair (R4.3).
- T2.4. ignores unknown ids and keeps messages without addressable parts (R4.5, R4.6).
- T2.5. returns entries unchanged without discard calls (R4.1).
- T2.6. reads ids from pending tool input JSON and ignores broken input (R3.4).
- T3. Runner integration (packages/core/test/session-runner-discard-context.test.ts, SessionRunner describe):
- T3.1. appends the instruction to system parts when the flag is enabled (R2.4).
- T3.2. keeps the instruction out of system parts when the flag is disabled (R2.4).
- T3.3. hides marked parts and discard calls from later provider turns, survives resume, and session reads keep them (R4.2, R4.3, R5.3, R5.4).
- T3.4. compacts from filtered entries so marked parts reach neither summary nor checkpoint while database rows keep the marked content (R5.2, R5.4).
- T3.5. filters parts loaded fresh from the database across a restart (R5.3).
- T4. Token attribution (packages/session-ui/src/components/discard-context-summary.test.ts and the mirrored packages/tui/test/util/discard-context.test.ts):
- T4.1. sums output and reasoning tokens of fully discarded assistant messages (R7.1).
- T4.2. partially discarded messages contribute nothing (R7.2).
- T4.3. markers do not close on themselves: a message fully marked plus its own marker counts as fully discarded (R7.1).
- T4.4. merges ids across multiple discard calls (R3.1).
- T4.5. returns a zero total when nothing is discarded (R7.1).
- T4.6. compact format bounds: plain, k, and M forms with decimal trimming (R7.5, R7.6).
- T5. Transcript marker (packages/tui/test/util/transcript.test.ts):
- T5.1. formats a single marker line without ids (R6.1, R6.5).
- T5.2. singular marker text for a single id (R6.1, R6.2).
- T5.3. missing ids render a zero count (R6.2).
- T5.4. appends the compact token suffix when a positive total is provided (R6.4).
- T5.5. omits the suffix when the total is zero or absent (R6.4).
- T6. V1 runtime, tests run from packages/opencode (packages/opencode/test/tool/registry.test.ts, packages/opencode/test/session/discard-context.test.ts, packages/opencode/test/session/prompt.test.ts):
- T6.1. registry gate: the materialized tool set includes the tool with the flag on and omits it with the flag off (R2.7, R2.8).
- T6.2. filter unit: tool parts matched by part id or core-discard-context/provider-call-id, discard-calls removed, emptied assistant messages dropped, order preserved (R4.2, R4.3, R4.4, R4.5, R4.7).
- T6.3. flag-on integration: after a marking call the next provider request omits the tool together with the marked parts while the database keeps them (R2.7, R4.2, R4.3, R5.4).
- T6.4. flag-off integration: with the flag disabled marked parts and discard-calls return to the provider request (R2.10).
- T6.5. compaction integration: compaction builds from filtered entries so marked content stays out of the summary (R5.5, R5.6).

## Usage constraints

- In the V1 runtime the processor's doom-loop guard is not exempted from this tool: repeated identical discard calls can raise a permission confirmation.
- In V1 sessions parts marked by core-discard-context/provider-call-id are excluded from provider context, but the TUI token suffix matches marked ids against part ids only, so the suffix may be absent or under-report; it never over-reports, and no TUI change is planned.
- The V1 filter is a deliberate mirror copy of the core filter, kept as a copy because the core module's types bind to the V2 message shapes; any change must keep it semantically identical to the core filter.
- The pure attribution logic exists as two deliberate copies (session-ui and the TUI package, which cannot depend on the web-only package); any change must keep them identical.
- The i18n keys must exist in every supported locale (enforced by the locale parity test); translations may lag, leaving English copies in place.
- The compact suffix always uses a dot as the decimal separator, and the token-count phrasing is not pluralization-aware in every locale.
- The session-ui divider render has no direct unit test (a bundling constraint of the web package); its logic is covered through the attribution module tests.

## Justification

- J1. Why input and cache tokens are excluded from the total (R7.3): providers report them for the whole request rather than per excluded content, so attributing them to discarded parts would be invented.
- J2. Why partially discarded messages contribute nothing (R7.2): token counts exist per assistant message only, and estimating a share would misreport savings, so the total stays exact or empty — a deliberate exactness-over-coverage decision.
- J3. Why filtering runs before both compactions (R5.2): a summary or checkpoint built from unfiltered entries would preserve marked content beyond the marking and re-enter it on every later turn.
- J4. Why emptied assistant messages are dropped (R4.4): providers require alternating user and assistant turns, so an emptied assistant message would make the lowered request invalid.
- J5. Why the token suffix is session-wide rather than per-marker (R7.4): attribution is exact per message and not per call, so a per-marker split would be arbitrary; one session total keeps every surface consistent.
- J6. Why registration is gated at Location build while the instruction and filtering are re-resolved per turn (R2.1, R2.3): tool definitions materialize per registration cycle, while per-turn re-resolution lets a reopened Location's config steer the very next provider turn without rebuilding the runner.
- J7. Why the V1 filter matches tool parts by core-discard-context/provider-call-id as well as by part id (R4.7): the model sees only provider tool-call ids in a V1 context, and a V1 tool part's own id differs from its provider call id, so id-only matching would leave marked tool calls visible to the model.
- J8. Why the V1 filter is a mirrored copy rather than an import of the core filter (R4.7, R5.5): the core filter's types bind to the V2 message shapes, so reuse would erase the V1 types; a semantic mirror keeps each runtime's types intact at the cost of a copy that must stay identical to its original, like the existing attribution copies.

## Error handling

- Invalid tool input settles as an explicit model-visible error before execution; the executor is never invoked (R1.5).
- A discard-call input that is missing, malformed, or unparseable JSON contributes no ids and never fails the provider turn (R3.3, R3.4).
- A marker whose input carries no valid ids array renders a zero count instead of failing (R6.2).
- Marker rendering degradation never changes the provider turn's outcome.

## Dependencies

- core-session — provider-turn structure, runner history selection, and both compaction paths that bracket the filtering step defined here.
- config-v2 — the `discard_context` root key and the config-v2/entry-list resolution behind the per-turn flag read (R2.3).
- config-v1 — the `discard_context` root key in the V1 config surface, the V1 config read behind the per-turn flag resolution (R2.8), and the migration carry of the V1 document value into the V2 surface.
- core-tools-permissions — the V1 tool contract, registry, and permission flow hosting the V1 `discard_context` wrapper and its config gate in the materialized tool set (R2.7).
- v2-tools — the local tool type, registration semantics, and the built-in permission pattern whose internal built-in-only exception this tool takes (R1.3).
- tui-session-display — the exclusion-mechanism boundary against tui-session-display/meta-part stated in Overview and Definitions.

## Used by

None yet.

## Verification

None. No formal verification (TLC/TLAPS) exists for this component; the requirements are covered by the recorded tests above.
