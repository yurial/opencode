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

// A 200 response whose body stays open until released, keeping the DELETE
// request in flight so a second Enter can race it.
function pendingResponse() {
  let release!: () => void
  const done = new Promise<void>((resolve) => (release = resolve))
  const response = new Response(
    new ReadableStream({
      start(controller) {
        void done.then(() => controller.close())
      },
    }),
    { status: 200 },
  )
  return { response, release }
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
async function mountDialog(input: {
  deleteCurrentOnSwitch?: boolean
  deleteResponse?: Response
  onDelete?: (id: string) => Response | Promise<Response>
}) {
  const state = await stateDir()
  const deletes: string[] = []
  const exits: string[] = []
  const events = createEventSource()
  // "hideCurrent" lets a test drop the current session from the list endpoint,
  // modeling "the current session disappeared while the dialog was open".
  let hideCurrent = false
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json(hideCurrent ? [session(other, "Other")] : [session(current, "Current"), session(other, "Other")])
    return undefined
  }, events)
  const fetch = (async (req: RequestInfo | URL) => {
    const request = new Request(req)
    if (request.method === "DELETE" && request.url.includes("/session/")) {
      const id = new URL(request.url).pathname.split("/").at(-1)!
      deletes.push(id)
      if (input.onDelete) return input.onDelete(id)
      return input.deleteResponse ?? new Response(null, { status: 200 })
    }
    if (request.method === "GET" && request.url.includes("/session?")) return calls.fetch(request)
    return calls.fetch(request)
  }) as unknown as typeof globalThis.fetch

  let dialogCtx!: ReturnType<typeof useDialog>
  let routeCtx!: ReturnType<typeof useRoute>
  let syncCtx!: ReturnType<typeof useSync>
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
                        <ExitProvider exit={() => exits.push("exit")}>
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
    syncCtx = sync
    optionsLength = () => sync.data.session.length
    onMount(() => {
      setTimeout(
        () => dialog.replace(() => <DialogSessionList deleteCurrentOnSwitch={input.deleteCurrentOnSwitch} />),
        250,
      )
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
  return {
    app,
    dialog: dialogCtx,
    deletes,
    exits,
    events,
    route: () => routeCtx,
    sync: () => syncCtx,
    keys: app.mockInput,
    // Flips the list endpoint to stop reporting the current session.
    hideCurrent: () => {
      hideCurrent = true
    },
  }
}

// Collects the text of every rendered text node so tests can assert which
// rows the open dialog actually shows.
function frameText(node: unknown): string {
  const renderable = node as { getChildren?: () => unknown[]; plainText?: unknown }
  const children = renderable.getChildren?.() ?? []
  const own = typeof renderable.plainText === "string" ? `${renderable.plainText}\n` : ""
  return own + children.map(frameText).join("")
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
    await wait(
      () =>
        harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === other,
    )
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
    expect(
      harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === current,
    ).toBe(true)
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
    expect(
      harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === other,
    ).toBe(true)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("the /delete dialog offers New and Delete and exit above the session list", async () => {
  const harness = await mountDialog({ deleteCurrentOnSwitch: true })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    const text = frameText(harness.app.renderer.root)
    expect(text).toContain("New")
    expect(text).toContain("Delete and exit")
  } finally {
    harness.app.renderer.destroy()
  }
})

test("New deletes the current session and navigates home", async () => {
  const harness = await mountDialog({ deleteCurrentOnSwitch: true })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    // From the preselected current-session row, two steps up land on "New"
    // (the first of the two action entries above the list).
    harness.keys.pressArrow("up")
    await Bun.sleep(30)
    harness.keys.pressArrow("up")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await wait(() => harness.deletes.length > 0)
    expect(harness.deletes).toEqual([current])
    await wait(() => harness.route().data.type === "home")
    expect(harness.dialog.stack.length).toBe(0)
    expect(harness.exits).toEqual([])
  } finally {
    harness.app.renderer.destroy()
  }
})

test("Delete and exit deletes the current session and exits the app", async () => {
  const harness = await mountDialog({ deleteCurrentOnSwitch: true })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    // One step up from the preselected current-session row lands on
    // "Delete and exit", the second action entry.
    harness.keys.pressArrow("up")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await wait(() => harness.deletes.length > 0)
    expect(harness.deletes).toEqual([current])
    await wait(() => harness.exits.length > 0)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("a failed delete from New keeps the dialog open without navigating or exiting", async () => {
  const harness = await mountDialog({
    deleteCurrentOnSwitch: true,
    deleteResponse: json({ message: "workspace busy" }, { status: 400 }),
  })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    harness.keys.pressArrow("up")
    await Bun.sleep(30)
    harness.keys.pressArrow("up")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await wait(() => harness.deletes.length > 0)
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([current])
    // Still on the current session, dialog stays open, the app did not exit.
    expect(
      harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === current,
    ).toBe(true)
    expect(harness.dialog.stack.length).toBe(1)
    expect(harness.exits).toEqual([])
  } finally {
    harness.app.renderer.destroy()
  }
})

test("plain /sessions offers neither New nor Delete and exit", async () => {
  const harness = await mountDialog({})
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    const text = frameText(harness.app.renderer.root)
    expect(text).toContain("Current")
    expect(text).not.toContain("New")
    expect(text).not.toContain("Delete and exit")
    // From the current row, one step down lands on the row right after it;
    // in plain mode that is a regular session, never an action entry.
    harness.keys.pressArrow("down")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([])
    expect(harness.exits).toEqual([])
    expect(
      harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === other,
    ).toBe(true)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("New and Delete and exit still work when the current session is gone", async () => {
  // The current session disappears (deleted elsewhere) while the /delete
  // dialog stays open: both action entries must degrade to their plain
  // purpose instead of navigating to the sentinel value as a session ID.
  const harness = await mountDialog({ deleteCurrentOnSwitch: true })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    // Model the session disappearing while the dialog stays open: the list
    // endpoint stops reporting the session and the "session.deleted" event
    // fires, so the dialog resolves with no current session.
    harness.hideCurrent()
    await Bun.sleep(100)
    await harness
      .sync()
      .session.refresh()
      .catch(() => {})
    expect(harness.sync().data.session.some((item: { id: string }) => item.id === current)).toBe(false)
    harness.events.emit({
      id: "evt-1",
      directory,
      payload: {
        id: "evt-1",
        type: "session.deleted",
        properties: { sessionID: current, info: session(current, "Current") },
      },
    } as never)
    // The app-level "session.deleted" handler navigates home when the current
    // session is deleted; mirror that so the dialog's current session is gone.
    harness.route().navigate({ type: "home" })
    await Bun.sleep(100)
    // With no current-session row the initial selection may not sit on "New";
    // wrap to the top explicitly (home binding) before submitting.
    harness.keys.pressKey("home", {})
    await Bun.sleep(50)
    harness.keys.pressEnter()
    await Bun.sleep(200)
    expect(harness.deletes).toEqual([])
    expect(harness.exits).toEqual([])
    expect(harness.dialog.stack.length).toBe(0)

    // Reopen for "Delete and exit": it must exit without any DELETE.
    harness.dialog.replace(() => <DialogSessionList deleteCurrentOnSwitch={true} />)
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    harness.keys.pressKey("home", {})
    await Bun.sleep(50)
    harness.keys.pressArrow("down")
    await Bun.sleep(50)
    harness.keys.pressEnter()
    await wait(() => harness.exits.length > 0)
    expect(harness.deletes).toEqual([])
    expect(harness.exits).toEqual(["exit"])
  } finally {
    harness.app.renderer.destroy()
  }
})

test("a second Enter while the delete request is in flight fires no second DELETE", async () => {
  const gate = pendingResponse()
  const harness = await mountDialog({
    deleteCurrentOnSwitch: true,
    onDelete: () => gate.response,
  })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    harness.keys.pressArrow("down")
    await Bun.sleep(30)
    // Double-Enter: the second press lands while the first DELETE is still
    // waiting on the (held-open) response.
    harness.keys.pressEnter()
    await wait(() => harness.deletes.length > 0)
    harness.keys.pressEnter()
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([current])

    gate.release()
    await wait(
      () =>
        harness.route().data.type === "session" && (harness.route().data as { sessionID: string }).sessionID === other,
    )
    // The guard reset after success, but the dialog is closed and no further
    // request was queued while it was in flight.
    expect(harness.deletes).toEqual([current])
    expect(harness.dialog.stack.length).toBe(0)
  } finally {
    harness.app.renderer.destroy()
  }
})

test("after a failed delete a retry is still possible", async () => {
  let attempts = 0
  const harness = await mountDialog({
    deleteCurrentOnSwitch: true,
    onDelete: () => {
      attempts++
      return json({ message: "workspace busy" }, { status: 400 })
    },
  })
  try {
    await wait(() => harness.dialog.stack.length > 0)
    await Bun.sleep(100)
    harness.keys.pressArrow("down")
    await Bun.sleep(30)
    harness.keys.pressEnter()
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([current])
    expect(harness.dialog.stack.length).toBe(1)

    // The in-flight guard reset on failure: a second pick of the same session
    // reaches the server again.
    harness.keys.pressEnter()
    await Bun.sleep(50)
    expect(harness.deletes).toEqual([current, current])
    expect(attempts).toBe(2)
  } finally {
    harness.app.renderer.destroy()
  }
})
