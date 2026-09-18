import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { ConfigInteractive } from "@opencode-ai/core/config/interactive"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { InteractiveJob } from "@opencode-ai/core/tool/interactive/job"
import { InteractiveSpool } from "@opencode-ai/core/tool/interactive/spool"
import path from "path"
import { configLayer } from "./fixture/config"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const withSpool = <A, E, R>(
  body: (input: { spool: InteractiveSpool.Interface; jobID: InteractiveJob.ID; dataDir: string }) => Effect.Effect<A, E, R>,
  interactive?: ConfigInteractive.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const graph = AppNodeBuilder.build(LayerNode.group([InteractiveSpool.node, FSUtil.node]), [
        [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })))],
        [Global.node, Global.layerWith({ data: tmp.path })],
        [Config.node, configLayer(interactive ? { interactive } : {})],
      ])
      return Effect.gen(function* () {
        return yield* body({
          spool: yield* InteractiveSpool.Service,
          jobID: InteractiveJob.ID.create(),
          dataDir: tmp.path,
        })
      }).pipe(Effect.provide(graph))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const bytes = (text: string) => new TextEncoder().encode(text)
const wide = { maxLines: 10_000, maxBytes: 1_000_000 }

const it = testEffect(Layer.empty)

describe("InteractiveSpool", () => {
  it.live("open creates the managed spool file under tool-output with the job prefix", () =>
    withSpool(({ spool, jobID, dataDir }) =>
      Effect.gen(function* () {
        const outputPath = yield* spool.open(jobID)
        expect(outputPath.startsWith(path.join(dataDir, "tool-output", "tool_ijob_"))).toBe(true)
        const whole = yield* spool.slice(jobID, 0, undefined, wide)
        expect(whole.text).toBe("")
        expect(whole.nextCursor).toBe(0)
      }),
    ))

  it.live("append stores the combined output and slice reads it back", () =>
    withSpool(({ spool, jobID }) =>
      Effect.gen(function* () {
        yield* spool.open(jobID)
        const appended = yield* spool.append(jobID, bytes("gdb banner\n> "))
        expect(appended).toEqual({ bytesStored: 13, capped: false, totalBytes: 13 })

        const whole = yield* spool.slice(jobID, 0, undefined, wide)
        expect(whole.text).toBe("gdb banner\n> ")
        expect(whole.truncated).toBe(false)
        expect(whole.nextCursor).toBe(13)

        const tail = yield* spool.slice(jobID, 4, undefined, wide)
        expect(tail.text).toBe("banner\n> ")
      }),
    ))

  it.live("slice bounds by limits and advances nextCursor to the stored end past elided bytes", () =>
    withSpool(({ spool, jobID }) =>
      Effect.gen(function* () {
        const content = "one\ntwo\nthree\nfour\nfive\n"
        yield* spool.open(jobID)
        yield* spool.append(jobID, bytes(content))

        const byteCut = yield* spool.slice(jobID, 0, undefined, { maxLines: 10_000, maxBytes: 8 })
        expect(byteCut.truncated).toBe(true)
        expect(byteCut.text.length).toBeLessThanOrEqual(8)
        expect(content.startsWith(byteCut.text)).toBe(true)
        expect(byteCut.nextCursor).toBe(content.length)

        const lineCut = yield* spool.slice(jobID, byteCut.nextCursor, undefined, { maxLines: 2, maxBytes: 1_000_000 })
        expect(lineCut.truncated).toBe(true)
        expect(lineCut.text.split("\n").filter((line) => line !== "").length).toBeLessThanOrEqual(2)
        expect(content.startsWith(lineCut.text)).toBe(true)
        expect(lineCut.nextCursor).toBe(content.length)

        const rest = yield* spool.slice(jobID, 8, undefined, wide)
        expect(rest.text).toBe("three\nfour\nfive\n")
        expect(rest.truncated).toBe(false)
        expect(rest.nextCursor).toBe(content.length)
      }),
    ))

  it.live("append stops storing past interactive.max_spool_bytes and reports capped", () =>
    withSpool(
      ({ spool, jobID }) =>
        Effect.gen(function* () {
          yield* spool.open(jobID)
          expect(yield* spool.append(jobID, bytes("0123456789"))).toEqual({
            bytesStored: 10,
            capped: false,
            totalBytes: 10,
          })
          expect(yield* spool.append(jobID, bytes("ABCDEFGHIJ"))).toEqual({
            bytesStored: 6,
            capped: true,
            totalBytes: 16,
          })
          expect(yield* spool.append(jobID, bytes("tail"))).toEqual({ bytesStored: 0, capped: true, totalBytes: 16 })

          const whole = yield* spool.slice(jobID, 0, undefined, wide)
          expect(whole.text).toBe("0123456789ABCDEF")
          expect(whole.nextCursor).toBe(16)
        }),
      new ConfigInteractive.Info({ max_spool_bytes: 16 }),
    ))
})
