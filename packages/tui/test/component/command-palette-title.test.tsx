/** @jsxImportSource @opentui/solid */
// The command palette renders `command.title` on every query, and the keymap
// keeps commands by reference, so a title closing over a solid signal flips on
// the next palette open after the command run updates the state. Regression
// coverage for app.toggle.prime_time: the POST resolves after dispatch has
// returned, so the label must flip on the following query, not stay frozen.
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, onMount } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "../../src/keymap"

function createResolvedKeymapConfig() {
  const keybinds = TuiKeybind.parse({})
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("palette toggle title switches after the async state update", async () => {
  let title!: () => string | undefined
  let dispatch!: (name: string) => { ok: boolean }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const [state, setState] = createSignal(true)
    onMount(() => {
      const command = {
        name: "app.toggle.prime_time",
        get title() {
          return state() ? "Disable prime-time limitations" : "Enable prime-time limitations"
        },
        namespace: "palette",
        run: async () => {
          // Server round-trip: the state lands after the dispatch already
          // returned, exactly like the prime-time POST resolution.
          await Bun.sleep(5)
          setState(!state())
        },
      }
      keymap.registerLayer({ commands: [command] })
      title = () => {
        const entry = keymap
          .getCommandEntries({ visibility: "active", namespace: "palette" })
          .find((item) => item.command.name === "app.toggle.prime_time")
        return typeof entry?.command.title === "string" ? entry.command.title : undefined
      }
      dispatch = (name: string) => keymap.dispatchCommand(name)
    })
    onCleanup(() => {
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box>
          <text>{state() ? "ENFORCED" : "FREE"}</text>
        </box>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    await Bun.sleep(20)
    expect(title()).toBe("Disable prime-time limitations")

    dispatch("app.toggle.prime_time")
    await Bun.sleep(50)
    expect(title()).toBe("Enable prime-time limitations")

    dispatch("app.toggle.prime_time")
    await Bun.sleep(50)
    expect(title()).toBe("Disable prime-time limitations")
  } finally {
    app.renderer.destroy()
  }
})
