import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (next: T) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      set(() => next)
    }, ms)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return [get, debounced]
}

const [now, setNow] = createSignal(Date.now())
let nowSubscribers = 0
let nowTimer: ReturnType<typeof setInterval> | undefined

// One shared wall-clock tick for live elapsed-time displays (the reasoning
// timer): a single 1s interval no matter how many parts tick, started on the
// first subscriber and stopped once the last one unmounts.
export function useNow(): Accessor<number> {
  nowSubscribers++
  setNow(Date.now())
  if (!nowTimer) nowTimer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => {
    nowSubscribers--
    if (nowSubscribers > 0 || !nowTimer) return
    clearInterval(nowTimer)
    nowTimer = undefined
  })
  return now
}

export function createFadeIn(show: Accessor<boolean>, enabled: Accessor<boolean>) {
  const [alpha, setAlpha] = createSignal(show() ? 1 : 0)
  let revealed = show()

  createEffect(
    on([show, enabled], ([visible, animate]) => {
      if (!visible) {
        setAlpha(0)
        return
      }

      if (!animate || revealed) {
        revealed = true
        setAlpha(1)
        return
      }

      const start = performance.now()
      revealed = true
      setAlpha(0)

      const timer = setInterval(() => {
        const progress = Math.min((performance.now() - start) / 160, 1)
        setAlpha(progress * progress * (3 - 2 * progress))
        if (progress >= 1) clearInterval(timer)
      }, 16)

      onCleanup(() => clearInterval(timer))
    }),
  )

  return alpha
}
