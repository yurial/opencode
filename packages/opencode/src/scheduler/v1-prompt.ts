export * as SchedulerV1PromptLocal from "./v1-prompt"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Cause, Effect, Layer, Scope } from "effect"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { SchedulerV1Prompt } from "@opencode-ai/core/scheduler/v1-prompt"
import { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"

/**
 * Host binding of the scheduler's V1 prompt admission path for processes
 * with the V1 session runtime (specs/scheduler.md I4, R6.5).
 *
 * The scheduler service is process-global while the V1 prompt path is
 * instance-scoped, so admission resolves the owning session's location
 * through the session store (like SessionExecutionLocal) and re-enters the
 * V1 runtime with that instance's ambient context via the instance store.
 *
 * Admission and the model turn are detached: `prompt` returns once the
 * synthetic user part is durably admitted (the SchedulerV1Prompt.Interface
 * contract — "the model turn it starts may still be running"), and the turn
 * runs in a fiber forked into the layer scope. The scheduler's delivery loop
 * must never wait for the turn: the fired turn can call the scheduler tool,
 * whose mutations serialize on the delivery loop's write permit, so a turn
 * awaited by the loop would deadlock it. A missing session row fails — the
 * delivery loop resolves dead sessions before routing (R6.10), so this is
 * the mid-delivery disappearance guard, reported as a retryable delivery
 * failure (R8.5).
 */
const layer = Layer.effect(
  SchedulerV1Prompt.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const scheduler = yield* Scheduler.Service
    const scope = yield* Scope.Scope

    const v1Prompt = SchedulerV1Prompt.Service.of({
      prompt: (input) =>
        Effect.flatMap(store.get(input.sessionID), (session) => {
          if (!session) {
            return Effect.fail(
              new SchedulerV1Prompt.Error({ detail: `session not found: ${input.sessionID}` }),
            )
          }
          return instances
            .provide(
              { directory: session.location.directory },
              Effect.gen(function* () {
                // Admission only: the synthetic part becomes a durable user
                // message; the loop call below runs the model turn.
                yield* prompt.prompt({
                  sessionID: input.sessionID,
                  parts: [{ type: "text", synthetic: true, text: input.text }],
                  noReply: true,
                })
                yield* prompt.loop({ sessionID: input.sessionID }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Scheduler-fired V1 turn failed", {
                      "session.id": input.sessionID,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                  Effect.forkIn(scope, { startImmediately: true }),
                )
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.fail(new SchedulerV1Prompt.Error({ detail: String(cause) })),
              ),
              Effect.asVoid,
            )
        }),
    })
    yield* scheduler.attachV1Prompt(v1Prompt)
    return v1Prompt
  }),
)

export const node = makeGlobalNode({
  service: SchedulerV1Prompt.Service,
  layer,
  deps: [SessionStore.node, InstanceStore.node, SessionPrompt.node, Scheduler.node],
})
