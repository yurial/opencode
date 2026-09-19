import type { Message, Part } from "@opencode-ai/sdk/v2"

// discard_context marks context parts as excluded from the LLM context by
// part id (state.input.ids). Token attribution stays exact only for whole
// assistant messages: providers report output/reasoning tokens per message,
// so a partially discarded message contributes nothing (deliberate decision —
// never estimate). Mirrors the identically-named module in session-ui; tui
// cannot import session-ui (no dependency, web-only package).

// Union of part ids marked by every discard_context call among `parts`.
// discard_context tool parts themselves are skipped: they are hidden markers,
// never discarded content.
export function collectDiscardedPartIds(parts: readonly Part[]): Set<string> {
  const ids = new Set<string>()
  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== "discard_context") continue
    const input = part.state.input as { ids?: unknown } | undefined
    if (!Array.isArray(input?.ids)) continue
    for (const id of input.ids) {
      if (typeof id === "string") ids.add(id)
    }
  }
  return ids
}

// Sums output + reasoning tokens over assistant messages whose every content
// part (text/reasoning/tool, minus the discard_context markers) is present in
// the discarded union. Messages with no such parts and partially discarded
// messages contribute 0. Input/cache tokens are never counted: they describe
// the whole request, not the excluded content.
export function discardedTokenTotal(
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[] | undefined,
): number {
  const partsOf = (messageID: string) => getParts(messageID) ?? []
  const discarded = collectDiscardedPartIds(messages.flatMap((message) => partsOf(message.id)))
  let total = 0
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const eligible = partsOf(message.id).filter(
      (part) =>
        part.type === "text" ||
        part.type === "reasoning" ||
        (part.type === "tool" && part.tool !== "discard_context"),
    )
    if (eligible.length === 0) continue
    if (!eligible.every((part) => discarded.has(part.id))) continue
    total += (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
  }
  return total
}

// Compact token count for inline markers: 950 -> "950", 4200 -> "4.2k",
// 1300000 -> "1.3M" (one decimal, trailing ".0" trimmed).
export function formatCompactTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return trimZero((value / 1_000).toFixed(1)) + "k"
  return trimZero((value / 1_000_000).toFixed(1)) + "M"
}

function trimZero(text: string) {
  return text.endsWith(".0") ? text.slice(0, -2) : text
}
