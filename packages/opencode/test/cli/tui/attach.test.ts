import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { cliIt, opencodeRoot } from "../../lib/cli-process"

describe("tui attach", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("resolves the client working directory when --dir is absent", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()

    expect(source).toContain("Filesystem.resolve(process.env.PWD ?? process.cwd())")
  })

  cliIt.live(
    "sends the client working directory to the server when --dir is absent",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // The PWD override points at a directory outside the spawn cwd, so the
        // directory on the wire can only come from the client resolution. The
        // attached session.get is the only HTTP call before the TUI launches,
        // and the SDK carries its directory as a query field — that field is
        // the probe. The CLI runs from inside the workspace because dev-mode
        // resolution of the TUI import chain (react) only works there.
        const clientDirectory = `${home}/client-project`
        yield* Effect.promise(() => mkdir(clientDirectory, { recursive: true }))
        const recording = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const urls: URL[] = []
            const server = Bun.serve({
              port: 0,
              fetch: (request) => {
                urls.push(new URL(request.url))
                return Response.json(
                  { name: "NotFoundError", data: { message: "Session not found: ses_missing" } },
                  { status: 404 },
                )
              },
            })
            return { server, urls }
          }),
          (recording) => Effect.sync(() => recording.server.stop(true)),
        )

        const result = yield* opencode.spawn(
          ["attach", `http://localhost:${recording.server.port}`, "--session", "ses_missing"],
          { cwd: opencodeRoot, env: { PWD: clientDirectory }, timeoutMs: 30_000 },
        )

        expect(result.exitCode).not.toBe(0)
        const sent = recording.urls.flatMap((url) => [
          url.searchParams.get("directory"),
          url.searchParams.get("location[directory]"),
        ])
        expect(sent).toContain(clientDirectory)
      }),
    60_000,
  )
})
