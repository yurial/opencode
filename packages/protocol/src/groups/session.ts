import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Session } from "@opencode-ai/schema/session"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath, statics } from "@opencode-ai/schema/schema"
import { Workspace } from "@opencode-ai/schema/workspace"
import { Context, Effect, Encoding, Result, Schema, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Location } from "@opencode-ai/schema/location"
import { Revert } from "@opencode-ai/schema/revert"
import { SessionEvent } from "@opencode-ai/schema/session-event"

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

/**
 * One schedule of a session as the schedule-list endpoint returns it
 * (specs/scheduler-view.md Interface, R3.2): exactly the `sch_`-prefixed
 * schedule id, the stored spec variant, the stored message text, and the
 * stored next-due-time. `nextFireAt` and the one-shot `at` are integer UTC
 * epoch milliseconds (R3.4). Exactly one spec variant is present per entry,
 * mirroring the schedule-record invariant of specs/scheduler.md.
 */
export const SessionSchedule = Schema.Struct({
  id: Schema.String.annotate({ description: "The sch_-prefixed schedule id." }),
  spec: Schema.Union([
    Schema.Struct({ cron: Schema.String }).annotate({
      description: "The stored five-field cron spec of a recurring schedule.",
    }),
    Schema.Struct({ at: Schema.Int }).annotate({
      description: "The due time of a one-shot schedule as integer UTC epoch milliseconds.",
    }),
  ]).annotate({
    identifier: "SessionScheduleSpec",
    description: "The stored firing rule: a cron spec for a recurring schedule or a one-shot due time.",
  }),
  message: Schema.String.annotate({ description: "The stored message text delivered on fire." }),
  nextFireAt: Schema.Int.annotate({ description: "The stored next-due-time as integer UTC epoch milliseconds." }),
}).annotate({ identifier: "SessionSchedule" })
export type SessionSchedule = typeof SessionSchedule.Type

const SessionHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

export const SessionHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
          summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this OpenCode process. Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          prompt: PromptInput.Prompt,
          delivery: SessionInput.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description: "Compact a session conversation.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for session",
            description: "Wait for a session agent loop to become idle.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Revert.State }),
        error: [MessageNotFoundError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.context",
            summary: "Get session context",
            description: "Retrieve the active context messages for a session (all messages after the last compaction).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.history", "/api/session/:sessionID/history", {
        params: { sessionID: Session.ID },
        query: SessionHistoryQuery,
        success: Schema.Struct({
          data: Schema.Array(SessionEvent.Durable),
          hasMore: Schema.Boolean,
        }).annotate({ identifier: "SessionHistory" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.history",
            summary: "Get session history",
            description:
              "Read one finite page of public durable Session events after an exclusive aggregate sequence. Newly committed events may appear on later pages.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.events", "/api/session/:sessionID/event", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
        },
        success: HttpApiSchema.StreamSse({ data: SessionEvent.Durable }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.events",
            summary: "Subscribe to session events",
            description: "Replay durable events after an aggregate sequence, then continue with new durable events.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.interrupt",
            summary: "Interrupt session execution",
            description: "Interrupt active execution owned by this OpenCode process. Idle interruption is a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionMessage.Message }),
        error: [SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.message",
            summary: "Get session message",
            description: "Retrieve one projected message owned by the Session.",
          }),
        ),
    )
    .add(
      /**
       * The read-only schedule-list endpoint of specs/scheduler-view.md
       * (R3.1-R3.7, I3, I4). Returns every schedule bound to the path session
       * as SessionSchedule entries ordered by nextFireAt ascending, ties by id
       * ascending (R3.3). The endpoint mutates no schedule and asks no
       * permission (R3.5); the request carries no query parameters and no
       * payload. Errors (the complete set): an undecodable path session id or
       * a malformed request fails with InvalidRequestError (400, R3.7); a
       * request the server auth rejects fails with UnauthorizedError (401);
       * a path session id with no stored session row fails with
       * SessionNotFoundError (404, R3.6); an unexpected defect reaching the
       * handler fails with UnknownError (500) after logging with a
       * correlating ref. Every error is a final result of one request; the
       * route retries nothing and a client may reissue the GET.
       */
      HttpApiEndpoint.get("session.schedule.list", "/api/session/:sessionID/schedule", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionSchedule) }).annotate({
          identifier: "SessionScheduleList",
        }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.schedule.list",
            summary: "List session schedules",
            description:
              "Retrieve the schedules bound to a session, ordered by next fire time with ties ordered by id. Read-only: the endpoint mutates nothing and performs no permission ask.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessions",
        description: "Experimental session routes.",
      }),
    )
