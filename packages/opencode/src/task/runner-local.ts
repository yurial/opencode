export * as TaskRunnerLocal from "./runner-local"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { BackgroundJob } from "@/background/job"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"
import { Cause, Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { TaskEngine } from "@/task/engine"
import type { TaskPromptOps } from "@/tool/task"

/**
 * Host binding of the TaskRun continuation runner for processes with the V1
 * session runtime (specs/tool-task.md R5.7, I6).
 *
 * The TaskRun service is process-global while the V1 prompt path is
 * instance-scoped, so the runner resolves the parent session's location
 * through the session store (like SchedulerV1PromptLocal) and re-enters the
 * V1 runtime with that instance's ambient context via the instance store.
 * The continuation applies the same liveness decision tree as the task tool
 * by delegating to the shared task engine (J10).
 */
const layer = Layer.effect(
  TaskRun.Service,
  Effect.gen(function* () {
    const registry = yield* TaskRun.Service
    const store = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const engine = yield* TaskEngine.Service
    const agents = yield* Agent.Service
    const prompt = yield* SessionPrompt.Service
    const jobs = yield* BackgroundJob.Service

    const ops: TaskPromptOps = {
      cancel: (sessionID: SessionID) => prompt.cancel(sessionID),
      resolvePromptParts: (template) => prompt.resolvePromptParts(template),
      prompt: (input) => prompt.prompt(input).pipe(Effect.catch(Effect.die)),
    }

    const runner: TaskRun.Runner = {
      continue: (input) =>
        Effect.flatMap(store.get(input.parentSession), (parent) => {
          if (!parent) return Effect.die(`task run parent session not found: ${input.parentSession}`)
          return instances
            .provide(
              { directory: parent.location.directory },
              Effect.gen(function* () {
                const child = yield* store.get(input.runID)
                const next = yield* agents.get(child?.agent ?? "")
                if (!next) return yield* Effect.die(`task run agent not found: ${child?.agent}`)
                const model = next.model ?? (parent.model ? { providerID: parent.model.providerID, modelID: parent.model.id } : undefined)
                yield* engine.address({
                  ops,
                  parentSession: input.parentSession,
                  variant: parent.model?.variant,
                  runID: input.runID,
                  description: input.description,
                  agentName: next.name,
                  model,
                  useAgentModel: next.model !== undefined,
                  metadata: {
                    parentSessionId: input.parentSession,
                    sessionId: input.runID,
                    background: true,
                    jobId: input.runID,
                  },
                  prompt: input.message,
                })
              }),
            )
            .pipe(
              // A failed endpoint continuation is surfaced to the HTTP
              // boundary as a defect (UnknownError there), diagnosable through
              // the log — the caller only sees the resulting entry when the
              // continuation was actually applied.
              Effect.catchCause((cause) =>
                Effect.logError("TaskRun continuation failed", {
                  "session.id": input.runID,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.andThen(Effect.die(cause))),
              ),
            )
        }),
    }

    // The liveness reader resolves the run's owning instance through the
    // session store and reads that instance's live-job registry (R4.10,
    // R4.11) — status surfaces may run outside any ambient instance context,
    // so the reader establishes the context itself.
    yield* registry.attachLiveness({
      get: (runID) =>
        Effect.flatMap(store.get(runID), (session) => {
          if (!session) return Effect.succeed(undefined)
          return instances.provide({ directory: session.location.directory }, jobs.get(runID))
        }),
    })

    // A refused attach is logged by the core service (one process must hold
    // one runner); this node simply yields the registry either way.
    yield* registry.attachRunner(runner)
    return registry
  }),
)

export const node = makeGlobalNode({
  service: TaskRun.Service,
  layer,
  deps: [
    TaskRun.node,
    SessionStore.node,
    InstanceStore.node,
    SessionPrompt.node,
    TaskEngine.node,
    Agent.node,
    BackgroundJob.node,
  ],
})
