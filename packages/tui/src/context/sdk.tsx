import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { formatError, lifecycleLog, LIFECYCLE_LOG_ERROR, LIFECYCLE_LOG_INFO } from "../util/lifecycle-log"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) {
          // One misbehaving handler must not kill the dispatch loop or the
          // SSE subscription (R15.5, R15.6); the failure is recorded and the
          // remaining handlers still run. This guards every flush entry:
          // direct, timer, and post-stream drain.
          try {
            handler(event)
          } catch (error) {
            lifecycleLog(LIFECYCLE_LOG_ERROR, "event handler failed", {
              event: event.payload.type,
              error: formatError(error),
            })
          }
        }
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Backoff doubles per failed attempt from retryDelay up to
          // maxRetryDelay and precedes every retry connect (R15.1).
          const backoff = attempt === 0 ? 0 : Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          if (backoff > 0) {
            await new Promise((resolve) => setTimeout(resolve, backoff))
            if (abort.signal.aborted || ctrl.signal.aborted) break
          }
          lifecycleLog(
            LIFECYCLE_LOG_INFO,
            "event stream connect",
            attempt === 0 ? { attempt } : { attempt, backoff_ms: backoff },
          )

          // The generated SSE generator reports connection and stream
          // failures through onSseError and then completes normally, so the
          // stream error (R15.4) versus clean end (R15.3) classification
          // happens after the stream loop.
          let streamError: unknown
          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
            onSseError: (error) => {
              streamError = error
            },
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()

          if (abort.signal.aborted || ctrl.signal.aborted) {
            lifecycleLog(LIFECYCLE_LOG_INFO, "event stream ended", { attempt, cause: "cleanup" })
            break
          }
          if (streamError === undefined) {
            lifecycleLog(LIFECYCLE_LOG_INFO, "event stream ended", { attempt, cause: "eof" })
          } else {
            lifecycleLog(LIFECYCLE_LOG_ERROR, "event stream error", {
              attempt,
              error: formatError(streamError),
            })
          }
          attempt += 1
        }
      })().catch((error) => {
        // The loop above is built to survive every expected failure; a throw
        // here must still be recorded, never silent.
        lifecycleLog(LIFECYCLE_LOG_ERROR, "event stream error", { error: formatError(error) })
      })
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
