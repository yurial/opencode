/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import path from "node:path"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { ExitProvider } from "../../src/context/exit"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { PermissionProvider } from "../../src/context/permission"
import { LocalProvider, useLocal } from "../../src/context/local"
import { ThemeProvider, useTheme, type ThemeSource } from "../../src/context/theme"
import { RouteProvider } from "../../src/context/route"
import { ToastProvider } from "../../src/ui/toast"
import { TuiConfigProvider } from "../../src/config"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function hex(rgba: RGBA) {
  return (
    "#" +
    rgba
      .toInts()
      .slice(0, 3)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
  )
}

// A v2 file overriding one rotation slot: agent.color.three recolors the third
// rotation color and every override naming that element (R39.2).
const agentV2Theme = {
  theme: {
    "agent.color.three": { fg: "#00ffff" },
  },
}

function agent(name: string, extra: Record<string, unknown> = {}) {
  return { name, mode: "primary", permission: {}, options: {}, ...extra }
}

// The ghost agent is hidden and must not consume a rotation slot: it sits
// between one and two, yet two stays the second rotation color (R39.1).
const agents = [
  agent("one"),
  agent("ghost", { hidden: true }),
  agent("two"),
  agent("hex", { color: "#FFA500" }),
  agent("elem", { color: "agent.color.three" }),
  agent("pale", { color: "accent" }),
  // Grammar-valid dotted name outside the closed catalog: neither an element
  // nor a palette name, so the rotation color applies instead of undefined.
  agent("dangling", { color: "agent.color.eight" }),
  agent("eight"),
]

const config = createTuiResolvedConfig()

function stateDir() {
  return path.join("/tmp/opencode", "tui-local-agent-color-test", crypto.randomUUID())
}

async function pollUntil(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeout) throw new Error("timed out waiting for local context")
    await Bun.sleep(20)
  }
}

test("agent color rotation and override resolution through the local context", async () => {
  const override: FetchHandler = (url) => {
    if (url.pathname === "/agent") return json(agents)
    return undefined
  }
  const calls = createFetch(override)
  const events = createEventSource()
  const source: ThemeSource = {
    discover: async () => ({ "agent-v2": agentV2Theme }),
  }

  let local!: ReturnType<typeof useLocal>
  let theme!: ReturnType<typeof useTheme>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    local = useLocal()
    theme = useTheme()
    onMount(() => ready())
    return <box />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: stateDir() }}>
        <ArgsProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <ThemeProvider mode="dark" source={source}>
                              <LocalProvider>
                                <Probe />
                              </LocalProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 20, height: 4 },
  )

  try {
    // testRender resolves before the provider tree mounts, so poll for the
    // context capture, theme readiness, and the agent sync.
    await pollUntil(() => !!local && !!theme && theme.ready && local.agent.list().length > 0)

    // R39.6 byte-identity: with the default built-in theme (a migrated v1
    // file) the rotation resolves exactly the flat palette values the pre-v2
    // implementation read.
    expect(local.agent.color("one")).toEqual(theme.theme.secondary)
    expect(local.agent.color("two")).toEqual(theme.theme.accent)
    expect(local.agent.color("eight")).toEqual(theme.theme.info)

    // The hidden agent consumed no slot: two is still the second color, and
    // the visible-index cycle wraps after seven.
    expect(local.agent.color("ghost")).toEqual(theme.theme.secondary)

    // Override paths against the default theme.
    expect(hex(local.agent.color("hex"))).toBe("#ffa500")
    expect(local.agent.color("elem")).toEqual(theme.theme.success)
    expect(local.agent.color("pale")).toEqual(theme.theme.accent)
    // Dangling element name falls back to that agent's rotation color
    // (visible index 5 -> the sixth slot).
    expect(local.agent.color("dangling")).toEqual(theme.theme.error)

    // A v2 theme overriding agent.color.three recolors the element override
    // (R39.4), the third rotation slot (R39.1), while palette and hex
    // overrides keep resolving against their own sources.
    expect(theme.set("agent-v2")).toBe(true)
    await pollUntil(() => hex(local.agent.color("elem")) === "#00ffff")

    expect(hex(local.agent.color("elem"))).toBe("#00ffff")
    expect(local.agent.color("two")).toEqual(theme.theme.accent)
    expect(local.agent.color("pale")).toEqual(theme.theme.accent)
    expect(hex(local.agent.color("hex"))).toBe("#ffa500")
    // The overridden slot three itself moved; its former default (success) no
    // longer paints it.
    expect(hex(local.agent.color("elem"))).not.toBe(hex(theme.theme.success))
  } finally {
    theme.unlock()
    theme.set("opencode")
    app.renderer.destroy()
  }
})
