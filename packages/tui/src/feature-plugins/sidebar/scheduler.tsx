import type { SessionSchedule } from "@opencode-ai/sdk/v2"
import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { textAttributes } from "../../theme/catalog"

/**
 * The scheduler-view/sidebar-block (specs/scheduler-view.md R4): a builtin
 * TUI feature plugin that renders the current session's schedules in the
 * `sidebar_content` slot, one entry line per schedule-entry of the last
 * successful schedule-list response.
 *
 * Contract:
 * - Registered with the built-in feature plugins under the id
 *   `internal:sidebar-scheduler`, in the `sidebar_content` slot at
 *   SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER; there is no plugin-config key (R4.1,
 *   R4.2).
 * - Data flows only through the SDK client of the TUI plugin api against the
 *   schedule-list endpoint of the current session; no backend scheduler
 *   module is imported and no TuiState accessor for schedules exists (R4.3).
 * - The block renders the header `Schedules` and one entry line per entry,
 *   in the order the server delivered them — the endpoint already orders by
 *   next fire time; the block never re-sorts (R4.4, R4.5, R4.7).
 * - Refetch triggers: the first run on mount, a change of the current
 *   session (R4.8), a newly observed scheduler tool part in the current
 *   session (R4.9, I6), and every expiry of the refresh interval (R4.10).
 *   The interval timer is cleared on disposal through the TUI plugin
 *   lifecycle (R4.11, I5).
 * - Degradation: a failed fetch keeps the entries of the last successful
 *   response rendered — the block renders nothing before the first success
 *   — and no failure propagates beyond the block (R4.13, R4.14).
 */
const id = "internal:sidebar-scheduler"

/**
 * Reads the scheduler-view/eta-clock: the current UTC instant of the TUI
 * process, as UTC epoch milliseconds (specs/scheduler-view.md Definitions,
 * scheduler-view/eta-clock).
 *
 * Contract:
 * - Returns a finite integer of UTC epoch milliseconds; the due instants of
 *   the entry lines are compared against it as-is.
 * - Called at render time of every entry line, after the due instant of the
 *   line is known (R4.12).
 * - A clock that throws is a render failure of the block: the degradation
 *   rules apply and nothing crashes the session screen (R4.14). There is no
 *   other error channel.
 */
export type EtaClock = () => number

/**
 * Options of the scheduler-view/sidebar-block plugin.
 *
 * Contract: there is no plugin-config key (R4.1) — the built-in registration
 * passes no options, so every field is a test injection point only; a value
 * present here never comes from user configuration.
 */
export type SchedulerViewSidebarOptions = {
  /**
   * The scheduler-view/eta-clock used to derive every scheduler-view/eta of
   * the rendered entry lines (R2.1, R4.12).
   *
   * Contract:
   * - Allowed values: any `EtaClock` — a function returning the current UTC
   *   instant in epoch milliseconds (see `EtaClock` for its contract).
   * - Omitted: the UTC clock of the TUI process — `Date.now` (R4.12).
   * - The injection point exists for tests: a fixed clock makes every eta
   *   rendering of the block deterministic.
   */
  etaClock?: EtaClock

  /**
   * The periodic refetch period in milliseconds (R4.10).
   *
   * Contract:
   * - Allowed values: positive integers; each expiry refetches the schedule
   *   list and re-renders.
   * - Omitted: SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL (fixed 30000 ms).
   * - A non-positive or non-numeric value falls back to the fixed default;
   *   the injection point exists for tests, where a short period replaces
   *   time-based waiting.
   */
  refreshIntervalMs?: number
}

/**
 * sidebar_content slot order of the block: fixed 450, between the todo block
 * (400) and the files block (500) (specs/scheduler-view.md Configuration,
 * SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER, R4.2).
 */
const SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER = 450

/**
 * Periodic refetch period of the block in milliseconds; every expiry
 * refetches the schedule list and re-renders (specs/scheduler-view.md
 * Configuration, SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL, R4.10). Fixed —
 * the spec has no config key for it.
 */
const SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL_MS = 30_000

/**
 * Length bound of the shortened message of an entry line
 * (specs/scheduler-view.md Configuration, SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX,
 * R4.6). Fixed — the spec has no config key for it.
 */
const SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX = 60

/**
 * Boundaries of the scheduler-view/eta grammar (specs/scheduler-view.md, ETA
 * grammar): a remainder at or below ETA_NOW_BOUND_MS renders `now` (R2.2), a
 * remainder below ETA_MINUTE_MS renders the seconds production (R2.3), a
 * remainder of ETA_MINUTE_MS or more renders the hour-minute production,
 * floored on ETA_HOUR_MS (R2.4). Fixed values — the spec has no config key
 * for them.
 */
const ETA_NOW_BOUND_MS = 0
const ETA_MINUTE_MS = 60_000
const ETA_HOUR_MS = 3_600_000
const ETA_SECOND_MS = 1_000

/**
 * Length of `YYYY-MM-DDTHH:MM:SS`, the second-precision head of an ISO 8601
 * UTC string (R2.5).
 */
const ISO_SECOND_LENGTH = 19

/**
 * The ellipsis character appended to a truncated entry message (R4.6).
 */
const ELLIPSIS = "…"

/**
 * Renders the scheduler-view/eta of one due instant against the eta-clock
 * reading (R2.1-R2.4): a remainder at or below zero renders `now`, a
 * remainder below one minute the seconds production, a remainder of one
 * minute or more the hour-minute production with unpadded hours and
 * two-digit minutes.
 */
function eta(due: number, now: number): string {
  const remainder = due - now
  if (remainder <= ETA_NOW_BOUND_MS) return "now"
  if (remainder < ETA_MINUTE_MS) return `in ${Math.floor(remainder / ETA_SECOND_MS)}s`
  const hours = Math.floor(remainder / ETA_HOUR_MS)
  const minutes = Math.floor((remainder % ETA_HOUR_MS) / ETA_MINUTE_MS)
  return `in ${hours}h ${String(minutes).padStart(2, "0")}m`
}

/**
 * Renders the absolute time of an entry line: the due instant in the ISO
 * 8601 UTC form of second precision, the sub-second part truncated (R2.5).
 */
function absolute(due: number): string {
  return `${new Date(due).toISOString().slice(0, ISO_SECOND_LENGTH)}Z`
}

/**
 * Renders the spec form of an entry line (R4.5): the cron string of a
 * recurring schedule as-is, the absolute time (same production as R2.5) of a
 * one-shot.
 */
function specForm(spec: SessionSchedule["spec"]): string {
  return "cron" in spec ? spec.cron : absolute(spec.at)
}

/**
 * Shortens the message of an entry line (R4.6): every whitespace run
 * collapses to a single space, the text truncates to
 * SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX characters with an ellipsis character
 * appended when truncation occurs.
 */
function shorten(message: string): string {
  const collapsed = message.replace(/\s+/g, " ")
  return collapsed.length <= SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX
    ? collapsed
    : collapsed.slice(0, SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX) + ELLIPSIS
}

/**
 * Renders one entry line (R4.4): `<eta> (<absolute>) <id> (<spec>): <message>`
 * — the eta and absolute productions of R2.1-R2.5, the schedule id, the spec
 * form of R4.5, and the shortened message of R4.6.
 */
function entryLine(entry: SessionSchedule, now: number): string {
  const due = entry.nextFireAt
  return `${eta(due, now)} (${absolute(due)}) ${entry.id} (${specForm(entry.spec)}): ${shorten(entry.message)}`
}

/**
 * Resolves the block settings from the plugin options: the injected values
 * when present and well-formed, the spec-fixed defaults otherwise (see
 * SchedulerViewSidebarOptions for the per-field contract).
 */
function settingsOf(options: PluginOptions | undefined): { etaClock: EtaClock; intervalMs: number } {
  const etaClock = options?.etaClock
  const interval = options?.refreshIntervalMs
  return {
    etaClock: typeof etaClock === "function" ? (etaClock as EtaClock) : tuiEtaClock,
    intervalMs:
      typeof interval === "number" && interval > 0 ? interval : SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL_MS,
  }
}

/**
 * The default scheduler-view/eta-clock: the UTC clock of the TUI process
 * (R4.12).
 */
const tuiEtaClock: EtaClock = () => Date.now()

/**
 * Renders the schedules block for one session (see the module contract): a
 * hidden block until a successful response carries an entry (R4.7, R4.13),
 * then the header and one line per entry, refetched by the session-change
 * and scheduler-part triggers and the periodic interval.
 */
function View(props: { api: TuiPluginApi; settings: { etaClock: EtaClock; intervalMs: number }; session_id: string }) {
  const api = props.api
  const [entries, setEntries] = createSignal<ReadonlyArray<SessionSchedule> | undefined>(undefined)

  // R4.13/R4.14: every failure — transport, non-success status, decode —
  // keeps the entries of the last successful response (none before the
  // first success) and never propagates beyond the block. A response that
  // resolves after the current session changed answers the previous
  // session and is dropped, so a slow round trip cannot overwrite the
  // entries of the session on screen until the next trigger (R4.8).
  const refetch = (sessionID: string) => {
    void api.client.v2.session.schedule
      .list({ sessionID }, { throwOnError: true })
      .then((result) => {
        if (props.session_id !== sessionID) return
        setEntries(result.data.data.schedules)
      })
      .catch(() => {})
  }

  // R4.9/I6: scheduler tool parts observed through the session data of the
  // plugin api — the observation channel, never a schedule data source.
  const schedulerParts = createMemo(
    () =>
      api.state
        .session.messages(props.session_id)
        .flatMap((message) => api.state.part(message.id))
        .filter((part) => part.type === "tool" && part.tool === "scheduler").length,
  )

  // R4.8 + R4.9 in one watcher: the first run fetches on mount; a change of
  // the current session refetches (R4.8); a grown scheduler tool-part count
  // in the current session refetches (R4.9). A shrinking or unchanged count
  // is no trigger.
  let seen: { session: string; parts: number } | undefined
  createEffect(() => {
    const sessionID = props.session_id
    const parts = schedulerParts()
    const previous = seen
    seen = { session: sessionID, parts }
    if (previous !== undefined && previous.session === sessionID && parts <= previous.parts) return
    refetch(sessionID)
  })

  // R4.10/R4.11: every expiry refetches and re-renders; the timer clears on
  // unmount and on the TUI plugin lifecycle disposal (I5).
  const timer = setInterval(() => refetch(props.session_id), props.settings.intervalMs)
  onCleanup(() => clearInterval(timer))
  api.lifecycle.onDispose(() => clearInterval(timer))

  // R4.7: no entry — no block, including before the first success (R4.13).
  return (
    <Show when={(entries()?.length ?? 0) > 0}>
      <box>
        <text
          fg={api.theme.element("sidebar.strong").fg}
          attributes={textAttributes(api.theme.element("sidebar.strong").attributes)}
        >
          Schedules
        </text>
        <For each={entries()}>
          {(entry) => <text fg={api.theme.element("sidebar.text").fg}>{entryLine(entry, props.settings.etaClock())}</text>}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const settings = settingsOf(options)
  api.slots.register({
    order: SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} settings={settings} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
