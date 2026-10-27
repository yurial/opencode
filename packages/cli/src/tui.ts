import { run } from "@opencode-ai/tui"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Effect, Layer, Logger, References } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Logging } from "@opencode-ai/core/observability/logging"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"

// No Effect file logger is installed anywhere else in the new-CLI process
// (D-1): open the shared opencode.log channel for the TUI graph here. This is
// deliberately not the server's full Observability layer — no OTLP tracing,
// no HTTP client, just the file channel at the shared minimum log level.
const fileLogLayer = Logger.layer([Logging.fileLogger()]).pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
)

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  return run({
    ...transport,
    args: {},
    config,
    fetch: gracefulFetch,
    pluginHost: {
      async start() {},
      async dispose() {},
    },
  }).pipe(Effect.provide(fileLogLayer), Effect.provide(AppNodeBuilder.build(Global.node)))
}

const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

const gracefulFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)
    if (response.status !== 404) return response
    const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]
    if (fallback === undefined) return response
    return Response.json(fallback)
  },
  { preconnect: fetch.preconnect },
)
