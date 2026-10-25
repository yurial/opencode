import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { SchedulerViewPlugin, type SchedulerViewPluginOptions } from "../../src/plugin/scheduler-view"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

type ToolHook = NonNullable<Hooks["tool.execute.after"]>
type ToolCall = Parameters<ToolHook>[0]
type ToolResult = Parameters<ToolHook>[1]

// Spec E1/E2 eta-clock instant: 2026-10-25T12:00:00Z.
const CLOCK = Date.parse("2026-10-25T12:00:00Z")

const call = (tool: string): ToolCall => ({ tool, sessionID: "ses_view_test", callID: "call_view_test", args: {} })

const runHook = async (output: string, options?: SchedulerViewPluginOptions) => {
  const hook = (await SchedulerViewPlugin({} as PluginInput, options))["tool.execute.after"]!
  const result: ToolResult = { title: "1 schedule", output, metadata: { action: "add" } }
  await hook(call("scheduler"), result)
  return result
}

describe("scheduler-view annotator", () => {
  test("annotates an add result with one line (T1.3, spec E1.3)", async () => {
    const result = await runHook("Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z", {
      etaClock: () => CLOCK,
    })
    expect(result.output).toBe(
      "Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z\n" +
        "eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)",
    )
  })

  test("annotates a list result with one line per schedule in text order (T1.4, spec E1.4)", async () => {
    const result = await runHook(
      "sch_fix (*/30 * * * *) next due 2026-10-25T14:05:00Z: check CI status\n" +
        "sch_rel (0 0 * * *) next due 2026-10-26T00:00:00Z: daily digest",
      { etaClock: () => CLOCK },
    )
    expect(result.output).toBe(
      "sch_fix (*/30 * * * *) next due 2026-10-25T14:05:00Z: check CI status\n" +
        "sch_rel (0 0 * * *) next due 2026-10-26T00:00:00Z: daily digest\n" +
        "eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)\n" +
        "eta sch_rel: in 12h 00m (2026-10-26T00:00:00Z)",
    )
  })

  test("annotation runs on add, list, and remove results alike (T1.2)", async () => {
    const add = await runHook("Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z", {
      etaClock: () => CLOCK,
    })
    expect(add.output).toContain("eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)")

    const list = await runHook("sch_fix (*/30 * * * *) next due 2026-10-25T14:05:00Z: check CI status", {
      etaClock: () => CLOCK,
    })
    expect(list.output).toContain("eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)")

    const remove = await runHook("Removed schedule sch_fix", { etaClock: () => CLOCK })
    expect(remove.output).toBe("Removed schedule sch_fix")
  })

  test("annotation leaves the title and the metadata unchanged (T1.5)", async () => {
    const metadata = { action: "add", id: "sch_fix", spec: "*/30 * * * *" }
    const hook = (await SchedulerViewPlugin({} as PluginInput, { etaClock: () => CLOCK }))["tool.execute.after"]!
    const result: ToolResult = {
      title: "Scheduled sch_fix (*/30 * * * *)",
      output: "Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z",
      metadata,
    }
    await hook(call("scheduler"), result)
    expect(result.output).toContain("eta sch_fix:")
    expect(result.title).toBe("Scheduled sch_fix (*/30 * * * *)")
    expect(result.metadata).toBe(metadata)
  })

  test("the annotator eta derives from the host clock when no clock is injected (T1.6)", async () => {
    // Anchors sit mid-bucket so host-clock jitter cannot flip the floor.
    const now = Date.now()
    const ahead = await runHook(`Scheduled sch_fix (0 * * * *), next due ${new Date(now + (2 * 3600 + 2 * 60 + 30) * 1000).toISOString()}`)
    expect(ahead.output).toContain("eta sch_fix: in 2h 02m (")

    const overdue = await runHook(`Scheduled sch_over (0 * * * *), next due ${new Date(now - 10 * 60_000).toISOString()}`)
    expect(overdue.output).toContain("eta sch_over: now (")

    const imminent = await runHook(`Scheduled sch_soon (0 * * * *), next due ${new Date(now + 30_000).toISOString()}`)
    expect(imminent.output).toMatch(/eta sch_soon: in (2[5-9]|3[0-5])s \(/)
  })

  test("the annotator reads id and instant from the tool text only (T1.7, I2)", async () => {
    // The first sch_-prefixed token of the line names the schedule.
    const first = await runHook("sch_alpha (0 0 * * *) next due 2026-10-26T00:00:00Z: see sch_beta", {
      etaClock: () => CLOCK,
    })
    expect(first.output).toContain("eta sch_alpha: in 12h 00m (2026-10-26T00:00:00Z)")
    expect(first.output).not.toContain("eta sch_beta")

    // A line carrying the fragment without a schedule id gains no annotation.
    const noId = await runHook("next due 2026-10-26T00:00:00Z", { etaClock: () => CLOCK })
    expect(noId.output).toBe("next due 2026-10-26T00:00:00Z")

    // A sch_ token without the fragment gains no annotation.
    const noFragment = await runHook("Scheduled sch_fix (*/30 * * * *)", { etaClock: () => CLOCK })
    expect(noFragment.output).toBe("Scheduled sch_fix (*/30 * * * *)")

    // A token after the fragment that is no ISO instant is no
    // `next due <instant>` fragment and gains no annotation.
    const notInstant = await runHook("sch_fix (0 0 * * *) next due someday: hi", { etaClock: () => CLOCK })
    expect(notInstant.output).toBe("sch_fix (0 0 * * *) next due someday: hi")

    // A shape-conforming but calendar-invalid instant gains no annotation.
    const invalidCalendar = await runHook("sch_bad (0 0 * * *) next due 2026-00-15T12:00:00Z: hi", {
      etaClock: () => CLOCK,
    })
    expect(invalidCalendar.output).toBe("sch_bad (0 0 * * *) next due 2026-00-15T12:00:00Z: hi")
  })

  test("remove results, error results, and empty listings stay unchanged (T1.8, spec E1.8)", async () => {
    const removed = await runHook("Removed schedule sch_fix", { etaClock: () => CLOCK })
    expect(removed.output).toBe("Removed schedule sch_fix")

    const empty = await runHook("", { etaClock: () => CLOCK })
    expect(empty.output).toBe("")

    const errorResult = await runHook("schedule-not-found: no schedule sch_fix is bound to this session", {
      etaClock: () => CLOCK,
    })
    expect(errorResult.output).toBe("schedule-not-found: no schedule sch_fix is bound to this session")
  })

  test("an internal annotator failure leaves the result intact (T1.9)", async () => {
    const output = "Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z"
    const result = await runHook(output, {
      etaClock: () => {
        throw new Error("clock broke")
      },
    })
    expect(result.output).toBe(output)
  })

  test("other tools pass through unchanged (T1.2 filter)", async () => {
    const hook = (await SchedulerViewPlugin({} as PluginInput, { etaClock: () => CLOCK }))["tool.execute.after"]!
    const result: ToolResult = {
      title: "t",
      output: "Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z",
      metadata: {},
    }
    await hook(call("bash"), result)
    expect(result.output).toBe("Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z")
  })
})

describe("scheduler-view eta grammar (spec E2)", () => {
  const cases: Array<[string, string]> = [
    // R2.4 hour-minute production.
    ["2026-10-25T14:05:00Z", "eta sch_e: in 2h 05m (2026-10-25T14:05:00Z)"],
    // R2.4 zero-hours form.
    ["2026-10-25T12:05:30Z", "eta sch_e: in 0h 05m (2026-10-25T12:05:30Z)"],
    // R2.3 seconds production below one minute.
    ["2026-10-25T12:00:45.9Z", "eta sch_e: in 45s (2026-10-25T12:00:45Z)"],
    // R2.2 remainder of exactly zero.
    ["2026-10-25T12:00:00Z", "eta sch_e: now (2026-10-25T12:00:00Z)"],
    // R2.2 overdue remainder.
    ["2026-10-25T11:50:00Z", "eta sch_e: now (2026-10-25T11:50:00Z)"],
    // R2.4 hours without an upper bound across the day boundary.
    ["2026-10-27T14:00:00Z", "eta sch_e: in 50h 00m (2026-10-27T14:00:00Z)"],
  ]

  for (const [due, annotation] of cases) {
    test(`next due ${due} renders ${annotation}`, async () => {
      const result = await runHook(`Scheduled sch_e (0 0 * * *), next due ${due}`, { etaClock: () => CLOCK })
      expect(result.output).toBe(`Scheduled sch_e (0 0 * * *), next due ${due}\n${annotation}`)
    })
  }

  test("the absolute time renders at second precision (R2.5)", async () => {
    const result = await runHook("Scheduled sch_ms (0 0 * * *), next due 2026-10-25T12:00:30.250Z", {
      etaClock: () => CLOCK,
    })
    expect(result.output).toContain("eta sch_ms: in 30s (2026-10-25T12:00:30Z)")
  })
})

// Full-stack registration checks over the real internal-plugins list
// (T1.1): the annotator hooks into the server plugin machinery exactly like
// the shipped internal plugins.
const stack = (disableDefaultPlugins: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins })],
  ])

const it = testEffect(stack(false))
const itWithoutInternalPlugins = testEffect(stack(true))

describe("scheduler-view annotator registration", () => {
  it.instance("registers the annotator with the internal plugins (T1.1)", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const hooks = yield* plugin.list()
      expect(hooks.filter((hook) => hook["tool.execute.after"] !== undefined)).toHaveLength(1)

      // The registered hook annotates through the host clock: the due
      // instant sits mid-bucket so host-clock jitter cannot flip the eta.
      const due = new Date(Date.now() + (2 * 3600 + 2 * 60 + 30) * 1000).toISOString()
      const result: ToolResult = {
        title: "Scheduled sch_fix (*/30 * * * *)",
        output: `Scheduled sch_fix (*/30 * * * *), next due ${due}`,
        metadata: { action: "add", id: "sch_fix" },
      }
      const annotated = yield* plugin.trigger("tool.execute.after", call("scheduler"), result)
      expect(annotated.output).toContain("eta sch_fix: in 2h 02m")
      expect(annotated.title).toBe("Scheduled sch_fix (*/30 * * * *)")

      const other: ToolResult = {
        title: "t",
        output: `Scheduled sch_fix (*/30 * * * *), next due ${due}`,
        metadata: {},
      }
      const untouched = yield* plugin.trigger("tool.execute.after", call("bash"), other)
      expect(untouched.output).toBe(`Scheduled sch_fix (*/30 * * * *), next due ${due}`)
    }),
  )

  itWithoutInternalPlugins.instance("registers no annotator hook with internal plugins disabled (T1.1)", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const hooks = yield* plugin.list()
      expect(hooks.filter((hook) => hook["tool.execute.after"] !== undefined)).toHaveLength(0)

      const output = "Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z"
      const result: ToolResult = { title: "t", output, metadata: {} }
      const untouched = yield* plugin.trigger("tool.execute.after", call("scheduler"), result)
      expect(untouched.output).toBe(output)
    }),
  )
})
