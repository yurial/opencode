import { describe, expect, it } from "bun:test"
import { SyncWatermark } from "../../src/server/routes/instance/httpapi/handlers/sync-watermark"

const HOUR = 60 * 60 * 1000

describe("sync watermark window", () => {
  it("keeps the fixed constants from the spec", () => {
    expect(SyncWatermark.SYNC_WATERMARK_WINDOW_SIZE).toBe(8)
    expect(SyncWatermark.SYNC_WATERMARK_TTL).toBe(24 * HOUR)
  })

  it("evicts the oldest map beyond the window capacity", () => {
    const window = SyncWatermark.make()
    for (let index = 0; index < SyncWatermark.SYNC_WATERMARK_WINDOW_SIZE; index++) {
      window.record({ s: index }, index)
    }
    expect(window.floor("s", SyncWatermark.SYNC_WATERMARK_WINDOW_SIZE - 1)).toBe(0)

    // Recording beyond capacity evicts the oldest map (watermark 0).
    window.record({ s: 100 }, SyncWatermark.SYNC_WATERMARK_WINDOW_SIZE)
    expect(window.floor("s", SyncWatermark.SYNC_WATERMARK_WINDOW_SIZE)).toBe(1)
    expect(window.floors(SyncWatermark.SYNC_WATERMARK_WINDOW_SIZE)).toEqual(new Map([["s", 1]]))
  })

  it("treats maps older than the TTL as absent", () => {
    const window = SyncWatermark.make()
    window.record({ s: 5 }, 0)
    window.record({ s: 9 }, 1)

    // At exactly the TTL a map is still live; past it, it is treated as absent.
    expect(window.floor("s", SyncWatermark.SYNC_WATERMARK_TTL)).toBe(5)
    expect(window.floor("s", SyncWatermark.SYNC_WATERMARK_TTL + 1)).toBe(9)
  })

  it("computes the minimum watermark across live maps", () => {
    const window = SyncWatermark.make()
    // Spec example: M1 = {s1: 10, s2: 4} (age 1h) and M2 = {s1: 7} (age 2h).
    window.record({ s1: 10, s2: 4 }, 2 * HOUR)
    window.record({ s1: 7 }, 1 * HOUR)

    const now = 3 * HOUR
    expect(window.floor("s1", now)).toBe(7)
    expect(window.floor("s2", now)).toBe(4)
    expect(window.floors(now)).toEqual(
      new Map([
        ["s1", 7],
        ["s2", 4],
      ]),
    )
  })

  it("yields no floor for an empty window or an absent aggregate", () => {
    const window = SyncWatermark.make()
    expect(window.floor("s", 0)).toBeUndefined()
    expect(window.floors(0).size).toBe(0)

    // R3: aggregates absent from every live map have no floor and are never pruned.
    window.record({ other: 3 }, 0)
    expect(window.floor("s", 0)).toBeUndefined()
    expect(window.floor("other", 0)).toBe(3)
  })

  it("ignores empty posted maps when computing floors", () => {
    const window = SyncWatermark.make()
    window.record({}, 0)
    window.record({ s: 4 }, 1)
    expect(window.floor("s", 1)).toBe(4)
    expect(window.floors(1)).toEqual(new Map([["s", 4]]))
  })
})
