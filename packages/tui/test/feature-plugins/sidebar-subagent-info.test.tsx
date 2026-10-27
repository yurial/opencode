/** @jsxImportSource @opentui/solid */
// Tests for the subagent-info sidebar block (specs/tui-architecture.md R20,
// specs/tui-plugins.md): renders only for a viewed subagent session (the
// session has a parentID) and shows its title, agent, provider/model, and
// the live status from the session_status store.
import { describe, expect, test } from "bun:test"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import subagentInfo from "../../src/feature-plugins/sidebar/subagent-info"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { activateTuiPluginSlot } from "../fixture/tui-plugin"
import { renderTuiSlot } from "../fixture/tui-frame"

const META = {
  id: "internal:sidebar-subagent-info",
  source: "internal" as const,
  spec: "internal:sidebar-subagent-info",
  target: "internal:sidebar-subagent-info",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same" as const,
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses",
    slug: "ses",
    projectID: "proj",
    directory: "/",
    title: "Exploring the parser",
    agent: "general",
    model: { providerID: "anthropic", id: "claude-sonnet-4" },
    parentID: "ses_root",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
    ...overrides,
  }
}

// The store the block reads through api.state: the session by id and its
// live status; everything else of the plugin api stays fixture default.
type Store = {
  session?: Session
  status?: SessionStatus
}

async function renderBlock(store: Store) {
  const { sidebar } = await activateTuiPluginSlot(subagentInfo, {
    meta: META,
    state: {
      session: {
        get: (sessionID) => (sessionID === store.session?.id ? store.session : undefined),
        status: (sessionID) => (sessionID === store.session?.id ? store.status : undefined),
      },
    },
  })
  const result = await renderTuiSlot({
    slot: sidebar,
    sessionID: () => store.session?.id ?? "ses",
    width: 48,
    height: 12,
  })
  return result.frame
}

describe("sidebar subagent-info block", () => {
  test("registers as a builtin in the sidebar_content slot at order 50", async () => {
    const { registered } = await activateTuiPluginSlot(subagentInfo, { meta: META })

    expect(registered?.order).toBe(50)
    expect(typeof registered?.slots.sidebar_content).toBe("function")
    expect(registered?.slots.sidebar_content).toHaveLength(2)

    const builtin = createBuiltinPlugins({ experimentalEventSystem: false }).find(
      (candidate) => candidate.id === "internal:sidebar-subagent-info",
    )
    expect(builtin).toBeDefined()
    expect(builtin?.tui).toBe(subagentInfo.tui)
  })

  test("renders title, agent, model and a busy status for a subagent session", async () => {
    const frame = await renderBlock({ session: session(), status: { type: "busy" } })
    expect(frame).toContain("Subagent")
    expect(frame).toContain("Exploring the parser")
    expect(frame).toContain("Agent: general")
    expect(frame).toContain("Model: anthropic/claude-sonnet-4")
    expect(frame).toContain("Status: Running")
  })

  test("renders nothing for a root session (no parentID)", async () => {
    const frame = await renderBlock({ session: session({ parentID: undefined }), status: { type: "busy" } })
    expect(frame.trim()).toBe("")
  })

  test("renders nothing when the session is missing from the store", async () => {
    const frame = await renderBlock({ status: { type: "busy" } })
    expect(frame.trim()).toBe("")
  })

  test("reads a missing status as idle", async () => {
    const frame = await renderBlock({ session: session() })
    expect(frame).toContain("Status: Idle")
    expect(frame).not.toContain("Running")
  })

  test("renders the retry attempt from the status", async () => {
    const frame = await renderBlock({
      session: session(),
      status: { type: "retry", attempt: 2, message: "rate limited", next: 3 },
    })
    expect(frame).toContain("Status: Retrying (attempt 2)")
  })

  test("omits the agent and model rows when the session lacks them", async () => {
    const frame = await renderBlock({
      session: session({ agent: undefined, model: undefined }),
      status: { type: "idle" },
    })
    expect(frame).toContain("Subagent")
    expect(frame).toContain("Exploring the parser")
    expect(frame).not.toContain("Agent:")
    expect(frame).not.toContain("Model:")
    expect(frame).toContain("Status: Idle")
  })
})
