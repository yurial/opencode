export * as SyncWatermark from "./sync-watermark"

import { Duration } from "effect"

/** Capacity of the watermark window (specs/event-retention.md, Configuration). */
export const SYNC_WATERMARK_WINDOW_SIZE = 8

/** Maximum age of a posted watermark map inside the window, in millis (specs/event-retention.md, Configuration). */
export const SYNC_WATERMARK_TTL = Duration.toMillis(Duration.hours(24))

/**
 * event-retention/window: the server's in-memory, bounded collection of the
 * most recently posted /sync/history watermark maps, each stamped with its
 * receipt time (specs/event-retention.md R2, R7 — process memory only; after a
 * restart the window is empty and nothing is pruned until replicas post again).
 */
export const make = () => {
  const maps = new Array<{ at: number; watermarks: Record<string, number> }>()
  const live = (now: number) => maps.filter((map) => now - map.at <= SYNC_WATERMARK_TTL)
  return {
    /** R2: stamp the receipt time, push into the window, evict the oldest beyond capacity. */
    record(watermarks: Record<string, number>, now: number) {
      maps.push({ at: now, watermarks })
      while (maps.length > SYNC_WATERMARK_WINDOW_SIZE) maps.shift()
    },
    /**
     * R3: the prune floor for one aggregate — the minimum watermark over live
     * (unexpired) maps that contain it. undefined ⇒ no floor, never pruned.
     */
    floor(aggregateID: string, now: number): number | undefined {
      let result: number | undefined
      for (const map of live(now)) {
        const watermark = map.watermarks[aggregateID]
        if (watermark !== undefined) result = result === undefined ? watermark : Math.min(result, watermark)
      }
      return result
    },
    /** R3: prune floors for every aggregate present in at least one live map. */
    floors(now: number) {
      const result = new Map<string, number>()
      for (const map of live(now)) {
        for (const [aggregateID, watermark] of Object.entries(map.watermarks)) {
          const current = result.get(aggregateID)
          result.set(aggregateID, current === undefined ? watermark : Math.min(current, watermark))
        }
      }
      return result
    },
  }
}
