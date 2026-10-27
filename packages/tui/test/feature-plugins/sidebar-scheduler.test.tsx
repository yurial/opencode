/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createSignal } from "solid-js"
import type { AssistantMessage, Message, Part, SessionSchedule } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import scheduler from "../../src/feature-plugins/sidebar/scheduler"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { createSlots } from "../../src/plugin/slots"
import { createTuiPluginApi } from "../fixture/tui-plugin"

// Every data assertion below flows through the mock on the only permitted
// boundary — the SDK client of the plugin api (R4.3); the TuiState accessors
// the harness supplies exist solely as the scheduler-tool-part observation
// channel of I6, never as a schedule data source.

const T0 = Date.parse("2026-10-25T12:00:00Z")

let seq = 0

function user(id: string): Message {
  return { id, sessionID: "ses", role: "user", agent: "build", model: { providerID: "p", modelID: "m" }, time: { created: 1 } }
}

function assistant(id: string): AssistantMessage {
  const message = {
    id,
    sessionID: "ses",
    role: "assistant" as const,
    time: { created: 1 },
    parentID: "msg_u",
    modelID: "m",
    providerID: "p",
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  return message as AssistantMessage
}

function toolPart(messageID: string, tool: string): Part {
  return {
    id: `part-${++seq}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID: `call-${seq}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function textPart(messageID: string): Part {
  return { id: `part-${++seq}`, sessionID: "ses", messageID, type: "text", text: "hello" }
}

function entry(
  id: string,
  spec: SessionSchedule["spec"],
  nextFireAt: number,
  message: string,
  command: string | null = null,
): SessionSchedule {
  return { id, spec, message, nextFireAt, command }
}

// The scheduler-view/eta-clock of the block under test: a mutable reading
// the test advances instead of waiting for wall time (R4.12).
function clockFixture(start: number) {
  let now = start
  return {
    etaClock: () => now,
    advance: (to: number) => {
      now = to
    },
  }
}

const META = {
  id: "internal:sidebar-scheduler",
  source: "internal" as const,
  spec: "internal:sidebar-scheduler",
  target: "internal:sidebar-scheduler",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same" as const,
}

// SDK-client boundary mock: records every schedule-list call and answers
// from the test-provided responder; a thrown responder models a failed
// fetch (transport, status, and decode failures look alike to the block).
function clientFixture(calls: string[], respond: (sessionID: string) => unknown) {
  return {
    v2: {
      session: {
        schedule: {
          list: (input: { sessionID: string }) => {
            calls.push(input.sessionID)
            try {
              // The awaited result wraps the HTTP body as {data: body}; the
              // responder supplies the body — the {data: {schedules}}
              // envelope of the schedule-list endpoint. The body is
              // re-parsed per call, so every response carries fresh object
              // references like the real client.
              const body = respond(input.sessionID)
              return Promise.resolve({ data: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) })
            } catch (cause) {
              return Promise.reject(cause)
            }
          },
        },
      },
    },
  }
}

type Harness = {
  frame: () => string
  render: () => Promise<void>
  dispose: () => void
  destroy: () => void
}

// Activates the plugin against a captured slots.register and mounts the
// registered sidebar_content slot, mirroring the host flow in
// packages/opencode/src/plugin/tui/runtime.ts. The session id and the
// message list arrive as reactive getters so tests can fire the refetch
// triggers of R4.8 and R4.9 without remounting.
async function mount(opts: {
  client: unknown
  calls: string[]
  options?: Record<string, unknown>
  sessionID?: () => string
  messages?: () => Message[]
  parts?: (messageID: string) => Part[]
}): Promise<Harness> {
  let view: ((ctx: unknown, props: { session_id: string }) => JSX.Element) | undefined
  const disposes: Array<() => void> = []
  const base = createTuiPluginApi()
  const api = {
    ...base,
    client: opts.client,
    state: {
      ...base.state,
      session: {
        ...base.state.session,
        messages: (sessionID: string) => opts.messages?.() ?? [],
      },
      part: (messageID: string) => opts.parts?.(messageID) ?? [],
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: () => void) => {
        disposes.push(fn)
        return () => {}
      },
    },
    slots: {
      register(plugin: { slots: Record<string, unknown> }) {
        view = plugin.slots.sidebar_content as (ctx: unknown, props: { session_id: string }) => JSX.Element
        return "internal:sidebar-scheduler"
      },
    },
  } as unknown as TuiPluginApi

  await scheduler.tui(api, opts.options, META)
  if (!view) throw new Error("sidebar_content slot was not registered")

  const session = opts.sessionID ?? (() => "ses")
  const app = await testRender(() => view!({ theme: undefined }, { get session_id() { return session() } }), {
    width: 160,
    height: 24,
  })
  const render = async () => {
    await app.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
  }
  await render()
  return {
    frame: () => app.captureCharFrame(),
    render,
    dispose: () => disposes.forEach((fn) => fn()),
    destroy: () => app.renderer.destroy(),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Mounts the block through the real host slot machinery — createSlots, the
// same createSolidSlotRegistry/createSlot path the session sidebar renders
// with (packages/tui/src/plugin/slots.tsx) — instead of calling the slot
// renderer directly. The remount storm of R4.7 lives in that render loop:
// the slot re-invokes the entry renderer whenever the block's reactive root
// changes, remounting the View and resetting its entries. The direct-mount
// tests above bypass the loop and cannot observe it.
async function mountViaSlot(opts: {
  client: unknown
  options?: Record<string, unknown>
  sessionID?: () => string
  messages?: () => Message[]
  parts?: (messageID: string) => Part[]
}): Promise<Harness> {
  const runtime = createSlots()
  const base = createTuiPluginApi()
  const disposes: Array<() => void> = []
  const api = {
    ...base,
    client: opts.client,
    // A renderer stand-in: the slot registry only keys its store by the
    // renderer instance and hooks its destroy event.
    renderer: { once() {} },
    state: {
      ...base.state,
      session: {
        ...base.state.session,
        messages: (sessionID: string) => opts.messages?.() ?? [],
      },
      part: (messageID: string) => opts.parts?.(messageID) ?? [],
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: () => void) => {
        disposes.push(fn)
        return () => {}
      },
    },
  } as unknown as TuiPluginApi
  api.slots = {
    register(plugin: { id?: string; order?: number; slots: Record<string, unknown> }) {
      // The host wrapper (packages/opencode/src/plugin/tui/runtime.ts) owns
      // the registry id and returns it; the fixture fixes both the same way.
      const fixed = { ...plugin, id: plugin.id ?? "internal:sidebar-scheduler" }
      runtime.setup(api).register(fixed)
      return fixed.id
    },
  }

  await scheduler.tui(api, opts.options, META)

  const session = opts.sessionID ?? (() => "ses")
  const app = await testRender(
    () => runtime.Slot({ name: "sidebar_content", get session_id() { return session() } }),
    { width: 160, height: 24 },
  )
  const render = async () => {
    await app.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
  }
  await render()
  return {
    frame: () => app.captureCharFrame(),
    render,
    dispose: () => disposes.forEach((fn) => fn()),
    destroy: () => app.renderer.destroy(),
  }
}

describe("sidebar schedules block", () => {
  test("registers as a builtin in the sidebar_content slot at order 450 (T4.1, R4.1, R4.2)", async () => {
    let registered: { order: number; slots: Record<string, unknown> } | undefined
    const base = createTuiPluginApi()
    const api = {
      ...base,
      slots: {
        register(plugin: { order: number; slots: Record<string, unknown> }) {
          registered = plugin
          return "internal:sidebar-scheduler"
        },
      },
    } as unknown as TuiPluginApi
    await scheduler.tui(api, undefined, META)

    expect(registered?.order).toBe(450)
    expect(typeof registered?.slots.sidebar_content).toBe("function")
    expect(registered?.slots.sidebar_content).toHaveLength(2)

    const builtin = createBuiltinPlugins({ experimentalEventSystem: false }).find(
      (candidate) => candidate.id === "internal:sidebar-scheduler",
    )
    expect(builtin).toBeDefined()
    expect(builtin?.tui).toBe(scheduler.tui)
  })

  test("renders the header and both E4 entry lines verbatim, cron and one-shot spec forms (T4.3, R4.4, R4.5, E4)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [
      entry("sch_once", { at: 1792937100000 }, 1792937100000, "deploy check"),
      entry("sch_rel", { cron: "0 0 * * *" }, 1792972800000, "daily digest"),
    ]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock },
    })
    try {
      const frame = harness.frame()
      expect(frame).toContain("Schedules")
      expect(frame).toContain("in 2h 05m (2026-10-25T14:05:00Z) sch_once (2026-10-25T14:05:00Z): deploy check")
      expect(frame).toContain("in 12h 00m (2026-10-26T00:00:00Z) sch_rel (0 0 * * *): daily digest")
      // Server order stands (R3.3 upstream; the block never re-sorts).
      expect(frame.indexOf("sch_once")).toBeLessThan(frame.indexOf("sch_rel"))
      expect(calls).toEqual(["ses"])
    } finally {
      harness.destroy()
    }
  })

  test("marks gate entries: the marker rides the id only when command is non-null (T4.13, R4.4, E4.4)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [
      // E4.4 verbatim: a third entry with a non-null `command` at the same
      // due time as `sch_rel`.
      entry("sch_gate", { cron: "0 9 * * 1" }, 1792972800000, "standup prep", "test -f /repo/done.flag"),
      entry("sch_rel", { cron: "0 0 * * *" }, 1792972800000, "daily digest"),
      // A gated entry whose message fills the bound exactly, and one past
      // the bound: the marker must not consume the 60-unit message budget.
      entry("sch_full", { cron: "0 9 * * 1" }, 1792972800000, "e".repeat(60), "make check"),
      entry("sch_cut", { cron: "0 9 * * 1" }, 1792972800000, "m".repeat(100), "make check"),
    ]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock },
    })
    try {
      const frame = harness.frame()
      // Non-null `command`: the marker appends directly after the schedule id.
      expect(frame).toContain("in 12h 00m (2026-10-26T00:00:00Z) sch_gate* (0 9 * * 1): standup prep")
      expect(frame).not.toContain("sch_gate (0 9 * * 1)")
      // Null `command`: no marker, the line keeps its exact former shape.
      expect(frame).toContain("in 12h 00m (2026-10-26T00:00:00Z) sch_rel (0 0 * * *): daily digest")
      expect(frame).not.toContain("sch_rel*")
      // The shortened-message budget counts the message alone: exactly sixty
      // units stay untruncated behind the marker, one hundred truncate to
      // sixty plus the ellipsis.
      expect(frame).toContain(`sch_full* (0 9 * * 1): ${"e".repeat(60)}`)
      expect(frame).not.toContain(`${"e".repeat(60)}…`)
      expect(frame).toContain(`sch_cut* (0 9 * * 1): ${"m".repeat(60)}…`)
      expect(frame).not.toContain("m".repeat(61))
    } finally {
      harness.destroy()
    }
  })

  test("keeps the delivered order even when it looks unsorted (T4.3, R3.3)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    // The server orders by next fire time; the block renders in delivery
    // order, so a response listed z-before-a stays z-before-a.
    const schedules = [
      entry("sch_z", { cron: "5 * * * *" }, T0 + 5 * 3_600_000, "later"),
      entry("sch_a", { at: T0 + 2 * 3_600_000 }, T0 + 2 * 3_600_000, "sooner"),
    ]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock },
    })
    try {
      const frame = harness.frame()
      expect(frame.indexOf("sch_z")).toBeLessThan(frame.indexOf("sch_a"))
    } finally {
      harness.destroy()
    }
  })

  test("derives eta and absolute from the eta-clock at render time (T4.10, R2.2, R2.3, R2.4, R4.12)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [
      entry("sch_due_now", { cron: "* * * * *" }, T0, "due exactly now"),
      entry("sch_overdue", { cron: "* * * * *" }, T0 - 60_000, "overdue"),
      entry("sch_seconds", { cron: "* * * * *" }, T0 + 45_000, "within a minute"),
      entry("sch_hours", { cron: "* * * * *" }, T0 + 2 * 3_600_000 + 5 * 60_000, "hours ahead"),
      entry("sch_days", { cron: "0 0 * * *" }, T0 + 50 * 3_600_000, "day crossing"),
    ]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock, refreshIntervalMs: 15 },
    })
    try {
      const frame = harness.frame()
      expect(frame).toContain("now (2026-10-25T12:00:00Z) sch_due_now")
      expect(frame).toContain("now (2026-10-25T11:59:00Z) sch_overdue")
      expect(frame).toContain("in 45s (2026-10-25T12:00:45Z) sch_seconds")
      expect(frame).toContain("in 2h 05m (2026-10-25T14:05:00Z) sch_hours")
      expect(frame).toContain("in 50h 00m (2026-10-27T14:00:00Z) sch_days")

      // The eta re-derives from the clock on the next render after a
      // refetch: advancing the clock past the due instant turns the line
      // into `now`.
      clock.advance(T0 + 2 * 3_600_000 + 5 * 60_000)
      await sleep(70)
      await harness.render()
      expect(harness.frame()).toContain("now (2026-10-25T14:05:00Z) sch_hours")
    } finally {
      harness.destroy()
    }
  })

  test("shortens messages: whitespace runs collapse, bound is 60 with ellipsis (T4.4, R4.6, E4.6)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const long = "m".repeat(100)
    const exact = "e".repeat(60)
    const schedules = [
      entry("sch_long", { cron: "* * * * *" }, T0 + 3_600_000, long),
      entry("sch_exact", { cron: "* * * * *" }, T0 + 3_600_000, exact),
      entry("sch_spaces", { cron: "* * * * *" }, T0 + 3_600_000, "deploy\nthe\treport  now"),
    ]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock },
    })
    try {
      const frame = harness.frame()
      // One hundred characters render as the first sixty plus the ellipsis.
      expect(frame).toContain(`${"m".repeat(60)}…`)
      expect(frame).not.toContain("m".repeat(61))
      // Exactly sixty characters stay untruncated, without an ellipsis.
      expect(frame).toContain(`sch_exact (* * * * *): ${exact}`)
      expect(frame).not.toContain(`${exact}…`)
      // Whitespace runs — newline, tab, blanks — collapse to single spaces.
      expect(frame).toContain("sch_spaces (* * * * *): deploy the report now")
    } finally {
      harness.destroy()
    }
  })

  test("renders nothing for an empty schedule list (T4.5, R4.7)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules: [] } })),
      calls,
      options: { etaClock: clock.etaClock },
    })
    try {
      expect(harness.frame().trim()).toBe("")
    } finally {
      harness.destroy()
    }
  })

  test("refetches when the current session changes (T4.6, R4.8)", async () => {
    const clock = clockFixture(T0)
    const [sessionID, setSessionID] = createSignal("ses_a")
    const calls: string[] = []
    const bySession = new Map<string, SessionSchedule[]>([
      ["ses_a", [entry("sch_in_a", { cron: "* * * * *" }, T0 + 3_600_000, "session a schedule")]],
      ["ses_b", [entry("sch_in_b", { cron: "* * * * *" }, T0 + 3_600_000, "session b schedule")]],
    ])
    const harness = await mount({
      client: clientFixture(calls, (session) => ({ data: { schedules: bySession.get(session) ?? [] } })),
      calls,
      options: { etaClock: clock.etaClock },
      sessionID: () => sessionID(),
    })
    try {
      expect(calls).toEqual(["ses_a"])
      expect(harness.frame()).toContain("sch_in_a")

      setSessionID("ses_b")
      await harness.render()
      expect(calls).toEqual(["ses_a", "ses_b"])
      const frame = harness.frame()
      expect(frame).toContain("sch_in_b")
      expect(frame).not.toContain("sch_in_a")
    } finally {
      harness.destroy()
    }
  })

  test("drops a stale response that resolves after the session changed (R4.8, R4.13)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    // The first response, for ses_a, is held back until the test releases
    // it — a controlled slow client stands in for a slow schedule-list
    // round trip.
    let releaseSlow: ((value: unknown) => void) | undefined
    const stale = new Promise<unknown>((resolve) => {
      releaseSlow = resolve
    })
    const schedulesB = [entry("sch_in_b", { cron: "* * * * *" }, T0 + 3_600_000, "session b schedule")]
    const schedulesA = [entry("sch_in_a", { cron: "* * * * *" }, T0 + 3_600_000, "session a schedule")]
    const client = {
      v2: {
        session: {
          schedule: {
            list: (input: { sessionID: string }) => {
              calls.push(input.sessionID)
              if (input.sessionID === "ses_a") return stale
              return Promise.resolve({ data: { data: { schedules: schedulesB } } })
            },
          },
        },
      },
    }
    const [sessionID, setSessionID] = createSignal("ses_a")
    const harness = await mount({
      client,
      calls,
      options: { etaClock: clock.etaClock },
      sessionID: () => sessionID(),
    })
    try {
      // The first fetch for ses_a is still pending: the block stays hidden.
      expect(calls).toEqual(["ses_a"])
      expect(harness.frame().trim()).toBe("")

      // Switching the session refetches for ses_b, which answers at once.
      setSessionID("ses_b")
      await harness.render()
      expect(calls).toEqual(["ses_a", "ses_b"])
      expect(harness.frame()).toContain("sch_in_b")

      // The held-back ses_a response resolves after the switch: an answer
      // for a session that is no longer current must not overwrite the
      // entries of the session on screen.
      releaseSlow?.({ data: { data: { schedules: schedulesA } } })
      await sleep(50)
      await harness.render()
      const frame = harness.frame()
      expect(frame).toContain("sch_in_b")
      expect(frame).not.toContain("sch_in_a")
    } finally {
      harness.destroy()
    }
  })

  test("refetches when a scheduler tool part is observed; other tools and part removals do not trigger (T4.7, R4.9, I6)", async () => {
    const clock = clockFixture(T0)
    const [messages, setMessages] = createSignal<Message[]>([])
    const calls: string[] = []
    let schedules: SessionSchedule[] = []
    const partsByMessage = new Map<string, Part[]>()

    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock },
      messages: () => messages(),
      parts: (messageID) => partsByMessage.get(messageID) ?? [],
    })
    try {
      // Before any scheduler part the block fetched once and hides.
      expect(calls).toEqual(["ses"])
      expect(harness.frame().trim()).toBe("")

      // A newly observed scheduler tool part in the current session refetches.
      schedules = [entry("sch_new", { cron: "* * * * *" }, T0 + 3_600_000, "fresh schedule")]
      const msg = assistant("msg_a")
      partsByMessage.set("msg_a", [toolPart("msg_a", "scheduler")])
      setMessages([user("msg_u"), msg])
      await harness.render()
      expect(calls).toEqual(["ses", "ses"])
      expect(harness.frame()).toContain("sch_new")

      // An unrelated tool part is no trigger.
      const other = assistant("msg_b")
      partsByMessage.set("msg_b", [toolPart("msg_b", "read")])
      setMessages([user("msg_u"), msg, other])
      await harness.render()
      expect(calls).toEqual(["ses", "ses"])

      // The scheduler part going away is no trigger either.
      partsByMessage.set("msg_a", [textPart("msg_a")])
      await harness.render()
      expect(calls).toEqual(["ses", "ses"])
    } finally {
      harness.destroy()
    }
  })

  test("refetches on every interval expiry (T4.8, R4.10)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [entry("sch_periodic", { cron: "* * * * *" }, T0 + 3_600_000, "periodic")]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock, refreshIntervalMs: 15 },
    })
    try {
      // The mount window may already swallow one short-interval tick; the
      // mount fetch itself is always the first call.
      expect(calls[0]).toBe("ses")
      await sleep(100)
      expect(calls.length).toBeGreaterThan(2)
      expect(harness.frame()).toContain("sch_periodic")
    } finally {
      harness.destroy()
    }
  })

  test("falls back to the spec-fixed interval for invalid injected values", async () => {
    const calls: string[] = []
    const schedules = [entry("sch_default", { cron: "* * * * *" }, T0 + 3_600_000, "default period")]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      // Both injection points invalid: the block falls back to Date.now and
      // the fixed 30000 ms, so no quick ticks happen.
      options: { etaClock: 42, refreshIntervalMs: 0 },
    })
    try {
      expect(calls).toEqual(["ses"])
      await sleep(80)
      expect(calls).toEqual(["ses"])
    } finally {
      harness.destroy()
    }
  })

  test("clears the interval timer on lifecycle disposal (T4.9, R4.11, I5)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [entry("sch_cleanup", { cron: "* * * * *" }, T0 + 3_600_000, "cleanup")]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock, refreshIntervalMs: 15 },
    })
    try {
      await sleep(60)
      harness.dispose()
      const after = calls.length
      expect(after).toBeGreaterThanOrEqual(2)
      await sleep(120)
      expect(calls.length).toBe(after)
    } finally {
      harness.destroy()
    }
  })

  test("keeps the last successful render when refetches fail (T4.11, R4.13, E4.13)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    let failing = false
    const schedules = [
      entry("sch_keep_a", { at: 1792937100000 }, 1792937100000, "kept a"),
      entry("sch_keep_b", { cron: "0 0 * * *" }, 1792972800000, "kept b"),
    ]
    const harness = await mount({
      client: clientFixture(calls, () => {
        if (failing) throw new Error("transport failure")
        return { data: { schedules } }
      }),
      calls,
      options: { etaClock: clock.etaClock, refreshIntervalMs: 15 },
    })
    try {
      const frame = harness.frame()
      expect(frame).toContain("sch_keep_a")
      expect(frame).toContain("sch_keep_b")

      failing = true
      await sleep(100)
      await harness.render()
      const degraded = harness.frame()
      expect(degraded).toContain("Schedules")
      expect(degraded).toContain("sch_keep_a")
      expect(degraded).toContain("sch_keep_b")
    } finally {
      harness.destroy()
    }
  })

  test("renders as for an empty response and never crashes when no fetch succeeds (T4.12, R4.13, R4.14)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const failing = await mount({
      client: clientFixture(calls, () => {
        throw new Error("transport failure")
      }),
      calls,
      options: { etaClock: clock.etaClock, refreshIntervalMs: 15 },
    })
    try {
      expect(failing.frame().trim()).toBe("")
    } finally {
      failing.destroy()
    }

    // A malformed decode — no schedules envelope — is a failed fetch alike.
    const malformedCalls: string[] = []
    const malformed = await mount({
      client: clientFixture(malformedCalls, () => undefined),
      calls: malformedCalls,
      options: { etaClock: clock.etaClock },
    })
    try {
      expect(malformed.frame().trim()).toBe("")
    } finally {
      malformed.destroy()
    }
  })

  test("mounts once through the slot machinery and keeps entries across stream deltas (R4.7, R4.8, R4.9, R4.13)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const [messages, setMessages] = createSignal<Message[]>([])
    const partsByMessage = new Map<string, Part[]>()
    let schedules = [entry("sch_live", { cron: "* * * * *" }, T0 + 3_600_000, "live schedule")]

    // Each fetch answers on a macrotask: a remount loop advances at timer
    // pace, so a slot that remounts per response shows up as extra list
    // calls instead of starving the microtask queue.
    const client = {
      v2: {
        session: {
          schedule: {
            list: (input: { sessionID: string }) => {
              calls.push(input.sessionID)
              return new Promise((resolve) =>
                setTimeout(
                  () => resolve({ data: JSON.parse(JSON.stringify({ data: { schedules } })) }),
                  5,
                ),
              )
            },
          },
        },
      },
    }

    const [sessionID, setSessionID] = createSignal("ses")
    const harness = await mountViaSlot({
      client,
      options: { etaClock: clock.etaClock },
      sessionID: () => sessionID(),
      messages: () => messages(),
      parts: (messageID) => partsByMessage.get(messageID) ?? [],
    })
    try {
      // The mount fetch is the only call: the block mounts once and the
      // first response renders the entries.
      expect(calls).toEqual(["ses"])
      expect(harness.frame()).toContain("sch_live")

      // Ten stream deltas — message and part updates with no scheduler tool
      // part — remount nothing and refetch nothing; the entries of the last
      // successful response stay rendered between the deltas (R4.13).
      for (let i = 0; i < 10; i++) {
        const streamed = assistant(`msg_stream_${i}`)
        partsByMessage.set(streamed.id, [textPart(streamed.id)])
        setMessages((previous) => [...previous, user(`msg_u_${i}`), streamed])
        await harness.render()
      }
      expect(calls).toEqual(["ses"])
      expect(harness.frame()).toContain("sch_live")

      // A newly observed scheduler tool part still refetches exactly once
      // through the slot (R4.9) and renders the refreshed entry.
      schedules = [entry("sch_live_next", { cron: "* * * * *" }, T0 + 3_600_000, "refreshed schedule")]
      const schedulerPartMessage = assistant("msg_sched")
      partsByMessage.set(schedulerPartMessage.id, [toolPart(schedulerPartMessage.id, "scheduler")])
      setMessages((previous) => [...previous, user("msg_u_sched"), schedulerPartMessage])
      await harness.render()
      expect(calls).toEqual(["ses", "ses"])
      expect(harness.frame()).toContain("sch_live_next")

      // A change of the current session still refetches exactly once through
      // the slot (R4.8).
      setSessionID("ses_b")
      await harness.render()
      expect(calls).toEqual(["ses", "ses", "ses_b"])
      expect(harness.frame()).toContain("sch_live_next")
    } finally {
      harness.destroy()
    }
  })

  test("updates every line's eta on tick expiry without remounting (T4.14, R4.15)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [
      entry("sch_tick_a", { cron: "* * * * *" }, T0 + 45_000, "tick line a"),
      entry("sch_tick_b", { cron: "* * * * *" }, T0 + 120_000, "tick line b"),
    ]
    // The client answers on a macrotask like the storm test: a remount on
    // any tick expiry would surface as extra list calls, since every fresh
    // View refetches on its first run.
    const client = {
      v2: {
        session: {
          schedule: {
            list: (input: { sessionID: string }) => {
              calls.push(input.sessionID)
              return new Promise((resolve) =>
                setTimeout(
                  () => resolve({ data: JSON.parse(JSON.stringify({ data: { schedules } })) }),
                  5,
                ),
              )
            },
          },
        },
      },
    }
    const harness = await mountViaSlot({
      client,
      options: { etaClock: clock.etaClock, tickIntervalMs: 15 },
    })
    try {
      expect(calls).toEqual(["ses"])
      const before = harness.frame()
      expect(before).toContain("in 45s (2026-10-25T12:00:45Z) sch_tick_a (* * * * *): tick line a")
      expect(before).toContain("in 0h 02m (2026-10-25T12:02:00Z) sch_tick_b (* * * * *): tick line b")

      // The clock moves past the due instants with no refetch trigger in
      // between: the next tick expiry re-renders the eta of every rendered
      // line from the clock alone, the rest of each line stands unchanged.
      clock.advance(T0 + 90_000)
      await sleep(80)
      await harness.render()
      const after = harness.frame()
      expect(after).toContain("now (2026-10-25T12:00:45Z) sch_tick_a (* * * * *): tick line a")
      expect(after).toContain("in 30s (2026-10-25T12:02:00Z) sch_tick_b (* * * * *): tick line b")
      // The mount fetch is still the only client call: no tick refetched and
      // no tick remounted the block through the slot machinery.
      expect(calls).toEqual(["ses"])
    } finally {
      harness.destroy()
    }
  })

  test("issues zero schedule-list requests over consecutive tick expiries (T4.15, R4.16)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [entry("sch_quiet", { cron: "* * * * *" }, T0 + 3_600_000, "quiet tick")]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock, tickIntervalMs: 15 },
    })
    try {
      expect(calls).toEqual(["ses"])
      // Roughly eight tick expiries with the entries already rendered: the
      // display-only tick issues no request and the entries stand unchanged.
      await sleep(120)
      await harness.render()
      expect(calls).toEqual(["ses"])
      expect(harness.frame()).toContain("in 1h 00m (2026-10-25T13:00:00Z) sch_quiet (* * * * *): quiet tick")
    } finally {
      harness.destroy()
    }
  })

  test("clears the eta-tick timer on lifecycle disposal (T4.16, R4.17)", async () => {
    const clock = clockFixture(T0)
    const calls: string[] = []
    const schedules = [entry("sch_frozen", { cron: "* * * * *" }, T0 + 45_000, "frozen eta")]
    const harness = await mount({
      client: clientFixture(calls, () => ({ data: { schedules } })),
      calls,
      options: { etaClock: clock.etaClock, tickIntervalMs: 15 },
    })
    try {
      expect(harness.frame()).toContain("in 45s (2026-10-25T12:00:45Z) sch_frozen (* * * * *): frozen eta")
      harness.dispose()
      // The tick timer is cleared with the lifecycle: the clock moves on but
      // no eta re-render fires after disposal, the rendered eta stays frozen.
      clock.advance(T0 + 120_000)
      await sleep(80)
      await harness.render()
      const frame = harness.frame()
      expect(frame).toContain("in 45s (2026-10-25T12:00:45Z) sch_frozen (* * * * *): frozen eta")
      expect(frame).not.toContain("now (2026-10-25T12:00:45Z) sch_frozen")
    } finally {
      harness.destroy()
    }
  })
})
