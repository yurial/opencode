export * as SchedulerV1PromptLocal from "./v1-prompt"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect, Layer } from "effect"
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
 * The capability is attached to the scheduler service at build time (see
 * Scheduler.attachV1Prompt for why this is an attach, not a dependency edge).
 * A missing session row fails — the delivery loop resolves dead sessions
 * before routing (R6.10), so this is the mid-delivery disappearance guard,
 * reported as a retryable delivery failure (R8.5).
 */
const layer = Layer.effect(
  SchedulerV1Prompt.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const scheduler = yield* Scheduler.Service

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
              prompt.prompt({
                sessionID: input.sessionID,
                parts: [{ type: "text", synthetic: true, text: input.text }],
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
