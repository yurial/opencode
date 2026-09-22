import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, AgentSvc.node])))

it.instance(
  "agent color parsed from project config",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
      expect(cfg.agent?.["plan"]?.color).toBe("primary")
    }),
  {
    git: true,
    config: {
      agent: {
        build: { color: "#FFA500" },
        plan: { color: "primary" },
      },
    },
  },
)

it.instance(
  "Agent.get includes color from config",
  () =>
    Effect.gen(function* () {
      const plan = yield* AgentSvc.use.get("plan")
      expect(plan?.color).toBe("#A855F7")
      const build = yield* AgentSvc.use.get("build")
      expect(build?.color).toBe("accent")
    }),
  {
    git: true,
    config: {
      agent: {
        plan: { color: "#A855F7" },
        build: { color: "accent" },
      },
    },
  },
)

it.instance(
  "agent color accepts tui-theme element names alongside hex and palette names",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["review"]?.color).toBe("agent.color.two")
      expect(cfg.agent?.["docs"]?.color).toBe("#00FF00")
      expect(cfg.agent?.["plan"]?.color).toBe("success")
    }),
  {
    git: true,
    config: {
      agent: {
        review: { color: "agent.color.two" },
        docs: { color: "#00FF00" },
        plan: { color: "success" },
      },
    },
  },
)
