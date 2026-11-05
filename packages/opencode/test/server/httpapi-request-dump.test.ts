import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@/snapshot"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HttpClientResponse } from "effect/unstable/http"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "../../src/session/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Session.node, Database.node, FSUtil.node, Snapshot.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const modelRef = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Seeds rows directly through Session.Service — the same rows the prompt loop
// would leave behind, without running the loop itself.
const seedUser = Effect.fn("test.seedUser")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: modelRef.providerID, modelID: modelRef.modelID },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text,
  })
  return user
})

const seedAssistant = Effect.fn("test.seedAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  text: string,
) {
  const sessions = yield* Session.Service
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelRef.modelID,
    providerID: modelRef.providerID,
    time: { created: Date.now(), completed: Date.now() + 1 },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text,
  })
  return assistant
})

const rowCount = Effect.fn("test.rowCount")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const messages = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  const parts = yield* db
    .select({ id: PartTable.id })
    .from(PartTable)
    .where(eq(PartTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  return { messages: messages.length, parts: parts.length }
})

function requestDump(directory: string, payload: unknown) {
  return requestInDirectory(ExperimentalPaths.requestDump, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

function json<A>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as A))
}

function readFile(directory: string, relative: string) {
  return Effect.promise(() => Bun.file(path.join(directory, relative)).text())
}

describe("request dump HttpApi", () => {
  it.live(
    "dumps the last provider request without contacting the provider",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "dump" }).pipe(provideInstanceEffect(directory))
        // Two completed turns: the dump must replay the request that produced
        // the SECOND assistant — the projection strictly before it, which
        // still contains the first assistant exchange but not the second one.
        const firstUser = yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))
        yield* seedAssistant(chat.id, firstUser.id, "first reply").pipe(provideInstanceEffect(directory))
        const secondUser = yield* seedUser(chat.id, "second question").pipe(provideInstanceEffect(directory))
        const lastAssistant = yield* seedAssistant(chat.id, secondUser.id, "second reply").pipe(
          provideInstanceEffect(directory),
        )
        const before = yield* rowCount(chat.id).pipe(provideInstanceEffect(directory))
        expect(before).toEqual({ messages: 4, parts: 4 })

        const response = yield* requestDump(directory, { sessionID: chat.id, path: "dump/request.json" })
        expect(response.status).toBe(200)
        const result = yield* json<{ path: string; bytes: number }>(response)
        expect(result.path).toBe("dump/request.json")

        const body = yield* readFile(directory, "dump/request.json")
        const parsed = JSON.parse(body)
        expect(parsed.model).toBe("test-model")
        expect(parsed.stream).toBe(true)
        expect(Array.isArray(parsed.messages)).toBe(true)
        expect(parsed.messages).toHaveLength(4)
        expect(parsed.messages.at(-1).role).toBe("user")
        expect(parsed.messages.at(-1).content).toBe("second question")
        expect(parsed.messages.at(-2).role).toBe("assistant")
        expect(parsed.messages.at(-2).content).toBe("first reply")
        expect(parsed.messages[0].role).toBe("system")
        expect(parsed.messages[0].content).toContain("opencode")
        expect(result.bytes).toBe(Buffer.byteLength(body))
        expect(lastAssistant.id).toBeString()

        expect(yield* rowCount(chat.id).pipe(provideInstanceEffect(directory))).toEqual(before)
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "fails with BadRequest for a session without assistant rows",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "no assistant" }).pipe(provideInstanceEffect(directory))
        yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))

        const response = yield* requestDump(directory, { sessionID: chat.id, path: "dump/request.json" })
        expect(response.status).toBe(400)
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "fails with BadRequest for an unknown session",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

        const response = yield* requestDump(directory, { sessionID: SessionID.descending(), path: "dump/x.json" })
        expect(response.status).toBe(400)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "writes to an absolute path outside the workspace",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        // The dump target is a fresh tmp directory outside the workspace,
        // removed when the test scope closes. open(2) path semantics: an
        // absolute path is written as-is anywhere the server can write.
        const outside = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-dump-outside-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "outside" }).pipe(provideInstanceEffect(directory))
        const user = yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))
        yield* seedAssistant(chat.id, user.id, "hi there").pipe(provideInstanceEffect(directory))

        const target = path.join(outside, "dump.json")
        const response = yield* requestDump(directory, { sessionID: chat.id, path: target })
        expect(response.status).toBe(200)
        const result = yield* json<{ path: string; bytes: number }>(response)
        expect(result.path).toBe(target)
        const body = yield* Effect.promise(() => Bun.file(target).text())
        const parsed = JSON.parse(body)
        expect(parsed.model).toBe("test-model")
        expect(result.bytes).toBe(Buffer.byteLength(body))
        expect(result.bytes).toBeGreaterThan(0)
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "overwrites an existing dump file",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "overwrite" }).pipe(provideInstanceEffect(directory))
        const user = yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))
        yield* seedAssistant(chat.id, user.id, "hi there").pipe(provideInstanceEffect(directory))
        yield* Effect.promise(() => Bun.write(path.join(directory, "dump/request.json"), "sentinel"))

        const response = yield* requestDump(directory, { sessionID: chat.id, path: "dump/request.json" })
        expect(response.status).toBe(200)
        const body = yield* readFile(directory, "dump/request.json")
        expect(body).not.toBe("sentinel")
        expect(JSON.parse(body).model).toBe("test-model")
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "rejects a leading tilde path with BadRequest",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "leading tilde" }).pipe(provideInstanceEffect(directory))
        const user = yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))
        yield* seedAssistant(chat.id, user.id, "hi there").pipe(provideInstanceEffect(directory))

        const response = yield* requestDump(directory, { sessionID: chat.id, path: "~/x.json" })
        expect(response.status).toBe(400)
        // Rejected before any open(2) resolution: no file is created anywhere,
        // the workspace holds no tilde paths.
        const entries = yield* Effect.promise(() => fs.readdir(directory, { recursive: true }))
        expect(entries.filter((entry) => entry.includes("~"))).toEqual([])
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "rejects a mid-path tilde with BadRequest",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "mid tilde" }).pipe(provideInstanceEffect(directory))
        const user = yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))
        yield* seedAssistant(chat.id, user.id, "hi there").pipe(provideInstanceEffect(directory))

        const response = yield* requestDump(directory, { sessionID: chat.id, path: "dump/file~x.json" })
        expect(response.status).toBe(400)
        const entries = yield* Effect.promise(() => fs.readdir(directory, { recursive: true }))
        expect(entries.filter((entry) => entry.includes("~"))).toEqual([])
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )

  it.live(
    "rejects a bare ~ dump target with BadRequest",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "bare tilde" }).pipe(provideInstanceEffect(directory))
        const user = yield* seedUser(chat.id, "hello").pipe(provideInstanceEffect(directory))
        yield* seedAssistant(chat.id, user.id, "hi there").pipe(provideInstanceEffect(directory))

        const response = yield* requestDump(directory, { sessionID: chat.id, path: "~" })
        expect(response.status).toBe(400)
        const entries = yield* Effect.promise(() => fs.readdir(directory, { recursive: true }))
        expect(entries.filter((entry) => entry.includes("~"))).toEqual([])
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { timeout: 60_000 },
  )
})
