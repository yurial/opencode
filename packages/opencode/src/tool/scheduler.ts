import { Clock, Effect, Schema } from "effect"
import type { Scheduler as CoreScheduler } from "@opencode-ai/core/scheduler/scheduler"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { ScheduleID } from "@opencode-ai/core/scheduler/schema"
import { SchedulerMessage } from "@opencode-ai/core/scheduler/message"
import { SchedulerCron } from "@opencode-ai/core/scheduler/cron"
import { SchedulerAt } from "@opencode-ai/core/scheduler/at"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import * as Tool from "./tool"
import DESCRIPTION from "./scheduler.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "remove", "list"]).annotate({
    description: "The operation: add a schedule, remove one by id, or list this session's schedules",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "The message delivered into the session when the schedule fires (add only)",
  }),
  every: Schema.optional(Schema.String).annotate({
    description: "Interval firing rule: positive integer plus unit letter m, h, or d, for example 30m (add only)",
  }),
  cron: Schema.optional(Schema.String).annotate({
    description: "Standard five-field cron expression, evaluated in UTC (add only)",
  }),
  at: Schema.optional(Schema.String).annotate({
    description: "One-shot ISO 8601 datetime in the future; naive resolves in the local timezone (add only)",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "The schedule id to remove (remove only)",
  }),
})

type Metadata = {
  action: "add" | "remove" | "list"
  id?: string
  spec?: string
}

/**
 * Final error result of a failed scheduler tool call (specs/scheduler.md
 * Error handling). `code` is the error result identifier from the spec's
 * error table; the rendered message leads with the code so the model sees
 * the exact result name and can re-call with corrected arguments.
 */
class SchedulerToolError extends Schema.TaggedErrorClass<SchedulerToolError>()("SchedulerToolError", {
  code: Schema.Literals([
    "schedule-spec-conflict",
    "invalid-interval",
    "invalid-cron",
    "cron-without-future-match",
    "invalid-at",
    "at-in-past",
    "message-too-long",
    "schedule-cap-reached",
    "schedule-not-found",
    "permission-denied",
  ]),
  detail: Schema.String,
}) {
  override get message() {
    return `${this.code}: ${this.detail}`
  }
}

type Request = {
  permission: string
  patterns: readonly string[]
  always: readonly string[]
  metadata: { readonly [key: string]: unknown }
}

// The V1 ask flow surfaces a denied ask as a defect (ctx.ask is error-free);
// only a permission rejection maps to the permission-denied result, any other
// defect stays a defect.
const isPermissionRejection = (defect: unknown): boolean =>
  defect instanceof PermissionV1.DeniedError ||
  defect instanceof PermissionV1.RejectedError ||
  defect instanceof PermissionV1.CorrectedError

// Tool errors are terminal results of the call (the V1 contract gives
// execute no error channel), so every failure dies with its typed error.
const ask = Effect.fn("SchedulerTool.ask")(function* (ctx: Tool.Context<Metadata>, request: Request) {
  yield* ctx.ask(request).pipe(
    Effect.catchDefect((defect) =>
      isPermissionRejection(defect)
        ? permissionDenied()
        : Effect.die(defect),
    ),
  )
})

const permissionDenied = () => Effect.die(new SchedulerToolError({
  code: "permission-denied",
  detail: "the scheduler permission ask was denied",
}))

// Naive `at` values resolve in the process timezone at add time (R3.7).
const localOffsetAt = (time: number) => -new Date(time).getTimezoneOffset() * 60_000

const resolveSpec = Effect.fn("SchedulerTool.resolveSpec")(function* (params: {
  every?: string
  cron?: string
  at?: string
}, now: number) {
  if (params.every !== undefined) {
    const cron = SchedulerCron.fromEvery(params.every)
    if (cron === undefined) {
      return yield* Effect.die(
        new SchedulerToolError({
          code: "invalid-interval",
          detail: `${params.every} is not a positive integer followed by the unit letter m, h, or d`,
        }),
      )
    }
    return { cron }
  }
  if (params.cron !== undefined) {
    const expression = SchedulerCron.parse(params.cron)
    if (expression === undefined) {
      return yield* Effect.die(
        new SchedulerToolError({
          code: "invalid-cron",
          detail: `${params.cron} is not a standard five-field cron expression`,
        }),
      )
    }
    if (SchedulerCron.next(expression, now) === undefined) {
      return yield* Effect.die(
        new SchedulerToolError({
          code: "cron-without-future-match",
          detail: `${params.cron} never matches a future UTC instant`,
        }),
      )
    }
    return { cron: params.cron }
  }
  const at = SchedulerAt.parse(params.at!, localOffsetAt)
  if (at === undefined) {
    return yield* Effect.die(
      new SchedulerToolError({
        code: "invalid-at",
        detail: `${params.at} is not an ISO 8601 datetime`,
      }),
    )
  }
  if (at <= now) {
    return yield* Effect.die(
      new SchedulerToolError({
        code: "at-in-past",
        detail: `${SchedulerMessage.timestamp(at)} is not after the current time`,
      }),
    )
  }
  return { at }
})

/**
 * The `scheduler` tool (specs/scheduler.md R1): a V1 built-in under the V1
 * tool contract. Actions add, remove, and list (R1.2); args failing schema
 * decode fail with the tool wrapper's invalid-arguments error (R1.3). Add
 * and remove ask the `scheduler` permission before any side effect — the add
 * ask carries the spec form as its pattern, the remove ask the schedule id —
 * and list asks nothing (R5). Argument validation (R3) happens before the
 * ask; the row is stored or deleted only after the ask resolves (Error
 * handling). A denied ask fails with `permission-denied` and leaves state
 * untouched (R5.2).
 */
export const SchedulerTool = Tool.define<typeof Parameters, Metadata, CoreScheduler.Service>(
  "scheduler",
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const entries = yield* scheduler.list(ctx.sessionID)
            return {
              title: `${entries.length} ${entries.length === 1 ? "schedule" : "schedules"}`,
              metadata: { action: "list" as const },
              output: entries
                .map((entry) => SchedulerMessage.listed({ ...entry, spec: SchedulerMessage.spec(entry.spec) }))
                .join("\n"),
            }
          }

          if (params.action === "remove") {
            if (params.id === undefined || params.id.length === 0) {
              return yield* Effect.die(
                new Tool.InvalidArgumentsError({
                  tool: "scheduler",
                  detail: "action remove requires the id of the schedule to remove",
                }),
              )
            }
            yield* ask(ctx, {
              permission: "scheduler",
              patterns: [params.id],
              always: ["*"],
              metadata: { action: "remove", id: params.id },
            })
            const removed = yield* scheduler
              .remove({ sessionID: ctx.sessionID, id: ScheduleID.make(params.id) })
              .pipe(
                Effect.catch(() =>
                  Effect.die(
                    new SchedulerToolError({
                      code: "schedule-not-found",
                      detail: `no schedule ${params.id} is bound to this session`,
                    }),
                  ),
                ),
              )
            const specForm = SchedulerMessage.spec(removed.spec)
            return {
              title: `Removed ${removed.id}`,
              metadata: { action: "remove" as const, id: removed.id, spec: specForm },
              output: SchedulerMessage.removed(removed.id),
            }
          }

          const specs = [params.every, params.cron, params.at].filter((value) => value !== undefined)
          if (specs.length !== 1) {
            return yield* Effect.die(
              new SchedulerToolError({
                code: "schedule-spec-conflict",
                detail: "action add carries exactly one of every, cron, and at",
              }),
            )
          }
          if (params.message === undefined || params.message.length === 0) {
            return yield* Effect.die(
              new Tool.InvalidArgumentsError({
                tool: "scheduler",
                detail: "action add requires a non-empty message",
              }),
            )
          }
          if (params.message.length > Scheduler.MAX_MESSAGE_LENGTH) {
            return yield* Effect.die(
              new SchedulerToolError({
                code: "message-too-long",
                detail: `message exceeds the ${Scheduler.MAX_MESSAGE_LENGTH} character bound`,
              }),
            )
          }
          const spec = yield* resolveSpec(params, yield* Clock.currentTimeMillis)
          const specForm = SchedulerMessage.spec(spec)
          yield* ask(ctx, {
            permission: "scheduler",
            patterns: [specForm],
            always: ["*"],
            metadata: { action: "add", spec: specForm, message: params.message },
          })
          const added = yield* scheduler
            .add({ sessionID: ctx.sessionID, message: params.message, spec })
            .pipe(
              Effect.catch(() =>
                Effect.die(
                  new SchedulerToolError({
                    code: "schedule-cap-reached",
                    detail: `this session already holds ${Scheduler.MAX_SCHEDULES_PER_SESSION} schedules`,
                  }),
                ),
              ),
            )
          return {
            title: `Scheduled ${added.id}`,
            metadata: { action: "add" as const, id: added.id, spec: specForm },
            output: SchedulerMessage.added({ id: added.id, spec: specForm, nextFireAt: added.nextFireAt }),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
