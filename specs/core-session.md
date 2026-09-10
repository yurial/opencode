# Session Core

Status: draft (as-built behavior specification — describes what the current code does,
including behavior absent from the draft design specs; divergences are called out inline
and listed in "Divergences and open questions")

Spec source of truth for: V2 Session and prompt lifecycle — durable admission, delivery,
execution, context epochs, compaction, revert, and the legacy V1 runtime boundary.

Related design specs (drafts, not duplicated here): `specs/v2/session.md` (reference
`config-v2-session`) covers the intended V2 session API surface, the V1 runtime-context
parity table, and follow-ups; `packages/opencode/specs/v2/message-shape.md` (reference
`opencode-v2-message-shape`) covers stored message shape options. Normative engineering
rules live in `AGENTS.md` ("V2 Session Core"). Event pruning is specified by
`specs/event-retention.md` (reference `event-retention`). This document describes the
code as it exists; where code and the drafts disagree, this document records the code.

## Scope

In:

- V2 Session identity, creation, adoption, listing, reads (`packages/core/src/session.ts`,
  `packages/core/src/session/{store,info,history,sql,schema}.ts`).
- Durable prompt admission, idempotent retry, delivery modes (`steer`/`queue`), inbox
  promotion (`packages/core/src/session/input.ts`, `packages/schema/src/session-input.ts`,
  `packages/schema/src/session-delivery.ts`).
- Execution routing, per-Session serialization, advisory wakes, interruption
  (`packages/core/src/session/execution.ts`, `execution/local.ts`, `run-coordinator.ts`).
- The provider-turn runner: model resolution, request assembly, streaming publication,
  tool settlement, continuation, step limits, fencing
  (`packages/core/src/session/runner/*`).
- Context epochs and the System Context algebra
  (`packages/core/src/session/context-epoch.ts`, `packages/core/src/system-context/*`).
- Automatic and overflow-triggered compaction (`packages/core/src/session/compaction.ts`).
- Durable event family `session.next.*`, projection into `session_message`/`session_input`,
  read APIs (`packages/core/src/session/{event,projector,message-updater}.ts`,
  `packages/core/src/event.ts`, `packages/schema/src/session-event.ts`).
- Revert staging/commit, session todos, session move
  (`packages/core/src/session/{revert,todo}.ts`, `packages/core/src/control-plane/move-session.ts`).
- The legacy V1 runtime in `packages/opencode/src/session/` at boundary level: how it
  shares the database and event log, and where it stops being relevant to V2.

Out (covered elsewhere or deliberately excluded):

- Agent catalog details (another spec covers `src/agent` / `packages/core/src/agent.ts`;
  this spec only fixes the selection contract the runner relies on).
- Tool registry internals (`packages/core/src/tool/*`), permission evaluation
  (`packages/core/src/permission.ts`), LLM protocol adapters (`packages/llm`).
- V1 prompt-loop internals (plugin hooks, MCP/LSP instructions, title/summary
  generation) — only their boundary effects on session state.
- SDK/HTTP schema generation; sync-mode event retention (`event-retention`).

## Key files

| File | Responsibility |
|---|---|
| `packages/core/src/session.ts` | `SessionV2` facade: create/get/list/messages/context/events/history/prompt/switch*/interrupt/resume/active/revert; wires execution + store + projector |
| `packages/core/src/session/input.ts` | Durable inbox: `admit`, `projectAdmitted`, `projectPrompted`, `promoteSteers`, `promoteNextQueued`, `hasPending`, retry equivalence |
| `packages/core/src/session/execution.ts` | `SessionExecution` service contract (process-global, Session-ID keyed) + `noopLayer` |
| `packages/core/src/session/execution/local.ts` | Local routing: drain callback resolves Session → Location layer → `SessionRunner.run` |
| `packages/core/src/session/run-coordinator.ts` | Generic per-key serialization: `run`/`wake`/`interrupt`/`active` with coalesced follow-ups |
| `packages/core/src/session/runner/index.ts` | `SessionRunner` service contract + `RunError` union |
| `packages/core/src/session/runner/llm.ts` | The drain and provider-turn orchestration (the heart of V2 execution) |
| `packages/core/src/session/runner/model.ts` | Catalog/credential/variant/prime-time model resolution |
| `packages/core/src/session/runner/publish-llm-event.ts` | Per-turn publication state machine (fragments, tools, step settlement, failure paths) |
| `packages/core/src/session/runner/to-llm-message.ts` | Projected history → `@opencode-ai/llm` messages (provider metadata replay rules) |
| `packages/core/src/session/history.ts` | Post-compaction, epoch-filtered history queries (`load`, `entriesForRunner`) |
| `packages/core/src/session/projector.ts` | Event → SQLite projections (`session`, `message`, `part`, `session_message`, `session_input`, `session_context_epoch` writes) |
| `packages/core/src/session/message-updater.ts` | Pure event → message-state reducer (immer) with pluggable adapter (DB or in-memory) |
| `packages/core/src/session/context-epoch.ts` | Epoch initialize/prepare/advance/replace/reset |
| `packages/core/src/session/compaction.ts` | Estimation, summary generation, `compactIfNeeded`/`compactAfterOverflow` |
| `packages/core/src/session/{store,info,sql,schema,error,prompt,message,event,revert,todo}.ts` | Read store, row mapping, tables, typed errors, schema re-exports |
| `packages/core/src/system-context/{index,registry,builtins}.ts` | Context source algebra (observe/compare/render), Location registry, env/date built-ins |
| `packages/core/src/control-plane/move-session.ts` | Git-aware session move + `session.next.moved` |
| `packages/schema/src/session-event.ts` | `session.next.*` definitions: durable vs live-only split |
| `packages/schema/src/{session,session-message,session-input,session-delivery,prompt,prompt-input,session-id}.ts` | Wire schemas |
| `packages/core/src/event.ts` | `EventV2`: durable transactional publish with in-transaction projectors, replay/claim, durable replay-and-tail streams |
| `packages/server/src/handlers/session.ts`, `packages/server/src/routes.ts`, `packages/protocol/src/groups/session.ts` | V2 HTTP surface (`/api/session/...`) |
| `packages/opencode/src/session/{session,prompt,run-state,status,message-v2,processor,compaction,tools,reminders,retry,revert,summary,system,instruction,llm,llm/*}.ts` | Legacy V1 engine and V1↔shared-storage bridge |
| `packages/opencode/src/event-v2-bridge.ts` | Publish boundary attaching instance Location; mirrors events to `GlobalBus` |
| `packages/opencode/src/server/routes/instance/httpapi/{server.ts,handlers/control-plane.ts}` | Instance HTTP wiring: `SessionV2.node` + `SessionExecutionLocal`, move-session handler |

## 1. Model overview

Two engines share one SQLite database and one durable event log:

- The **V2 core** (`packages/core/src/session/*`, Effect-native). All state changes are
  durable events published through `EventV2`; projectors rebuild read models inside the
  same transaction that commits the event. The `session.next.*` family is the V2 event
  vocabulary. Execution is a serialized local drain over projected history; the runner
  issues exactly one `llm.stream(request)` per provider turn.
- The **V1 runtime** (`packages/opencode/src/session/*`). Publishes `session.*` (V1)
  events through `EventV2Bridge`, drives its own in-memory tool loop
  (`SessionPrompt.runLoop`), and serves the instance HTTP API. It shares the `session`,
  `message`, and `part` tables with V2 through the common projector.

The durable event log is the source of truth. Every durable event carries
`{ aggregateID: sessionID, seq, version }`; `seq` is allocated per aggregate from the
`event_sequence` counter inside an immediate SQLite transaction that also runs all
registered projectors and an optional local `commit` hook (`packages/core/src/event.ts`,
`commitDurableEvent`). Live-only events (`*.delta`, `todo.updated`) are broadcast but
never persisted.

Session IDs are `ses_`-prefixed descending identifiers (`packages/schema/src/session-id.ts`),
shared by both engines (`packages/opencode/src/session/schema.ts` aliases `SessionV2.ID`).

### 1.1 Tables (`packages/core/src/session/sql.ts`)

- `session` — one row per Session; written by `session.created/updated/deleted` (V1) and
  `session.next.moved/agent.switched/model.switched/revert.*` (V2) projectors. Carries
  denormalized cost/token counters (maintained only from V1 `step-finish` parts via
  `applyUsage`), revert state, agent/model selection.
- `session_message` — projected V2 messages. `seq` equals the durable aggregate sequence
  of the projecting event (unique per session); ordering follows event order regardless
  of caller-supplied IDs/timestamps.
- `session_input` — the durable admission inbox: `admitted_seq` (sequence of
  `session.next.prompt.admitted`), nullable `promoted_seq` (sequence of the projecting
  `session.next.prompted`), `delivery`, encoded prompt. Unique on
  `(session_id, admitted_seq)` and `(session_id, promoted_seq)`.
- `session_context_epoch` — one row per Session: `baseline` text, structured
  `snapshot`, `baseline_seq`.
- `message`/`part`/`todo` — V1 storage, projected from V1 message/part events.

### 1.2 Message variants (`packages/schema/src/session-message.ts`)

`user`, `assistant` (content: `text` | `reasoning` | `tool`), `synthetic`, `system`,
`shell`, `agent-switched`, `model-switched`, `compaction`. Tool parts carry a state
machine `pending → running → completed | error` and a `provider` record
(`{ executed, metadata?, resultMetadata? }`) that preserves call-side and
settlement-side provider metadata separately.

## 2. Session lifecycle

### 2.1 Creation and adoption (`SessionV2.create`)

`create({ id?, agent?, model?, location })`:

- An omitted `id` generates a new `SessionSchema.ID`; a supplied `id` that already
  exists returns the recorded Session unchanged (adoption).
- The directory is resolved to a project (`ProjectV2.resolve`); a `project` row is
  inserted `onConflictDoNothing`.
- Creation publishes the **V1-shaped** durable event `session.created` carrying a full
  `SessionV1.SessionInfo` (title `New session - <ISO date>`, zero cost/tokens); the
  projector inserts the `session` row and, for a workspace Session, bumps
  `workspace.time_used`.
- A concurrent-creation race surfaces as a `SessionProjector.SessionAlreadyProjected`
  defect from the projector's insert; `create` catches exactly that defect, re-reads the
  store, and adopts the winner's row. Any other defect dies.
- V2 `create` accepts no `parentID`; `session.parent_id` is populated only through the
  V1 path. A code TODO notes that restoring recorded sessions onto replacement
  synchronized workspaces is a future API slice.

### 2.2 Reads

- `get` → `SessionStore.get` (row → `SessionSchema.Info` via `session/info.ts`;
  `location` is reconstructed as `{ directory, workspaceID? }`; omitted `workspaceID`
  means implicit-local placement).
- `list` filters by exact `directory`, `workspaceID`, `project` (+optional `subpath`,
  currently unused by the query), `search` (SQL `LIKE` on title), with keyset anchor
  pagination on `(time_created, id)`; default order `desc`; `direction: "previous"`
  reverses the scan and re-reverses the page.
- `messages` paginates `session_message` by `seq` with an id-message cursor and the
  same direction-flip rule; decode failures surface as `Session.MessageDecodeError`.
- `message` fetches one message by ID and returns it only if it belongs to the given
  Session; missing → `undefined` (handler maps to 404).
- `context` returns the model-visible history (post-compaction, epoch-filtered;
  see §8.3).

V2 has no Session delete; deletion exists only on the V1 path (`Session.remove` →
`session.deleted` projection + `EventV2.remove(aggregateID)` which drops the event log
and sequence row).

### 2.3 Selection switches

- `switchAgent` publishes `session.next.agent.switched` (durable); the projector updates
  `session.agent` and the updater appends an `agent-switched` message.
- `switchModel` is a no-op when the recorded model already matches (variant `"default"`
  normalized); otherwise publishes `session.next.model.switched`.
- Both switches are provider-turn scoped for execution: the runner re-reads the session
  per turn, so a switch admitted after the current safe boundary applies from the next
  provider turn without restarting the current one. Both lower to **no** provider
  message (`to-llm-message.ts` drops `agent-switched`/`model-switched`).

### 2.4 Move (`MoveSession.moveSession`)

Moving requires the destination to resolve to the same project (else
`DestinationProjectMismatchError`); optionally captures the source worktree's Git patch
and applies it at the destination before publishing `session.next.moved` (which
reprojects `directory`/`path`/`workspace_id`) and discarding source changes. Divergence:
the epoch is **not** cleared on move — `SessionContextEpoch.reset` exists but has no
caller, and the `session.next.moved` projector only updates the `session` row; see
§14.

## 3. Prompt admission and delivery

### 3.1 Admission (`SessionV2.prompt` → `SessionInput.admit`)

`prompt({ id?, sessionID, prompt, delivery?, resume? })` runs uninterruptibly:

1. `sessionID` must resolve (`Session.NotFoundError`).
2. The wire prompt (`PromptInput.Prompt`) is normalized to the durable `Prompt` shape:
   file attachments get a derived `mime` (data-URI mime, `application/x-directory` for
   trailing-slash targets, else extension lookup).
3. `messageID = id ?? generated`; `delivery = delivery ?? "steer"`.
4. `SessionInput.admit` first looks the message ID up in `session_input`; an existing
   row is returned as-is (idempotent). Otherwise it publishes durable
   `session.next.prompt.admitted`; the projector (`projectAdmitted`) inserts the inbox
   row inside the event transaction. A `LifecycleConflict` defect from the projector
   (message row already projected) is retried via a store re-read before dying.
5. Back in the facade, the returned/stored `Admitted` must be `equivalent` to the
   request — same session, same delivery, and byte-identical encoded prompt — else
   `Session.PromptConflictError`. Exact retries return the original receipt (including
   `promotedSeq` if the input was already promoted).
6. Unless `resume === false`, `execution.wake(sessionID)` is scheduled (advisory).

Admission is purely durable: no model work happens here. `admittedSeq` (the durable
sequence of the admission event) is the client-visible queue position.

### 3.2 Promotion (runner-owned)

Admitted inputs become model-visible only when the serialized runner publishes
`session.next.prompted`; the projector (`projectPrompted`) marks the inbox row
promoted — or, for a `Prompted` event with no inbox row (historical/replayed prompts),
lazily inserts one with `admitted_seq = promoted_seq`.

- `promoteSteers(sessionID, cutoff)` publishes `Prompted` for **all** pending `steer`
  rows with `admitted_seq <= cutoff`, in admission order.
- `promoteNextQueued(sessionID)` publishes `Prompted` for exactly **one** pending
  `queue` row (lowest `admitted_seq`).
- Each `Prompted` event appends the visible `user` message (`message-updater`).

### 3.3 Delivery semantics

- `steer` (default): promote at the next safe provider-turn boundary, including
  continuation inside the current drain. Steers coalesce as a batch; one batch resets
  the agent step allowance once (`currentStep = 1`).
- `queue`: remains pending while the current drain requires continuation. When the
  Session would otherwise go idle, the drain promotes exactly one queued input and
  re-evaluates continuation before promoting another.
- A `queue` drain promotes `promoteNextQueued()` **then** `promoteSteers(cutoff)` —
  steers admitted before that boundary jump ahead of later queued inputs.

## 4. Execution model

### 4.1 Routing (`SessionExecution`)

`SessionExecution` is a process-global service keyed only by Session ID
(`packages/core/src/session/execution.ts`); no layer takes a Session ID. The local
implementation (`execution/local.ts`) owns one `SessionRunCoordinator` and, per drain:
`SessionStore.get(sessionID)` → `LocationServiceMap.get(session.location)` →
`SessionRunner.Service.use(runner => runner.run({ sessionID, force }))` provided with
that Location's layer. A missing Session dies with `Session not found: <id>`
(interrupt-only drain exits are logged silently; other failures are logged with the
sessionID). Remote placement is a future concern (comment in `execution/local.ts`).
`noopLayer` provides an inert implementation for callers that only need durable
recording.

### 4.2 Coordination (`SessionRunCoordinator`)

Generic `Coordinator<Key, E>` serializing per key while different keys run concurrently:

- `run(key)`: joins the active entry's `Deferred` or starts a **forced** drain
  (`force = true`). If the entry is stopping, waits for it to settle and retries.
- `wake(key)`: pure sync. With an active entry, sets `pendingWake` (one coalesced
  follow-up); otherwise starts a **non-forced** drain (`force = false`).
- On successful drain settlement with `pendingWake` set, the entry is reused and a
  non-forced successor drain starts immediately.
- `interrupt(key)`: marks the entry stopping, **clears `pendingWake`**, and interrupts
  the owner fiber, returning only after the fiber's cleanup finishes. Idle/missing
  interruption is a no-op. A wake arriving *after* an interrupt still arms a successor
  drain — durable inbox rows always remain eligible for a later wake or resume.
- `active`: snapshot of keys with live entries; runtime state only, empty after
  restart. This set is what `sessions.active()` (and the HTTP `session.active`)
  reports as `{ type: "running" }`; background subagents do not add parent sessions.

### 4.3 The drain loop (`SessionRunner.run`)

1. Eligibility: `hasSteer = hasPending(steer)`; `hasQueue` only when no steers. Without
   `force` and without either, the drain returns immediately (advisory wakes do no
   provider work).
2. `failInterruptedTools`: any assistant tool still `pending`/`running` in projected
   context — leftovers from a previous process or interrupted drain — is durably failed
   with `Tool execution interrupted`, preserving provider metadata. Abandoned side
   effects are never silently replayed.
3. Inner loop (continuation): `runTurn(sessionID, promotion, step)` per provider turn;
   `promotion` becomes `"steer"` for every turn after the first; when a turn reports no
   continuation, pending steers admitted meanwhile restart the inner loop.
4. Outer loop (queue): when the inner loop ends, one pending queued input promotes
   (`promotion = "queue"`) and the inner loop repeats; the drain ends when no queued
   input remains.

A forced run with nothing eligible still performs one provider attempt (the
interface contract: "Explicit runs perform one provider attempt even when no work is
eligible").

### 4.4 Interruption and recovery

- `SessionV2.interrupt` is uninterruptible and delegates to
  `coordinator.interrupt`: stops the process-local drain at the current turn boundary,
  waits for runner cleanup (tool fibers are awaited/cleared; unsettled tools and an
  active assistant are failed durably — see §5.4), and preserves all durable inbox
  rows.
- Each `runTurnAttempt` re-checks placement first: if the Session's location no longer
  matches the runner's Location (directory and workspaceID), the attempt self-interrupts
  (fencing against stale drains after a move).
- There is **no post-crash continuation recovery**: a wake never retries ambiguous
  provider work. Explicit `run`/`resume` deliberately continues from durable projected
  history; interrupted tools are failed on the next drain start (step 2 above). A
  dedicated recovery slice is still open (draft spec follow-up).

## 5. The provider turn (`runner/llm.ts`)

One `runTurnAttempt`:

1. **Fence** the session's Location against the runner's Location (§4.4).
2. **Select agent**: `agents.select(session.agent)` — explicit ID (info may be
   undefined), else configured default, else `build`, else first selectable
   (non-subagent, non-hidden); `id` falls back to `build` (`packages/core/src/agent.ts`).
3. **Epoch initialize**: `SessionContextEpoch.initialize` creates the epoch before any
   promotion if absent (§8). If initial context sources are unavailable this fails with
   `SystemContext.InitializationBlocked` and the drain errors; the prompt stays pending
   and retryable.
4. **Promote** eligible input (§3.3) using `cutoff = EventV2.latestSequence` captured
   now; any promotion resets `currentStep` to 1.
5. **Epoch prepare** when not freshly initialized: reconcile current sources at this
   safe boundary (§8.2).
6. **Resolve model** (`SessionRunnerModel.resolve`, §5.1).
7. **Load history**: `SessionHistory.entriesForRunner(db, sessionID, baselineSeq)`
   (§8.3).
8. **Step limit**: `isLastStep = agent.steps !== undefined && step >= agent.steps`. On
   the last step, tools are not materialized, `toolChoice: "none"` is sent, and the
   `MAX_STEPS_PROMPT` assistant message is appended (shared with V1 via
   `runner/max-steps.ts`).
9. **Assemble request**: system parts `[agent.system, epoch.baseline]`; lowered history
   (`to-llm-message.ts`); HTTP headers `x-session-affinity`/`X-Session-Id`
   (+`x-parent-session-id` for child sessions); `providerOptions.openai.promptCacheKey`
   = session ID with a `ses_` prefix stripped when the remainder is 64 hex chars.
10. **Pre-check compaction**: `compactIfNeeded` (§9). If it completed, the turn restarts
    from rebuilt history via the `TurnTransitionError` control-flow defect
    (`ContinueAfterCompaction`).
11. **Capture start snapshot** (`Snapshot.Service`) for changed-path attribution and
    revert planning.
12. **Stream**: exactly one `llm.stream(request)`; events flow through the publication
    state machine (§5.2). Local (non-provider-executed) `tool-call` events durably mark
    `needsContinuation` and immediately fork an uninterruptible
    `toolMaterialization.settle(...)` fiber into a per-attempt `FiberSet`, publishing
    the tool result when settlement completes.
13. **Settle**: after stream closure, await all tool fibers (`raceFirst(join,
    awaitEmpty)`), then publish `Step.Ended` (usage tokens mapped to
    input/output/reasoning/cache; `cost: 0` — session-level cost accounting is not
    implemented on the V2 path), with an end snapshot and the project-relative paths
    changed between the turn's start/end snapshots (`Snapshot.Service.files`).
14. **Return** `{ needsContinuation, step }`; the drain continues per §4.3.

### 5.1 Model resolution (`runner/model.ts`)

Resolve order: session-pinned model from the available catalog (else
`ModelUnavailableError`); else catalog default if supported; else first supported; else
`ModelNotSelectedError`. "Supported" = `aisdk` package
`@ai-sdk/openai` | `@ai-sdk/anthropic` | `@ai-sdk/openai-compatible` (+URL); anything
else fails `UnsupportedApiError`. Prime-time windows (catalog `primeTime*` fields) are
enforced **before** credential work (`ModelPrimeTimeError`; disabled/inconsistent
configurations fail open). Credentials come from the integration connection
(key/oauth/body-overlay). Variants overlay headers/body; an explicit unknown variant
fails `VariantUnavailableError` (`"default"` falls back to the model's own configured
variant).

### 5.2 Publication state machine (`runner/publish-llm-event.ts`)

Per-turn publisher exposing `publish(event)`, serialized by a 1-permit semaphore:

- Assistant identity is created lazily (`Step.Started` on first content).
- Text/reasoning/tool-input fragments are accumulated in memory; `*.Started`/`*.Delta`
  publish immediately (deltas are live-only), `*.Ended` publishes the **full value**
  durably. `flush()` ends any dangling fragments (e.g. after provider stream failure).
- Tool tracking per call ID: input start/end (name-change and duplication are defects),
  `Tool.Called` (records decoded input + provider metadata), `Tool.Success`/`Tool.Failed`
  with structured/content output and separate result-side provider metadata. Duplicate
  results and name drift die; a duplicate error-result after settlement is ignored.
- `step-finish` records settlement (finish reason + tokens); duplicates die.
- `provider-error` marks the turn failed and publishes `Step.Failed` after flushing;
  once a provider error is recorded, later stream events are dropped.
- `failUnsettledTools(message, hostedOnly?)` publishes `Tool.Failed` for every
  unsettled call (`hostedOnly` restricts to provider-executed calls — used for
  "Provider did not return a tool result").
- Overflow capture: a context-overflow provider error arriving before any assistant
  content is withheld from publication and offered to overflow recovery (§9.2); if
  recovery declines, the withheld error is published (failing the turn).

### 5.3 History lowering (`runner/to-llm-message.ts`)

- `user` → text + media parts (attachments with mime/description); `synthetic`/`shell`
  → user-role text; `system` → system message; `compaction` → a user-role
  `<conversation-checkpoint>` block embedding summary + serialized recent context.
- Assistant messages replay provider-native reasoning and provider metadata **only when
  the historical assistant model matches the resolved continuation model and the
  message has no error**; otherwise reasoning degrades to plain text and metadata is
  omitted. Provider-executed tool results reuse the stored provider result value;
  locally-settled results are re-materialized from structured/content parts (with an
  open TODO: remote/managed URIs are rejected rather than fetched).
- Locally-settled tool results are emitted as separate tool-result messages so they
  follow the assistant turn regardless of content ordering.

### 5.4 Failure and interruption paths

- Provider stream failure (non-overflow): fail unsettled hosted tools, fail the
  assistant (`Step.Failed`), re-fail the stream cause.
- Interruption (stream or tool fibers): clear tool fibers, fail unsettled tools with
  `Tool execution interrupted`, fail an active assistant with
  `Provider turn interrupted`, propagate the interrupt cause (the coordinator treats
  interrupt-only drains as silent).
- **User-declined permission/question** (`PermissionV2.DeclinedError`,
  `QuestionV2.RejectedError` as defects inside settlement): fail unsettled tools and
  interrupt the drain — matching V1, declining halts the loop rather than becoming
  model-facing tool output.
- Tool settlement failure (non-interrupt): fail unsettled tools with
  `Tool execution failed: <message>`; the drain continues to settlement reporting.

## 6. Event flow and read APIs

### 6.1 Durable vs live-only (`packages/schema/src/session-event.ts`)

Durable (replayable, versioned, aggregate `sessionID`): `agent.switched`,
`model.switched`, `moved`, `prompted`, `prompt.admitted`, `context.updated`,
`synthetic`, `shell.started/ended`, `step.started/ended/failed`, `text.started/ended`,
`reasoning.started/ended`, `tool.input.started/ended`, `tool.called`, `tool.progress`,
`tool.success`, `tool.failed`, `retried`, `compaction.started/ended`,
`revert.staged/cleared/committed`. Live-only: `text.delta`, `reasoning.delta`,
`tool.input.delta`, `compaction.delta`. `Step.Ended`/`Step.Failed` are version 2 (the
settlement shape); the rest version 1.

Durable `Tool.Progress` is the bounded checkpoint channel for running tools — tools
publish semantic transitions, not every output chunk.

### 6.2 Publish mechanics (`packages/core/src/event.ts`)

Durable publication opens an immediate transaction: allocate `seq` from
`event_sequence`, run all registered projectors, run the optional `commit` hook (used
by `ContextUpdated` to advance the epoch snapshot atomically), upsert the counter,
insert the `event` row — then wake per-aggregate sliding(1) signals and broadcast to
streams/listeners. Replay (`replay`/`replayAll`) is idempotent for identical rows,
rejects divergence, re-inserts pruned sequences without moving the counter, and honors
owner claim/strict-owner checks (`claim`, `EventSequence.owner_id`) — replay owner
claims are separate from execution ownership. Sync-mode pruning (`EventV2.prune`)
follows `event-retention`.

### 6.3 Read/stream APIs

- `SessionV2.events({ sessionID, after? })`: replay-then-tail **durable-only** stream.
  Each tail holds one capacity-1 sliding dirty signal registered before the historical
  read (no replay/live race); wakes re-query SQLite, so coalescing loses nothing. The
  handler serves it as SSE (`GET /api/session/:sessionID/event`).
- `SessionV2.history({ sessionID, after?, limit })`: one finite page of public durable
  events via `EventV2.readAggregate` with the `SessionDurable` manifest — public
  selection before pagination permits sequence gaps; `after` is exclusive; response
  `{ events, hasMore }`. HTTP: `GET /api/session/:sessionID/history`, default 50, max
  100 (`packages/protocol/src/groups/session.ts`).
- `EventV2Bridge` (`packages/opencode`) attaches the instance Location to publishes and
  mirrors every event (and a `sync` envelope for durable ones) onto `GlobalBus` for
  SSE/WebSocket clients.

### 6.4 Projection (`session/projector.ts` + `message-updater.ts`)

The projector registers one handler per event type; `run(db, event)` applies the pure
reducer `SessionMessageUpdater.update(adapter, event)` against a DB adapter. Notable
rules:

- `Step.Started` completes any previous incomplete assistant ("a newer turn supersedes
  stale incomplete rows") and appends the new assistant with the start snapshot.
- Append-only events (`prompted`, `context.updated`, `synthetic`, `shell.started`,
  `compaction.ended`, switches) insert `session_message` rows at the event's `seq`.
- Tool events update the owning assistant's tool part by `assistantMessageID` + `callID`
  (provider call IDs may repeat across turns, so settlement events carry the owning
  message).
- `prompt.admitted` only writes the inbox row; `prompted` marks it promoted (§3.2).
- V1 events maintain the `message`/`part` tables and session usage counters
  (`step-finish` parts add/subtract on part update/removal).
- `revert.committed` deletes `session_message` rows with `seq >` the boundary message's
  `seq` and `session_input` rows admitted or promoted after it.
- `SessionEvent.Retried` projection is commented out — the event has no producer today.
- The same reducer with the in-memory adapter (`SessionMessageUpdater.memory`) serves
  non-SQL consumers.

## 7. Revert and todos

- **Revert** (`session/revert.ts`, exposed as `SessionV2.revert.*`): `stage` captures
  (or reuses) a snapshot, plans per-file restore trees from assistant snapshots
  (`snapshot.start` + `files`) after the boundary message, restores files, publishes
  `session.next.revert.staged` (state stored on the `session` row). `clear` restores the
  staged files from the original snapshot and publishes `revert.cleared`. `commit`
  publishes `revert.committed`, whose projection truncates messages and inbox rows past
  the boundary (§6.4).
- **Todos** (`session/todo.ts`, Location-scoped): `update` replaces the session's todo
  rows transactionally then publishes live-only `todo.updated`; `get` reads ordered
  rows. Consumed by the V2 `todo`/`todowrite` tools.

## 8. Context epochs

### 8.1 Algebra (`system-context/index.ts`)

A `Source<A>` observes, compares (codec equivalence), and renders (baseline/update/
removed text) one typed value; `unavailable` marks temporary observation failure
without removal. `initialize` builds an immutable baseline + structured snapshot and
fails `InitializationBlocked` if any source is unavailable. `reconcile` returns
`Unchanged`, `Updated` (one chronological text + next snapshot), or escalates to
replacement (`Incompatible` snapshot or an unremovable disappeared source);
`replace` builds a fresh generation or blocks while a previously admitted source is
unavailable. Empty renders and duplicate keys are defects.

### 8.2 Session-owned persistence (`session/context-epoch.ts`, registry)

The runner composes Location registry sources (`SystemContextRegistry.load`, sorted by
key, concurrent) with selected-agent skill guidance and reference guidance, and:

- `initialize` (per turn, cheap existence check): create the epoch before any
  promotion when absent; `baseline_seq = EventV2.latestSequence`.
- `prepare` (when not freshly initialized): load current value + stored snapshot +
  latest compaction in parallel; `reconcile` normally; if a completed compaction is
  newer than `baseline_seq`, `replace` instead (fresh baseline at the compaction
  boundary). `Unchanged`/`ReplacementBlocked` keep the stored baseline;
  `ReplacementReady` rewrites the row; `Updated` publishes
  `session.next.context.updated` with a `commit` hook advancing the snapshot inside the
  event transaction. The update text becomes one durable chronological `system`
  message.
- Current built-ins (`system-context/builtins.ts`): environment block (directories,
  git status, platform) and the host-local date, registered under `core/builtins`.

### 8.3 History selection (`session/history.ts`)

Visible history = rows with `seq >=` latest `compaction` row's `seq` (when one exists),
plus `system` rows with `seq > baseline_seq` (chronological updates survive compaction;
after a replacement the new `baseline_seq` drops older ones). Non-system rows are never
filtered by `baseline_seq`. `load` derives `baseline_seq` from the table;
`entriesForRunner` takes the prepared value.

## 9. Compaction (`session/compaction.ts`)

### 9.1 Automatic (pressure) compaction

Before executing a pending turn, the runner estimates the serialized request
(`Token.estimate(JSON.stringify({system, messages, tools}))`) against
`context_window − max(output_allowance, buffer)`. When over budget and older complete
turns exist, `compactAfterOverflow` runs: select a keep-tail of recent serialized
messages within the configured keep tokens (older → head); build the anchored summary
prompt (with `<prior-summary>` merge instructions when a previous compaction exists);
stream one summary completion (empty toolset, capped output tokens);
publish `session.next.compaction.started` (`reason: "auto"`) and, only on a non-empty
successful summary, `compaction.ended` with `{ text: summary, recent }` — the only
event that projects a model-visible `compaction` message. Failure/empty/interruption
returns `false` and leaves the previous boundary active (a dangling `started` event
projects nothing). The turn then restarts (`ContinueAfterCompaction`) from rebuilt
history and a replaced epoch baseline (§8.2).

### 9.2 Overflow-triggered compaction

When the provider rejects the request as context overflow **before any durable
assistant output** (withheld error per §5.2), the runner attempts one
`compactAfterOverflow` even though the estimate passed. On success the logical turn is
rebuilt with exactly one remaining physical attempt: the recovery path runs without a
recovery function, and a second overflow dies with
`Post-compaction provider attempt cannot recover another overflow`. Overflow after
durable output, unavailable compaction, or a second failure is the ordinary terminal
failure; recovery never loops or replays side effects.

### 9.3 Configuration

From V2 config documents' `compaction` block, reduced in document order:

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `compaction.auto` | boolean | `true` | `false` disables pressure-triggered compaction entirely (§9.1) |
| `compaction.buffer` | positive integer tokens | `20000` (`DEFAULT_BUFFER`, fixed) | Headroom subtracted (with output allowance) from the context window in the pressure estimate |
| `compaction.keep.tokens` | positive integer tokens | `8000` (`DEFAULT_KEEP_TOKENS`, fixed) | Size of the serialized recent-context tail kept out of the summary |
| `TOOL_OUTPUT_MAX_CHARS` | `fixed` 2000 chars | — | Tool-result serialization truncation inside compaction serialization |
| `SUMMARY_OUTPUT_TOKENS` | `fixed` 4096 tokens | — | Cap for the summary completion's `maxTokens` (min with model output limit) |

## 10. V1 runtime boundary (`packages/opencode/src/session/*`)

The V1 engine remains the serving path for the instance HTTP API
(`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` calls
`SessionPrompt`):

- `Session` (`session.ts`): CRUD + message/part writes over the shared tables; all
  mutations are V1 events through `EventV2Bridge` (which stamps the instance Location).
  `messages` reads through `MessageV2.page`; `remove` cancels matching background jobs,
  recurses into children, publishes `session.deleted`, and drops the aggregate's event
  log. `fork` clones messages/parts into a new child session. `BusyError` guards
  concurrent prompts.
- `SessionRunState` (`run-state.ts`): per-instance `Runner` map — one logical runner
  per session with busy/idle status callbacks and interrupt finalization; `cancel`
  also cancels cascading background jobs.
- `SessionStatus` (`status.ts`): in-memory status map publishing `session.status.*`
  and `session.idle` events (bus-level, not durable session events).
- `SessionPrompt` (`prompt.ts`): `prompt()` creates the user message (V1 events),
  applies per-prompt tool permission overlays, then `loop()` → `runLoop()` under
  `ensureRunning`. The loop reloads compacted-filtered history each iteration, exits
  when the last assistant finished (non-tool-call finish parented to the last user),
  handles subtask/compaction parts and overflow-triggered compaction, resolves agent +
  tools + system context (skills/env/instructions/MCP), appends `MAX_STEPS_PROMPT` on
  the agent's last step, streams through `SessionProcessor`, and finalizes interrupted
  assistants with an `AbortError`. `shell` runs under `startShell` (busy-conflicting);
  `command` expands command templates.
- Per `AGENTS.md`, the V2 runner must **not** bridge through `SessionPrompt.loop` or
  delegate orchestration to the V1 in-memory loop; today the two engines are fully
  separate (V2 execution never calls into V1).

The V2 wiring is present in parallel: the instance server builds `SessionV2.node` with
`SessionExecutionLocal` (`httpapi/server.ts`) — currently consumed there by the
control-plane move-session handler — and the dedicated V2 server
(`packages/server/src/routes.ts` + `handlers/session.ts`) exposes the full
`/api/session/*` surface against `SessionV2`.

## 11. Errors

Typed error surface of the V2 facade (`packages/core/src/session.ts`):

- `Session.NotFoundError` — unknown sessionID (read/prompt/switch/revert paths).
- `Session.PromptConflictError` — message-ID reuse with differing session/prompt/delivery.
- `Session.OperationUnavailableError` — `shell`, `skill`, `compact`, `wait` stubs.
- `Session.MessageDecodeError` / `Session.ContextSnapshotDecodeError` — projection
  decode failures (`session/error.ts`).
- `SessionRunner.RunError` = `LLMError | SessionRunnerModel.Error | MessageDecodeError |
  ContextSnapshotDecodeError | SystemContext.InitializationBlocked |
  ToolOutputStore.Error` — surfaces through `SessionV2.resume` (wake-driven drains log
  instead).
- Revert adds `Session.MessageNotFoundError` and `Snapshot.Error`; move adds the
  `MoveSession.*` errors (§2.4).
- HTTP mapping (`packages/server/src/handlers/session.ts`): NotFound → 404,
  PromptConflict → 409 Conflict, OperationUnavailable → 503, decode failures → 500
  with a log reference.

Defects (die, not typed failures): `SessionInput.LifecycleConflict` (projector-side
inbox invariants), `SessionProjector.SessionAlreadyProjected` (handled only in
`create`), missing aggregate sequences on durable events, publisher state-machine
violations (duplicate/unordered fragments, tool name drift), `"Session not found"`
inside drains, `"Context Epoch not found"`, `SystemContext` empty-render/duplicate-key.
These represent invariant violations, not operator-recoverable conditions.

## 12. Invariants

- I1. One durable `seq` per `(sessionID, event)`; strictly increasing per aggregate;
  projectors and the `commit` hook run inside the allocating transaction.
- I2. `SessionV2.prompt` admits at most one `session_input` row per message ID; exact
  retry returns the original receipt; conflicting reuse fails typed.
- I3. A prompt becomes model-visible only via `session.next.prompted` published by the
  serialized runner; `promoted_seq` and the visible user message are written by the
  same event's projection.
- I4. Steers promote in admission order as one batch at a safe boundary; queued inputs
  promote one at a time, only when the drain would otherwise go idle.
- I5. Exactly one `llm.stream(request)` executes per provider turn; continuation
  happens only after reloading projected history.
- I6. Every complete local tool call is durably recorded (`tool.called`) before its
  side effects start; all started settlements are awaited before continuation.
- I7. Interrupted/abandoned tools never replay: they are failed durably at the next
  drain start (or at interruption) with preserved provider metadata.
- I8. Only `compaction.ended` projects a model-visible compaction message; a failed
  attempt leaves the previous boundary and baseline intact.
- I9. The epoch snapshot advances only atomically with the `context.updated` event
  (or a replacement write at a compaction boundary).
- I10. Durable replay/tail streams never emit live-only fragments; one cursor equals
  one persisted aggregate sequence.
- I11. Execution is process-local: `active` reflects only this process's drains and is
  empty after restart; interruption outside this process is impossible by construction.
- I12. Every `runTurnAttempt` is Location-fenced: a Session that moved away
  self-interrupts instead of executing in the wrong placement.

## 13. Stubs and known limitations (explicit in code)

- `SessionV2.shell`, `.skill`, `.compact`, `.wait` return `OperationUnavailableError`
  (manual compaction, shell/skill admission, and wait are unimplemented).
- `session.next.retried` has a schema and (commented-out) projection but no producer;
  provider retry/timeout policy is deferred by design (draft spec).
- `Step.Ended` publishes `cost: 0`; V2 turns do not accumulate session-level cost/tokens
  (only V1 `step-finish` parts maintain `session.cost`/`tokens_*`).
- `session.next.synthetic` and `session.next.shell.*` have schema + projection support
  but no runtime producers (tests only).
- Eager local-tool execution is intentionally unbounded per turn (latency-optimizing);
  per-turn call limits, output truncation policy, and backpressure are follow-ups.
- No durable busy/retrying/idle/interrupted markers; no stale-work rejection after
  runtime attachment replacement; no clustered execution ownership (single-process
  only).
- Streamed deltas are published per-chunk (no coalescing/buffering before projection
  rewrites).
- `to-llm-message.ts` TODO: provider-executed tool results with remote/managed URIs are
  rejected rather than materialized.
- `SessionV2.create` TODO: restoring recorded sessions onto replacement synchronized
  workspaces is a future API slice.
- `session.next.*` schemas remain experimental and unshipped; databases from earlier
  experimental builds are disposable, not compatibility targets.
- The runner's unchecked-slice checklist (ownership status, retry bounding, plugin
  transforms, per-prompt overrides, etc.) is tracked in the `runner/llm.ts` header
  comment and the parity table in `specs/v2/session.md`.

## 14. Divergences from AGENTS.md / draft specs (as-built)

1. **Session move does not clear the Context Epoch.** `specs/v2/session.md` states "A
   Session move clears the epoch so the destination Location initializes a complete
   baseline on its next run", and `SessionContextEpoch.reset` exists for exactly that —
   but it has no caller, and the `session.next.moved` projector only rewrites
   `directory`/`path`/`workspace_id`. After a move, the old baseline keeps applying
   until a replacement is triggered by other means. (Draft spec, so not a bug per the
   index status legend — but the code and the helper disagree with the documented
   intent.)
2. **No V1→V2 `Prompted` shadow bridge.** `specs/v2/session.md` claims "The V1-to-V2
   shadow bridge publishes the same `Prompted` event for already-visible V1 prompts".
   No such publication exists in the opencode package; `session.next.prompted` is
   published only by `SessionInput.publish` during V2 promotion (with lazy inbox
   synthesis for replayed `Prompted` events).
3. **`sessions.active()` semantics.** AGENTS.md and the draft describe active
   snapshots as foreground drains — code matches (coordinator entry set, runtime-only),
   including that wakes arriving after an interrupt arm successor drains (§4.2), a
   detail absent from both documents.
4. **Queue-vs-steer promotion order.** A `queue`-drain promotes the queued input first
   and then any steers admitted before the boundary (§3.3) — the documents describe
   the one-queued-at-a-idle-boundary rule but not that steers jump the remaining queue
   at that same boundary.

## Used by

- config-v2-session — intended-API and parity source for this as-built document.
- event-retention — pruning contract applied to the same durable event log.
