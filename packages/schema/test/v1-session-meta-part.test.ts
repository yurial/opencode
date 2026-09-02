import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "../src/v1/session"

const decodePart = Schema.decodeUnknownSync(SessionV1.Part)
const encodePart = Schema.encodeSync(SessionV1.Part)

const metaPart = {
  id: "prt_01J5Y5H0AH4Q4NXJ6P4C3P5V2N",
  sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
  messageID: "msg_01J5Y5H0AH4Q4NXJ6P4C3P5V2M",
  type: "meta",
  kind: "stream-retry",
  payload: { attempt: 2, error: "Provider is overloaded" },
} as const

test("meta part decodes from the Part union and round-trips", () => {
  const decoded = decodePart(metaPart)

  expect(decoded.type).toBe("meta")
  if (decoded.type !== "meta") return
  expect(decoded.kind).toBe("stream-retry")
  expect(decoded.payload).toEqual({ attempt: 2, error: "Provider is overloaded" })
  expect(encodePart(decoded)).toEqual(metaPart)
})

test("meta part carries no dedicated timestamp; ordering derives from the part id (R8)", () => {
  const decoded = decodePart(metaPart)
  expect("time" in decoded).toBe(false)
})

test("meta part is generic: any non-empty kind with an opaque payload decodes", () => {
  const decoded = decodePart({ ...metaPart, kind: "future-kind", payload: { nested: { list: [1, "two"] } } })

  expect(decoded.type).toBe("meta")
  if (decoded.type !== "meta") return
  expect(decoded.kind).toBe("future-kind")
  expect(decoded.payload).toEqual({ nested: { list: [1, "two"] } })
})

test("meta part rejects an empty kind", () => {
  expect(() => decodePart({ ...metaPart, kind: "" })).toThrow()
})
