import type { Message, Part } from "@opencode-ai/sdk/v2"

// discard_context marks context parts as excluded from the LLM context by
// part id (state.input.ids). Token attribution is exact for whole assistant
// messages; a partially discarded one contributes a deterministic
// char-weighted share of its output+reasoning tokens, floored to a whole
// token and reported via `estimated`, so every surface prefixes the total
// with "~" once a nonzero share entered it (specs/discard-context.md
// R7.2, R7.8).

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

// Sums output + reasoning tokens over assistant messages: the full count
// when every content part (text/reasoning/tool, minus the discard_context
// markers) is marked, otherwise the char-weighted share of the marked parts
// floored to a whole token (R7.2). estimated is true when a nonzero partial
// share entered the total (R7.8). Input/cache tokens are never counted: they
// describe the whole request, not the excluded content.
export function discardedTokenTotal(
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[] | undefined,
): { total: number; estimated: boolean } {
  const partsOf = (messageID: string) => getParts(messageID) ?? []
  const discarded = collectDiscardedPartIds(messages.flatMap((message) => partsOf(message.id)))
  let total = 0
  let estimated = false
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const eligible = partsOf(message.id).filter(
      (part) =>
        part.type === "text" ||
        part.type === "reasoning" ||
        (part.type === "tool" && part.tool !== "discard_context"),
    )
    if (eligible.length === 0) continue
    const tokens = (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
    if (eligible.every((part) => discarded.has(part.id))) {
      total += tokens
      continue
    }
    const marked = weightOf(eligible.filter((part) => discarded.has(part.id)))
    if (marked === 0) continue
    const share = Math.floor((marked * tokens) / weightOf(eligible))
    if (share === 0) continue
    total += share
    estimated = true
  }
  return { total, estimated }
}

// Char weight of one eligible part (R7.2): its text length for text/reasoning,
// the combined length of its output and JSON.stringify(input) for tool parts.
function partWeight(part: Part): number {
  if (part.type === "text" || part.type === "reasoning") return part.text.length
  if (part.type !== "tool") return 0
  const output = part.state.status === "completed" ? part.state.output.length : 0
  const input = part.state.input as unknown
  return output + (input === undefined ? 0 : JSON.stringify(input).length)
}

function weightOf(parts: readonly Part[]): number {
  return parts.reduce((sum, part) => sum + partWeight(part), 0)
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
