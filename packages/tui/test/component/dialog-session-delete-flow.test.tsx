/** @jsxImportSource @opentui/solid */
// Render-level coverage for the "/delete" flow in DialogSessionList: the
// deleteCurrentOnSwitch prop deletes the current session only after the user
// picks a different one, keeps the dialog open on a failed delete, and never
// deletes on cancel (picking the current session or closing).
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { PermissionProvider } from "../../src/context/permission"
import { ExitProvider } from "../../src/context/exit"
import { LocalProvider } from "../../src/context/local"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TuiConfigProvider } from "../../src/config"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import type { DialogSelectRef } from "../../src/ui/dialog-select"
import { DialogSessionList } from "../../src/component/dialog-session-list"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (true) {
    let ok = false
    try {
      ok = fn()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for condition: ${fn}`)
    await Bun.sleep(10)
  }
}

// LocalProvider reads its persisted state files (model.json, session.json)
// from paths.state and flips `ready` only after both reads settle; the files
// must exist up front, otherwise SyncProvider withholds its context from the
// subtree while local stays unready.
async function stateDir() {
  const state = await fs.mkdtemp(path.join("/tmp/opencode", "session-delete-flow-"))
  await Bun.write(path.join(state, "kv.json"), "{}")
  await Bun.write(path.join(state, "model.json"), "{}")
  await Bun.write(path.join(state, "session.json"), "{}")
  return state
}

const current = "ses_current"
const other = "ses_other"

function session(id: string, title: string) {
  return {
    id,
    title,
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    // A non-zero created time keeps the session visible to the SDK response
    // consumers in this harness (created: 0 was dropped by the server-side
    // start filter the sync context models).
    time: { created: 1, updated: 1 },
  }
}

const config = createTuiResolvedConfig()

// Mounts the full provider stack with the session list dialog open and returns
// handles for driving the harness: the dialog context (to observe the open
// dialog), the route context (to observe navigation), the recorded DELETE
// requests, and the keymap (to submit the dialog via its "return" binding).
async function mountDialog(input: { deleteCurrentOnSwitch?: boolean; deleteResponse?: Response }) {
  const state = await stateDir()
  const deletes: string[] = []
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session(current, "Current"), session(other, "Other")])
    return undefined
  }, events)
  const fetch = (async (req: RequestInfo | URL) => {
    const request = new Request(req)
    if (request.method === "DELETE" && request.url.includes("/session/")) {
      const id = new URL(request.url).pathname.split("/").at(-1)!
      deletes.push(id)
      return input.deleteResponse ?? new Response(null, { status: 200 })
    }
    return calls.fetch(request)
  }) as unknown as typeof globalThis.fetch


  let dialogCtx!: ReturnType<typeof useDialog>
  let routeCtx!: ReturnType<typeof useRoute>
  let optionsLength = () => 0

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID: current }}>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <DialogProvider>
                                  <Router />
                                </DialogProvider>
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
      </OpencodeKeymapProvider>
    )
  }

  function Router() {
    const dialog = useDialog()
    const route = useRoute()
    const sync = useSync()
    dialogCtx = dialog
    routeCtx = route
    optionsLength = () => sync.data.session.length
    onMount(() => {
      setTimeout(() => dialog.replace(() => <DialogSessionList deleteCurrentOnSwitch={input.deleteCurrentOnSwitch} />), 250)
    })
    return <box />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: state }}>
        <Harness />
      </TestTuiContexts>
    ),
    { width: 100, height: 30 },
  )

  await wait(() => dialogCtx !== undefined)
  await wait(() => optionsLength() > 0)
  // The open dialog binds "return" to "dialog.select.submit" and the arrows to
  // prev/next; the mock input drives them the same way a keypress would.
  return { app, dialog: dialogCtx, deletes, route: () => routeCtx, keys: app.mockInput }
}

test("deleting via selection removes the current session then switches", async () => {
  const harness = await mountDialog({ deleteCurrentOnSwitch: true })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    // Navigate to the other session row and submit with "return".
    harness.keys.pressArrow("down")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await wait(() => harness.deletes.length > 0)
    expect(harness.deletes).toEqual([current])
    await wait(() => harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === other)
    expect(harness.dialog.stack.length).toBe(0)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("a failed delete keeps the dialog open and does not switch", async () => {
  const harness = await mountDialog({
    deleteCurrentOnSwitch: true,
    deleteResponse: json({ message: "workspace busy" }, { status: 400 }),
  })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    harness.keys.pressArrow("down")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await wait(() => harness.deletes.length > 0)
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([current])
    // Still on the current session, dialog stays open for another pick or cancel.
    expect(harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === current).toBe(true)
    expect(harness.dialog.stack.length).toBe(1)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("picking the current session cancels the deletion", async () => {
  const harness = await mountDialog({ deleteCurrentOnSwitch: true })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    // The current session is preselected; submitting immediately must not
    // delete it.
    harness.keys.pressEnter()
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([])
    expect(harness.dialog.stack.length).toBe(0)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("plain session switching never deletes", async () => {
  const harness = await mountDialog({})
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    harness.keys.pressArrow("down")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([])
    expect(harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === other).toBe(true)
  } finally {
    harness.app.renderer.destroy()
  }
})
