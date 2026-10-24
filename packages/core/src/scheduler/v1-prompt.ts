export * as SchedulerV1Prompt from "./v1-prompt"

import { Context, Effect, Schema } from "effect"
import { SessionSchema } from "../session/schema"

export class Error extends Schema.TaggedErrorClass<Error>()("SchedulerV1PromptError", {
  detail: Schema.String,
}) {}

/**
 * The V1 prompt admission path of the scheduler service (specs/scheduler.md
 * I4, R6.5): admits one synthetic user text part carrying the fired message
 * through the V1 prompt path of the owning session.
 *
 * Contract:
 * - `sessionID` names an existing session; `text` is the complete fired
 *   message (grammar fixed by the scheduler spec).
 * - Returns when the text has been admitted through the V1 prompt path; the
 *   model turn it starts may still be running.
 * - Fails with `Error` when admission is impossible (the session disappeared
 *   mid-delivery). The delivery loop treats every failure as a retryable
 *   delivery failure (R8.5); dead sessions are resolved before routing
 *   (R6.10), so this error channel is not the dead-session path.
 *
 * Core declares the capability; hosts provide the implementation because the
 * V1 prompt runtime lives above core. The capability is attached to the
 * scheduler service with `Scheduler.attachV1Prompt` rather than declared as a
 * scheduler dependency: the V1 prompt path depends on the tool registry,
 * which registers the scheduler tool — a scheduler dependency edge here would
 * close a layer cycle. Before an attach, a V1-routed fire fails and retries
 * (R8.5); processes without a V1 runtime attach nothing.
 */
export interface Interface {
  readonly prompt: (input: {
    readonly sessionID: SessionSchema.ID
    readonly text: string
  }) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SchedulerV1Prompt") {}
