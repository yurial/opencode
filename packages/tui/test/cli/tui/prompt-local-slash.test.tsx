/** @jsxImportSource @opentui/solid */
// Regression coverage for typed local slash commands submitted from the home
// prompt: dispatching e.g. "/new" or "/sessions" must run the registered
// palette command without creating a session (the pre-fix behavior created an
// orphan session first and then navigated to it). A plain chat message still
// creates a session.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import type { PromptRef } from "../../../src/component/prompt"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { LocalProvider } from "../../../src/context/local"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider } from "../../../src/ui/dialog"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { TuiConfigProvider } from "../../../src/config"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PromptRefProvider } from "../../../src/context/prompt"
import { EditorContextProvider } from "../../../src/context/editor"
import { LocationProvider } from "../../../src/context/location"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { HomeSessionDestinationProvider } from "../../../src/routes/home/session-destination"
import { PluginRuntimeProvider, createPluginRuntime } from "../../../src/plugin/runtime"
import { Prompt } from "../../../src/component/prompt"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const agent = { name: "build", mode: "primary", permission: {}, options: {} }
const providers = {
  providers: [
    {
      id: "prov_test",
      name: "Test",
      source: "config" as const,
      env: [],
      options: {},
      models: { "model-a": { id: "model-a", name: "Model A" } },
    },
  ],
  default: { prov_test: "model-a" },
}
const providerDefault = { prov_test: "model-a" }

async function mountHomePrompt() {
  const stateDir = await (async () => {
    const dir = `/tmp/opencode/prompt-slash-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await Bun.write(`${dir}/kv.json`, "{}")
    // Seed the persisted recent-model pick: submit() requires a selected model.
    await Bun.write(`${dir}/model.json`, JSON.stringify({ recent: [{ providerID: "prov_test", modelID: "model-a" }] }))
    await Bun.write(`${dir}/session.json`, "{}")
    return dir
  })()

  const creates: string[] = []
  const dispatched: string[] = []
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname === "/agent") return json([agent])
    if (url.pathname === "/config/providers") return json(providers)
    if (url.pathname === "/provider") return json({ all: providers.providers, default: providerDefault, connected: [] })
    if (url.pathname === "/session")
      return json([
        {
          id: "ses_existing",
          title: "Existing",
          projectID: "proj_test",
          directory,
          version: "0.0.0-test",
          time: { created: 1, updated: 1 },
        },
      ])
    return undefined
  }, events)
  const fetch = (async (req: RequestInfo | URL) => {
    const request = new Request(req)
    if (request.method === "POST" && new URL(request.url).pathname === "/session") {
      creates.push(await request.text())
      return json({ id: `ses_created_${creates.length}` })
    }
    return base.fetch(request)
  }) as unknown as typeof globalThis.fetch

  const config = createTuiResolvedConfig()
  const pluginRuntime = createPluginRuntime()

  let ref: PromptRef | undefined
  let probeReady!: () => void
  const probe = new Promise<void>((resolve) => {
    probeReady = resolve
  })

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    // The two palette commands a typed slash can resolve, registered the way
    // app.tsx registers session.new / session.list.
    const offLayer = keymap.registerLayer({
      mode: OPENCODE_BASE_MODE,
      commands: [
        {
          name: "session.new",
          title: "New session",
          namespace: "palette",
          slashName: "new",
          slashAliases: ["clear"],
          run: () => {
            dispatched.push("session.new")
          },
        },
        {
          name: "session.list",
          title: "Switch session",
          namespace: "palette",
          slashName: "sessions",
          run: () => {
            dispatched.push("session.list")
          },
        },
      ],
    })
    onCleanup(() => {
      offLayer()
      offKeymap()
    })
    return (
      <TestTuiContexts paths={{ state: stateDir, cwd: directory }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "home" }}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                      <PluginRuntimeProvider value={pluginRuntime}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <LocalProvider>
                                      <ClipboardProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptStashProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider>
                                                    <LocationProvider>
                                                      <HomeSessionDestinationProvider>
                                                        <PromptProbe />
                                                      </HomeSessionDestinationProvider>
                                                    </LocationProvider>
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </PromptStashProvider>
                                          </FrecencyProvider>
                                        </DialogProvider>
                                      </ClipboardProvider>
                                    </LocalProvider>
                                  </ThemeProvider>
                                </DataProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </PluginRuntimeProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  function PromptProbe() {
    return (
      <box width={80} height={10}>
        <Prompt
          ref={(value) => {
            if (!value) return
            ref = value
            probeReady()
          }}
        />
      </box>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })

  await probe
  // Wait for the model fallback to resolve so submit() passes the model check.
  await Bun.sleep(200)
  return {
    app,
    type: async (text: string) => {
      for (const ch of text) {
        app.mockInput.pressKey(ch)
        await Bun.sleep(5)
      }
    },
    enter: () => app.mockInput.pressEnter(),
    input: () => ref!.current.input,
    creates,
    dispatched,
  }
}

test("typed /new from the home prompt dispatches locally without creating a session", async () => {
  const harness = await mountHomePrompt()
  try {
    await harness.type("/new ")
    await Bun.sleep(100)
    harness.enter()
    await Bun.sleep(300)
    expect(harness.dispatched).toEqual(["session.new"])
    expect(harness.creates).toEqual([])
  } finally {
    harness.app.renderer.destroy()
  }
})

test("typed /sessions from the home prompt opens the switcher without creating a session", async () => {
  const harness = await mountHomePrompt()
  try {
    // A trailing space keeps the slash autocomplete hidden (matching the
    // "typed past autocomplete" scenario) — dispatch must still resolve.
    await harness.type("/sessions ")
    await Bun.sleep(100)
    harness.enter()
    await Bun.sleep(300)
    expect(harness.dispatched).toEqual(["session.list"])
    expect(harness.creates).toEqual([])
  } finally {
    harness.app.renderer.destroy()
  }
})
