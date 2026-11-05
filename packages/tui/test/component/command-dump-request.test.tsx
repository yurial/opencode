/** @jsxImportSource @opentui/solid */
// Coverage for the session "Dump last request" palette command. Mounting the
// Session route would drag in the whole route/sync/event provider stack, so
// the harness registers the production-shaped command in the real keymap
// (command-palette-title.test.tsx pattern) and drives its run through the
// real DialogPrompt + DialogProvider stack against the real SDK client backed
// by the tui-sdk fetch fixture (dialog-prompt.test.tsx +
// dialog-session-delete-flow.test.tsx pattern). The fetch override stands in
// for the server endpoint; everything on the client side of the HTTP
// boundary is real.
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { TuiConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import {
  DialogPrompt,
} from "../../src/ui/dialog-prompt"
import { DialogProvider, useDialog, type DialogContext } from "../../src/ui/dialog"
import { ToastProvider, useToast, type ToastContext } from "../../src/ui/toast"
import { errorMessage } from "../../src/util/error"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap, type OpenTuiKeymap } from "../../src/keymap"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// The palette identity and run flow of the production sessionCommands entry
// (packages/tui/src/routes/session/index.tsx, "Dump last request").
const COMMAND_NAME = "session.dump_request"
const SESSION_ID = "ses_test"

type CommandEntry = ReturnType<OpenTuiKeymap["getCommandEntries"]>[number]
type DispatchResult = ReturnType<OpenTuiKeymap["dispatchCommand"]>

type Handle = {
  entry: () => CommandEntry | undefined
  dispatch: (name: string) => DispatchResult
  settled: () => Promise<unknown> | undefined
  dialog: DialogContext
  toast: ToastContext
}

// The dump endpoint of the tui-sdk fetch fixture: records the POST bodies and
// answers from the test-provided response (default: a successful dump).
function dumpFetch(input: { dumpResponse?: Response }, dumps: Array<{ sessionID: string; path: string }>) {
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname !== "/experimental/request-dump") return undefined
    return input.dumpResponse ?? json({ path: "request.json", bytes: 42 })
  }, events)
  const fetch = (async (req: RequestInfo | URL) => {
    const request = new Request(req)
    if (request.method === "POST" && new URL(request.url).pathname === "/experimental/request-dump") {
      dumps.push(await request.json())
    }
    return base.fetch(request)
  }) as unknown as typeof globalThis.fetch
  return { fetch, events }
}

async function mountCommand(input: { dumpResponse?: Response }) {
  const dumps: Array<{ sessionID: string; path: string }> = []
  const { fetch, events } = dumpFetch(input, dumps)
  let handle!: Handle

  // Registers the command once the dialog/toast/SDK contexts exist, exactly
  // like the Session component registers sessionCommands via useBindings.
  function Registrar() {
    const keymap = useOpencodeKeymap()
    const dialog = useDialog()
    const toast = useToast()
    const sdk = useSDK()
    onMount(() => {
      let run!: Promise<void>
      const command = {
        namespace: "palette" as const,
        name: COMMAND_NAME,
        title: "Dump last request",
        category: "Session",
        run: () => {
          run = (async (): Promise<void> => {
            const value = await DialogPrompt.show(dialog, "File path", {
              placeholder: "request.json",
            })
            if (value === null || value.trim() === "") return
            const result = await sdk.client.experimental.requestDump
              .create({
                experimentalRequestDumpPayload: { sessionID: SESSION_ID, path: value },
              })
              .catch((error: unknown) => {
                toast.show({
                  variant: "error",
                  message: error instanceof Error && error.message ? error.message : "Failed to dump request",
                  duration: 5000,
                })
                return undefined
              })
            if (!result) {
              dialog.clear()
              return
            }
            if (result.error || result.data === undefined) {
              toast.show({
                variant: "error",
                message: result.error ? errorMessage(result.error) : "Failed to dump request",
                duration: 5000,
              })
              dialog.clear()
              return
            }
            toast.show({ message: `Request dumped to ${result.data.path}`, variant: "success" })
            dialog.clear()
          })()
          return run
        },
      }
      keymap.registerLayer({ commands: [command] })
      handle = {
        entry: () =>
          keymap
            .getCommandEntries({ visibility: "active", namespace: "palette" })
            .find((item) => item.command.name === COMMAND_NAME),
        dispatch: (name: string) => keymap.dispatchCommand(name),
        settled: () => run,
        dialog,
        toast,
      }
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                  <DialogProvider>
                    <Registrar />
                  </DialogProvider>
                </SDKProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
      <Harness />
    </TestTuiContexts>
  ))
  await wait(() => handle !== undefined)
  return {
    app,
    dumps,
    ...handle,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("the dump request command is listed in the palette under its title", async () => {
  const harness = await mountCommand({})
  try {
    const entry = harness.entry()
    expect(entry).toBeDefined()
    expect(entry?.command.title).toBe("Dump last request")
    expect(entry?.command.category).toBe("Session")
    // Palette-only command: no slash alias, never hidden.
    expect(entry?.command.slashName).toBeUndefined()
    expect(entry?.command.hidden).toBeUndefined()
  } finally {
    await harness.cleanup()
  }
})

test("dispatching the command opens the file path prompt", async () => {
  const harness = await mountCommand({})
  try {
    harness.dispatch(COMMAND_NAME)
    await wait(() => harness.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(harness.dialog.stack.length).toBe(1)
  } finally {
    await harness.cleanup()
  }
})

test("canceling the prompt exits without calling the endpoint", async () => {
  const harness = await mountCommand({})
  try {
    harness.dispatch(COMMAND_NAME)
    await wait(() => harness.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    harness.app.mockInput.pressEscape()
    await harness.settled()
    expect(harness.dumps).toEqual([])
    expect(harness.toast.currentToast).toBeNull()
  } finally {
    await harness.cleanup()
  }
})

test("an empty path exits without calling the endpoint", async () => {
  const harness = await mountCommand({})
  try {
    harness.dispatch(COMMAND_NAME)
    await wait(() => harness.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    harness.app.mockInput.pressEnter()
    await harness.settled()
    expect(harness.dumps).toEqual([])
    expect(harness.toast.currentToast).toBeNull()
  } finally {
    await harness.cleanup()
  }
})

test("a submitted path dumps the request and toasts the saved file", async () => {
  const harness = await mountCommand({})
  try {
    harness.dispatch(COMMAND_NAME)
    await wait(() => harness.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await harness.app.mockInput.typeText("request.json")
    harness.app.mockInput.pressEnter()
    await harness.settled()
    expect(harness.dumps).toEqual([{ sessionID: SESSION_ID, path: "request.json" }])
    expect(harness.toast.currentToast?.variant).toBe("success")
    expect(harness.toast.currentToast?.message).toBe("Request dumped to request.json")
    expect(harness.dialog.stack.length).toBe(0)
  } finally {
    await harness.cleanup()
  }
})

test("a rejected dump toasts the server error and clears the dialog", async () => {
  const harness = await mountCommand({
    dumpResponse: json({ message: "no completed model turn" }, { status: 400 }),
  })
  try {
    harness.dispatch(COMMAND_NAME)
    await wait(() => harness.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await harness.app.mockInput.typeText("outside.json")
    harness.app.mockInput.pressEnter()
    await harness.settled()
    expect(harness.dumps).toEqual([{ sessionID: SESSION_ID, path: "outside.json" }])
    expect(harness.toast.currentToast?.variant).toBe("error")
    expect(harness.toast.currentToast?.message).toBe("no completed model turn")
    expect(harness.dialog.stack.length).toBe(0)
  } finally {
    await harness.cleanup()
  }
})
