import { SessionV2 } from "@opencode-ai/core/session"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor, SessionTask } from "@opencode-ai/protocol/groups/session"
import {
  ConflictError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  TaskNotFoundError,
  UnknownError,
} from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/core/schema"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

// A storage or continuation defect is surfaced as the declared UnknownError
// with a correlating ref (specs/tool-task.md Error handling).
function unknownDefect(log: string, sessionID: string, defect: unknown) {
  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
  return Effect.logError(log).pipe(
    Effect.annotateLogs({ ref, sessionID, cause: defect }),
    Effect.andThen(
      Effect.fail(new UnknownError({ message: `Unexpected server error. Check server logs for details. [${String(defect).slice(0, 300)}]`, ref })),
    ),
  )
}

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const scheduler = yield* Scheduler.Service
    const taskRun = yield* TaskRun.Service

    // The status surfaces report the derived state of a run (specs/tool-task.md
    // R5.4): the registry read applies the host liveness reader — a run with
    // a live job reads running, a stored running row without one reads
    // interrupted; the read mutates no row.
    const taskEntry = (row: TaskRun.Entry) => ({
      id: row.id,
      description: row.description,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      settledAt: row.settledAt,
    })

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
      .handle(
        "session.schedule.list",
        Effect.fn(function* (ctx) {
          const entries = yield* scheduler.list(ctx.params.sessionID).pipe(
            // The scheduler's read has no typed failure channel; a storage
            // defect is the one failure mode left, surfaced as the declared
            // UnknownError with a correlating ref (specs/scheduler-view.md
            // Error handling).
            Effect.catchDefect((defect) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to list session schedules").pipe(
                Effect.annotateLogs({ ref, sessionID: ctx.params.sessionID, cause: defect }),
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                  ),
                ),
              )
            }),
          )
          return {
            // specs/scheduler-view.md Interface (E3): the response carries the
            // entries inside the {data: {schedules: [...]}} envelope. R3.3
            // (I3): the scheduler's own list orders by id only; the entries
            // re-order by nextFireAt ascending with the id ascending as the
            // tiebreak. R3.2: every entry carries name — the stored display
            // name, null for a legacy schedule created before the field
            // existed (R3.8) — and command — the stored gate-command text,
            // null when the schedule stores none.
            data: {
              schedules: [...entries]
                .sort((a, b) => a.nextFireAt - b.nextFireAt || (a.id < b.id ? -1 : 1))
                .map((entry) => ({
                  id: entry.id,
                  spec: entry.spec,
                  name: entry.name,
                  message: entry.message,
                  nextFireAt: entry.nextFireAt,
                  command: entry.command,
                })),
            },
          }
        }),
      )
      .handle(
        "session.task.list",
        Effect.fn(function* (ctx) {
          const rows = yield* taskRun.list(ctx.params.sessionID).pipe(
            // A storage defect is the one failure mode left, surfaced as the
            // declared UnknownError with a correlating ref (specs/tool-task.md
            // Error handling).
            Effect.catchDefect((defect) => unknownDefect("failed to list session tasks", ctx.params.sessionID, defect)),
          )
          return {
            // R5.5: one task-run entry per run of the path session; the
            // registry orders newest launch first with id-ascending ties.
            data: { tasks: rows.map(taskEntry) },
          }
        }),
      )
      .handle(
        "session.task.get",
        Effect.fn(function* (ctx) {
          const row = yield* taskRun.get(ctx.params.sessionID, ctx.params.taskID).pipe(
            Effect.catchDefect((defect) => unknownDefect("failed to read session task", ctx.params.sessionID, defect)),
          )
          if (!row) {
            return yield* new TaskNotFoundError({
              sessionID: ctx.params.sessionID,
              taskID: ctx.params.taskID,
              message: `Task not found: ${ctx.params.taskID} was not launched by session ${ctx.params.sessionID}`,
            })
          }
          return { data: taskEntry(row) }
        }),
      )
      .handle(
        "session.task.continue",
        Effect.fn(function* (ctx) {
          const row = yield* taskRun
            .continue({
              sessionID: ctx.params.sessionID,
              taskID: ctx.params.taskID,
              message: ctx.payload.message,
            })
            .pipe(
              // R5.12: a path task id resolving to no run of the path session
              // fails with TaskNotFoundError and performed nothing.
              Effect.catchTag("TaskRun.NotFound", (error) =>
                Effect.fail(
                  new TaskNotFoundError({
                    sessionID: error.sessionID,
                    taskID: error.taskID,
                    message: `Task not found: ${error.taskID} was not launched by session ${error.sessionID}`,
                  }),
                ),
              ),
              // The host runner's ordinary continuation failures (for example
              // the run's agent no longer resolving) surface as the declared
              // UnknownError with a correlating ref, like defects do. Tagged
              // errors are declared results (the TaskNotFoundError above) and
              // must pass through untouched.
              Effect.catchIf(
                (error): error is Error => error instanceof Error && !("_tag" in error),
                (error) => unknownDefect("failed to continue session task", ctx.params.sessionID, error),
              ),
              Effect.catchDefect((defect) =>
                unknownDefect("failed to continue session task", ctx.params.sessionID, defect),
              ),
            )
          // R5.7: the response is the resulting running entry — a live job
          // reads running from the live-job registry, a continuation was
          // re-marked running before its prompt was admitted.
          return { data: taskEntry(row) }
        }),
      )
  }),
)
