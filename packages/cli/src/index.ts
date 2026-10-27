#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Daemon } from "./services/daemon"
import { exitGuard, mainTeardown } from "./exit-guard"

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  api: () => import("./commands/handlers/api"),
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
  },
  migrate: () => import("./commands/handlers/migrate"),
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    password: () => import("./commands/handlers/service/password"),
  },
  serve: () => import("./commands/handlers/serve"),
})

// The main fiber's completion does not terminate this process by itself:
// leaked TTY file descriptors and worker threads keep the event loop alive
// forever after a finished teardown (the attach-client zombie incident). The
// guard force-exits in the fiber teardown, and its backstop covers finalizers
// hanging after the command handler completed.
const guard = exitGuard({ exit: (code) => process.exit(code) })

NodeRuntime.runMain(
  Runtime.run(Commands, Handlers, { version: "local" }).pipe(
    Effect.provide(Daemon.layer),
    Effect.provide(NodeServices.layer),
    Effect.tap(() => Effect.sync(guard.arm)),
    Effect.scoped,
  ),
  {
    teardown: (exit, onExit) => mainTeardown(exit, onExit, guard.complete),
  },
)
