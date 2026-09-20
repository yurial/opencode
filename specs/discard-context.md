# Discard Context Specification

Status: stable
Spec source of truth for: the `discard_context` config flag and model-facing tool in both the V2 and V1 runtimes, the runner history filtering it drives in each runtime, the part-id markers carried by provider projections, and the discard markers rendered by session-ui, the TUI, and exported transcripts.

## Overview

The model can mark parts of its own earlier assistant turns and parts of earlier user turns as no longer needed by calling the `discard_context` tool. Each call persists as an ordinary tool part in session history; from the next provider turn on, marked parts, the discard calls themselves, and messages emptied by removal are excluded from the provider request while remaining in durable history. So that the marked ids stay addressable, every provider turn that resolves the flag enabled projects the id of each part it carries: text parts open with the core-discard-context/projected-id-marker line, file parts of V2 user messages open with the marker line immediately ahead of the file content, tool parts are identified by their core-discard-context/provider-call-id natively, and reasoning parts carry the marker only when they are projected at all; the markers are a projection-only transformation that nothing durable ever stores. A settled call always answers with a non-empty model-facing line that confirms successful execution and states how many parts it marked; the zero-count wording tells the model not to repeat the call without new ids. Filtering runs after runner history selection, before history lowering, and before both compaction paths, so marked content is never baked into a summary or a conversation checkpoint; the most recent user entry of the session always survives filtering whole, because the runner reads the current turn's steering from the projected history. Marker surfaces (the session-ui divider, the TUI inline marker, and the transcript export line) render one line per call with an exact session-wide token suffix; the marked ids themselves are never rendered. The mechanism is bounded against tui-session-display/meta-part: a meta part is a display-only part type excluded from provider context and transcripts by construction, while a core-discard-context/discard-call is a regular tool part excluded from provider context by filtering and kept in transcripts as a marker line.

The same mechanism runs in the V1 (legacy) runtime. The flag is a root key of the V1 config surface and its value is carried into the V2 surface by config migration; the tool is a V1 wrapper whose call persists as an ordinary V1 tool part that existing tool-part surfaces render unchanged; the fixed instruction joins the per-turn system parts that the provider request flattens into one combined system message; and a mirrored filter runs once per loop iteration over the reloaded history before any consumer reads it. The V1 filter matches tool parts by core-discard-context/provider-call-id as well as by part id, because a V1 tool part reaches the model under its provider call id while its own part id stays internal. The V1 mirror carries the same part-id markers on flag-enabled turns, the same user-part marking and guard, and the same settled-output line.

## Scope

In: the `discard_context` config flag; the `discard_context` tool contract, registration gate, system instruction, and non-empty settled-output line; runner history filtering semantics (marked-id union, part removal for assistant and user messages, discard-call removal, empty-message drop, ordering, most-recent-user-entry guard, lowered-request validity, application point before lowering and both compactions); the flag-gated projection-only part-id markers in the provider request; the V1 runtime surface of the same mechanism (V1 config key read and its migration carry into the V2 surface, tool wrapper and per-turn registry gate, per-turn instruction and loop-iteration filtering, provider-call-id matching, decoded-input id collection); marker rendering in session-ui and the TUI; the transcript marker; exact token attribution.

Out (non-goals): deletion or mutation of session history; the meta-part mechanism (tui-session-display); user-initiated discards; compaction itself (core-session); undoing or expiring markings; TUI attribution changes for V1 provider-call-id markings (the token suffix may be absent or under-report; see Usage constraints).

## Definitions

- `core-discard-context/discard-call` — an assistant tool part whose tool name is `discard_context`; the durable record of one marking invocation, carrying the marked part ids in its input.
- `core-discard-context/marked-ids` — the deduplicated union of string ids collected from the inputs of every core-discard-context/discard-call in the session history.
- `core-discard-context/attachment-id` — the optional id of a file attachment of a V2 user message (`FileAttachment.id`), a string in the part-id format assigned where the message projection creates the message from admitted session input; the part id under which a V2 user file part is marked, filtered, counted, and projected; a file attachment persisted without the field carries no id and is not addressable.
- `core-discard-context/marked-part` — a content part of an assistant or user message whose id is a member of core-discard-context/marked-ids; the eligible part types are text, reasoning, and tool for assistant messages and text and file for user messages; in the V1 runtime an assistant tool part is also a marked-part when its core-discard-context/provider-call-id is a member; in the V2 runtime a user file part is also a marked-part when its core-discard-context/attachment-id is a member, and a file attachment carrying no id is never a marked-part.
- `core-discard-context/provider-call-id` — the tool-call id under which a tool part appears in the provider context; in the V1 runtime it differs from the tool part's own id.
- `core-discard-context/projected-id-marker` — the fixed line `[part id: <id>]`, placed on its own line at the start of a part's projected text on provider turns where the flag resolves enabled; a projection-only transformation that durable history, session reads, marker surfaces, and exported transcripts never contain.
- `core-discard-context/fully-discarded-message` — an assistant message whose every eligible content part (text, reasoning, or tool other than a core-discard-context/discard-call) is a core-discard-context/marked-part; the unit of exact token attribution.
- `core-discard-context/discarded-token-total` — the session-wide sum of output and reasoning tokens over core-discard-context/fully-discarded-messages; identical for every marker surface of the session.

## Interface

- Config key `discard_context` (boolean; a root key of both the V2 and V1 config surfaces, read in the V1 runtime through the V1 config service, with the V1 document value carried into the V2 surface by config migration): name and type here; allowed values, default, and effect in Configuration.
- Tool `discard_context`:
  - input: `{ ids: string[] }` — ids of message parts to hide from later context; an id may name an assistant part (text, reasoning, or tool call) or a user part (text or file, a V2 file part by its core-discard-context/attachment-id); every element must be a string.
  - output (V2): `{ ids: string[] }` — equals the input ids. The V1 `Tool.Def` shape has no structured-output channel: a settled V1 call exposes the same model-facing confirmation line with identical wording, and the echoed ids are available only in the persisted tool part's `state.input`.
  - model-facing output: one non-empty text line that confirms successful execution and states the count of the call's ids matching parts eligible for marking in the loaded history; the zero-count line additionally instructs the model not to repeat the call without ids of new parts to mark; the wording is identical in the V2 and V1 runtimes.
  - execution performs no permission assertion (V2: the internal built-in-only exception of v2-tools; V1: no permission ask is issued).
- System instruction: a fixed instruction appended after the agent system prompt and the context-epoch baseline on provider turns where the flag is enabled; in the V1 runtime the same fixed text is appended to the per-turn system parts, which the provider request joins into one combined system message. It explains the tool, the origin of part ids, that unknown ids are ignored, that parts of both assistant and user messages are markable, and that the discard calls themselves are hidden.
- Part-id visibility: on provider turns where the flag resolves enabled, the projection of user and assistant messages carries the id of each projected part — text parts through the core-discard-context/projected-id-marker line, file parts of V2 user messages through the marker line placed immediately before the file content, tool parts through their core-discard-context/provider-call-id exposed natively by the provider context, reasoning parts through the marker line only when the projection includes them; turns that resolve the flag disabled project no marker, and durable history, session reads, marker surfaces, and exported transcripts never contain the marker.
- Marker surfaces:
  - session-ui: one divider line per discard-call, localized through the i18n keys `ui.messagePart.context.discarded`, `ui.messagePart.context.discardedTokens`, and `ui.tool.discardContext`.
  - TUI: one inline marker line per discard-call with fixed English labels (pending label, failure label, and the discarded-count label).
  - transcript export: one marker line per discard-call, optionally with the token suffix.

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `discard_context` | boolean | `false` (key optional; absence disables; a root key of both the V2 and V1 config surfaces, with the V1 document value carried into the V2 surface by config migration) | Gates tool registration at Location layer construction (R2.1, R2.2) and the per-turn instruction (R2.4), filtering (R2.5), and part-id marker visibility (R8.1, R8.5) in the V2 runtime, and the per-turn tool set, instruction, filtering, and part-id marker visibility in the V1 runtime (R2.7–R2.9, R8.1, R8.5); on turns that resolve the flag as disabled no filtering and no marker projection are applied and marked parts and discard-calls return to provider context (R2.5, R2.10, R8.5) |
| `tokens-k-threshold` | `magic` 1000 tokens (nameless literal in the code) | — | Lower compact-format bound: totals below it render as a plain count in the token suffix (R7.5) |
| `tokens-m-threshold` | `magic` 1000000 tokens (nameless literal in the code) | — | Upper compact-format bound: totals below it and at or above `tokens-k-threshold` render with a `k` suffix, totals at or above it with an `M` suffix (R7.5) |

## Requirements

- R1. Tool contract:
- R1.1. In the V2 runtime the structured output of a settled `discard_context` call equals its input `ids` array. In the V1 runtime the settled call has no structured-output channel; the model-facing output is the R1.2 confirmation line, with the echoed ids readable only from the tool part's `state.input` persisted by the processor.
- R1.2. The model-facing output of a settled call is a single non-empty text line that confirms successful execution and states the count of the call's ids matching parts eligible for marking in the loaded history.
- R1.3. Tool execution performs no permission assertion.
- R1.4. Tool execution performs no effect other than the durable persistence of the tool part that records the call.
- R1.5. Input that does not match the input schema is rejected before execution as a model-visible settlement error.
- R1.6. Ids that name no existing part are accepted and echoed like any other ids.
- R1.7. The model-facing output line of R1.2 uses identical wording in the V2 and V1 runtimes.
- R1.8. A settled call whose ids match no part eligible for marking, including the call with an empty ids array, states a zero count and instructs the model not to repeat the call without ids of new parts to mark.
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
- R4.2. Filtering removes every core-discard-context/marked-part from assistant and user messages.
- R4.3. Filtering removes every core-discard-context/discard-call part from assistant messages, so a marked tool call and its result disappear together.
- R4.4. A message whose content becomes empty after filtering is dropped entirely.
- R4.5. Filtering preserves entry order and changes a message only by removing its marked parts and discard-calls.
- R4.6. Marked ids that name no part of the loaded history are ignored by filtering.
- R4.7. In the V1 runtime a marked-id matches an assistant tool part when it equals the part's id or the part's core-discard-context/provider-call-id.
- R4.8. Filtering never drops the most recent user entry of the loaded history and never removes every content part of it; marked ids naming its parts are ignored for the current filtering pass.
- R4.9. A user part is matched only by its own part id; the core-discard-context/provider-call-id matching of R4.7 never applies to user parts.
- R4.10. After filtering drops emptied messages of either role, the lowered provider request stays valid, with user and assistant turns kept alternating.
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
- R7.7. Marked user parts never contribute tokens to the core-discard-context/discarded-token-total.
- R8. Part-id visibility:
- R8.1. On a provider turn where the `discard_context` flag resolves enabled under the per-turn resolution of R2.3 and R2.8, the provider projection carries the id of each projected part of user and assistant messages as specified by R8.2 through R8.4 in both the V2 and V1 runtimes and by R8.7 in the V2 runtime.
- R8.2. A projected text part of a user or assistant message carries its id as the core-discard-context/projected-id-marker line, placed on its own line at the start of the part's projected text.
- R8.3. A projected tool part carries its id through its core-discard-context/provider-call-id, which the provider context exposes natively; no separate embedding is added.
- R8.4. A reasoning part carries its id through the core-discard-context/projected-id-marker line only when the provider projection of the turn includes the reasoning part at all.
- R8.5. On a provider turn where the `discard_context` flag resolves disabled, the provider projection carries no core-discard-context/projected-id-marker, in either runtime.
- R8.6. The core-discard-context/projected-id-marker exists only inside the provider request projection: durable history, session reads, the marker surfaces of R6, and exported transcripts never contain it.
- R8.7. In the V2 runtime a projected file part of a user message carries its core-discard-context/attachment-id as the core-discard-context/projected-id-marker placed as a text block immediately before the file content of the same user message projection; a file attachment carrying no id projects no marker.

## Examples

- A1.2. A call whose ids match two eligible parts settles with a single non-empty line confirming success and stating the marked count, worded identically in the V2 and V1 runtimes.
- A1.6. A call with ids naming one existing text part and one nonexistent id settles successfully and echoes both ids.
- A1.8. A call with ids `[]` and a call whose every id names no existing part each settle with the zero-count line that confirms success and instructs the model not to repeat the call without new ids.
- A2.5. The flag is enabled at Location build, a marking call settles, and the flag is then disabled without a rebuild: the next provider turn's request again contains the marked parts and the discard-call, and the system instruction is absent.
- A2.7. In the V1 runtime turning the flag off between turns removes the tool from the very next provider turn's tool set, with no rebuild step.
- A3.1. One discard-call marks `text-plan`, a later one marks `text-plan` and `call-read`; the union is `text-plan` plus `call-read` regardless of call order.
- A3.4. A pending call whose raw input is the JSON string `{"ids": ["text-plan"]}` contributes `text-plan`; raw input `not-json` contributes nothing.
- A3.5. In the V1 runtime a discard-call's ids come from its decoded input record whatever the call status; a call not yet launched has empty input and contributes nothing.
- A4.2. A user message with a text part and a file part whose text part is marked loses the text part from the projection; the file part and the message remain.
- A4.3. An assistant message whose `read` tool call is marked loses the call part and its locally-settled result, which lowering would otherwise emit as a separate result message after the assistant turn.
- A4.4. An assistant message whose only content part is marked disappears from the lowered context; the surrounding user messages remain, so message roles keep alternating.
- A4.7. In the V1 runtime a marked id equal to a tool part's core-discard-context/provider-call-id removes that tool part and its result even though the id differs from the part's own id.
- A4.8. The most recent user entry whose text and file parts are all marked stays in the projection with its parts, and the marked ids naming them are ignored for that filtering pass.
- A4.9. In the V2 runtime a user file attachment marked by its core-discard-context/attachment-id leaves the projection while an unmarked text part keeps the message, and a user message whose text part and file attachment are both marked disappears from the lowered context as an emptied message.
- A4.10. A user message emptied by marking disappears from the lowered context; the lowered request stays valid, with user and assistant turns kept alternating.
- A5.6. On a V1 turn after a marking call, the next provider request, an auto-compaction summary, and a subtask replay all see the same history without the marked parts.
- A7.1. A fully marked assistant message with output tokens and reasoning tokens contributes their sum, and every marker of the session shows that same session total.
- A7.2. A message with a text part and a reasoning part where only the text part is marked contributes nothing, and its tokens appear in no suffix.
- A7.5. Session totals render as `950`, `4.2k`, and `1.3M` across the compact-format bounds.
- A7.7. A marked user text part contributes no tokens to any suffix of the session.
- A8.2. The text part `text-plan` projected on a flag-enabled turn opens with the line `[part id: text-plan]` ahead of its body text.
- A8.3. A tool call reaches the model identified by its provider call id alone, with no marker line added.
- A8.4. A reasoning part projected to a reasoning-capable provider opens with its marker line; the same part absent from the projection carries none.
- A8.5. The same history lowered on a flag-disabled turn projects the same text bodies with no marker line.
- A8.6. The durable row of a marked text part, its session read, its TUI rendering, and its transcript line all lack the `[part id: …]` line that the provider projection of the same part carries.
- A8.7. In the V2 runtime a user file attachment whose core-discard-context/attachment-id is `file-notes` projects on a flag-enabled turn with the line `[part id: file-notes]` immediately ahead of its file content, and a marking call whose ids include `file-notes` counts the attachment in its settled marked count.

## Tests

- T1. Tool registration and contract (packages/core/test/tool-discard-context.test.ts):
- T1.1. flag-off build registers no tool definitions (R2.1, R2.2).
- T1.2. flag-on build registers the tool, echoes the ids, and settles without a permission layer (R1.1, R1.2, R1.3).
- T1.3. invalid input is rejected as a settlement error (R1.5).
- T1.7. zero-count settled output: a call with an empty ids array and a call whose ids name no existing part each settle with a non-empty line that confirms success, states a zero count, and carries the no-repeat instruction (R1.2, R1.8).
- T1.8. matched-count settled output: ids naming a mix of existing and nonexistent parts report the count of the matched parts only (R1.2).
- T2. Filtering units (packages/core/test/session-runner-discard-context.test.ts, filterEntries describe):
- T2.1. removes marked parts, hides discard calls, preserves order (R4.2, R4.3, R4.5).
- T2.2. drops assistant messages emptied by filtering (R4.4).
- T2.3. removes a marked tool call together with its result pair (R4.3).
- T2.4. ignores unknown ids and keeps messages without addressable parts (R4.5, R4.6).
- T2.5. returns entries unchanged without discard calls (R4.1).
- T2.6. reads ids from pending tool input JSON and ignores broken input (R3.4).
- T2.7. removes marked user text and file parts and drops a user message emptied by filtering, preserving order (R4.2, R4.4, R4.5).
- T2.8. ignores marked ids naming parts of the most recent user entry and keeps that entry with its content (R4.8).
- T2.9. matches user parts by part id only; provider-call-id matching never removes a user part (R4.9).
- T2.10. removes a marked V2 user file attachment matched by its core-discard-context/attachment-id and drops a user message emptied by marking both its text part and its file attachment (R4.2, R4.4).
- T3. Runner integration (packages/core/test/session-runner-discard-context.test.ts, SessionRunner describe):
- T3.1. appends the instruction to system parts when the flag is enabled (R2.4).
- T3.2. keeps the instruction out of system parts when the flag is disabled (R2.4).
- T3.3. hides marked parts and discard calls from later provider turns, survives resume, and session reads keep them (R4.2, R4.3, R5.3, R5.4).
- T3.4. compacts from filtered entries so marked parts reach neither summary nor checkpoint while database rows keep the marked content (R5.2, R5.4).
- T3.5. filters parts loaded fresh from the database across a restart (R5.3).
- T3.6. the lowered request stays valid after filtering drops emptied user messages, with user and assistant turns alternating (R4.10).
- T3.7. a flag-on turn projects text and reasoning parts with the marker line and identifies tool parts by their provider call ids (R8.1–R8.4).
- T3.8. a flag-off turn projects the same parts with no marker line (R8.5).
- T3.9. durable rows and session reads of a flag-on turn contain no projected-id-marker (R8.6).
- T3.10. a flag-on turn projects a user file attachment with the core-discard-context/projected-id-marker immediately ahead of its file content, a call naming the attachment id counts it in the settled marked count, and the durable file row contains no marker (R1.2, R8.1, R8.6, R8.7).
- T4. Token attribution (packages/session-ui/src/components/discard-context-summary.test.ts and the mirrored packages/tui/test/util/discard-context.test.ts):
- T4.1. sums output and reasoning tokens of fully discarded assistant messages (R7.1).
- T4.2. partially discarded messages contribute nothing (R7.2).
- T4.3. markers do not close on themselves: a message fully marked plus its own marker counts as fully discarded (R7.1).
- T4.4. merges ids across multiple discard calls (R3.1).
- T4.5. returns a zero total when nothing is discarded (R7.1).
- T4.6. compact format bounds: plain, k, and M forms with decimal trimming (R7.5, R7.6).
- T4.7. marked user parts add no tokens to the total (R7.7).
- T4.8. TUI marker lines contain neither marked ids nor the projected-id-marker (R6.1, R8.6).
- T5. Transcript marker (packages/tui/test/util/transcript.test.ts):
- T5.1. formats a single marker line without ids (R6.1, R6.5).
- T5.2. singular marker text for a single id (R6.1, R6.2).
- T5.3. missing ids render a zero count (R6.2).
- T5.4. appends the compact token suffix when a positive total is provided (R6.4).
- T5.5. omits the suffix when the total is zero or absent (R6.4).
- T5.6. exported transcript lines contain no projected-id-marker lines (R8.6).
- T6. V1 runtime, tests run from packages/opencode (packages/opencode/test/tool/registry.test.ts, packages/opencode/test/session/discard-context.test.ts, packages/opencode/test/session/prompt.test.ts):
- T6.1. registry gate: the materialized tool set includes the tool with the flag on and omits it with the flag off (R2.7, R2.8).
- T6.2. filter unit: tool parts matched by part id or core-discard-context/provider-call-id, discard-calls removed, emptied assistant messages dropped, order preserved (R4.2, R4.3, R4.4, R4.5, R4.7).
- T6.3. flag-on integration: after a marking call the next provider request omits the tool together with the marked parts while the database keeps them (R2.7, R4.2, R4.3, R5.4).
- T6.4. flag-off integration: with the flag disabled marked parts and discard-calls return to the provider request (R2.10).
- T6.5. compaction integration: compaction builds from filtered entries so marked content stays out of the summary (R5.5, R5.6).
- T6.6. reproduction of the empty-output incident: a settled call with an empty ids array produces the non-empty zero-count line with the no-repeat instruction instead of the empty output that drove repeated calls (R1.2, R1.7, R1.8).
- T6.7. a flag-on V1 turn lowers text parts with the marker line and identifies tool parts by provider call id, a flag-off V1 turn lowers no marker line, and the persisted parts never contain the marker (R8.1, R8.2, R8.3, R8.5, R8.6).
- T6.8. the V1 filter removes marked user parts, drops emptied user messages, and keeps the most recent user entry with content (R4.2, R4.4, R4.8).

## Usage constraints

- Enabling the flag changes the byte composition of projected parts by inserting the core-discard-context/projected-id-marker, so the first flag-enabled turn touches the provider prefix cache once; part ids are stable, so marker-bearing projections stay cache-stable afterwards.
- In the V1 runtime the processor's doom-loop guard is not exempted from this tool: repeated identical discard calls can raise a permission confirmation.
- In V1 sessions parts marked by core-discard-context/provider-call-id are excluded from provider context, but the TUI token suffix matches marked ids against part ids only, so the suffix may be absent or under-report; it never over-reports, and no TUI change is planned.
- In the V2 runtime file attachments of durable user-message rows persisted before the attachment id field existed carry no id: they stay unaddressable, never matched by marking, never counted in a settled marked count, and never preceded by the core-discard-context/projected-id-marker; experimental V2 databases are disposable one-shot state under the established policy, so no backfill of ids is provided.
- The V1 filter is a deliberate mirror copy of the core filter, kept as a copy because the core module's types bind to the V2 message shapes; any change must keep it semantically identical to the core filter.
- The pure attribution logic exists as two deliberate copies (session-ui and the TUI package, which cannot depend on the web-only package); any change must keep them identical.
- The i18n keys must exist in every supported locale (enforced by the locale parity test); translations may lag, leaving English copies in place.
- The compact suffix always uses a dot as the decimal separator, and the token-count phrasing is not pluralization-aware in every locale.
- The session-ui divider render has no direct unit test (a bundling constraint of the web package); its logic is covered through the attribution module tests.

## Justification

- J1. Why input and cache tokens are excluded from the total (R7.3): providers report them for the whole request rather than per excluded content, so attributing them to discarded parts would be invented.
- J2. Why partially discarded messages contribute nothing (R7.2): token counts exist per assistant message only, and estimating a share would misreport savings, so the total stays exact or empty — a deliberate exactness-over-coverage decision.
- J3. Why filtering runs before both compactions (R5.2): a summary or checkpoint built from unfiltered entries would preserve marked content beyond the marking and re-enter it on every later turn.
- J4. Why emptied messages are dropped (R4.4, R4.10): providers require alternating user and assistant turns, so an emptied message of either role would make the lowered request invalid.
- J5. Why the token suffix is session-wide rather than per-marker (R7.4): attribution is exact per message and not per call, so a per-marker split would be arbitrary; one session total keeps every surface consistent.
- J6. Why registration is gated at Location build while the instruction and filtering are re-resolved per turn (R2.1, R2.3): tool definitions materialize per registration cycle, while per-turn re-resolution lets a reopened Location's config steer the very next provider turn without rebuilding the runner.
- J7. Why the V1 filter matches tool parts by core-discard-context/provider-call-id as well as by part id (R4.7): a V1 tool part reaches the model under its core-discard-context/provider-call-id while its own part id stays internal, so id-only matching would leave marked tool calls visible to the model.
- J8. Why the V1 filter is a mirrored copy rather than an import of the core filter (R4.7, R5.5): the core filter's types bind to the V2 message shapes, so reuse would erase the V1 types; a semantic mirror keeps each runtime's types intact at the cost of a copy that must stay identical to its original, like the existing attribution copies.
- J9. Why the settled output is never empty and the zero-count line forbids repetition (R1.2, R1.8): a V1 incident showed that an empty settled output for an empty-ids call left the model without a completion signal and drove a loop of repeated identical calls, which an explicit success confirmation with the marked count closes.
- J10. Why the most recent user entry survives filtering whole (R4.8): the runner reads the current turn's steering and formatting from the projected history, so removing the latest user entry or all of its parts would invalidate the very turn the marking tried to improve; ignoring its ids for the pass is the narrowest rule that prevents this.
- J11. Why marked user parts contribute no tokens (R7.7): usage is reported per assistant message only, so no exact attribution exists for user parts; the total stays exact or empty, extending the decision of J2.
- J12. Why the part-id markers are projection-only (R8.6): durable history feeds resume, session reads, and every marker surface, so baking provider-facing identification into stored text would leak projection formatting into all of them, the same projection-only principle R5.4 states for filtering.

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

- config-v1 — the `discard_context` configuration row delegates the key's effect to this spec.
- core-tools-permissions — hosts the V1 wrapper as a registry built-in with the `tools()` config gate and no permission ask of its own.

## Verification

None. No formal verification (TLC/TLAPS) exists for this component; the requirements are covered by the recorded tests above.
