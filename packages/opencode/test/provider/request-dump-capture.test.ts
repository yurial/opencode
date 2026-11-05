import { afterEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

// The recording server only counts hits: a capture model that reaches it
// means the dry-run leaked into the network transport.
async function recordingServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(500)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function streamUntilError(self: PromiseLike<{ stream: ReadableStream<unknown> }>) {
  return Effect.promise(async () => {
    try {
      const result = await self
      const reader = result.stream.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      return "stream-completed"
    } catch (error) {
      // openai-compatible doStream awaits the fetch, so the capture abort
      // surfaces as a doStream rejection rather than a stream error part.
      return error
    }
  })
}

it.live("capture model returns the serialized body without contacting the provider", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => recordingServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const capture = yield* provider.getCaptureLanguage(model)

          const outcome = yield* streamUntilError(
            capture.language.doStream({
              prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            }),
          )
          expect(outcome).not.toBe("stream-completed")

          const body = capture.takeBody()
          expect(body).toBeString()
          const parsed = JSON.parse(body!)
          expect(parsed.model).toBe("test-model")
          expect(parsed.stream).toBe(true)
          expect(Array.isArray(parsed.messages)).toBe(true)
          expect(parsed.messages.at(-1).role).toBe("user")
          expect(parsed.messages.at(-1).content).toBe("hello")
        }),
      { config: providerConfig(server.url) },
    )
  }),
)

it.live("capture models are independent and start with no captured body", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => recordingServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const first = yield* provider.getCaptureLanguage(model)
          const second = yield* provider.getCaptureLanguage(model)

          expect(first.language).not.toBe(second.language)
          expect(second.takeBody()).toBeUndefined()

          yield* streamUntilError(
            first.language.doStream({
              prompt: [{ role: "user", content: [{ type: "text", text: "only in the first capture" }] }],
            }),
          )
          expect(first.takeBody()).toBeString()
          expect(second.takeBody()).toBeUndefined()
        }),
      { config: providerConfig(server.url) },
    )
  }),
)
