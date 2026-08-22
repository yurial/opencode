export * as InlineFiles from "./inline-files"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { ConfigMarkdown, fileDirectives } from "../config/markdown"
import { FSUtil } from "../fs-util"

function resolveDirectiveDir(dir: string, directivePath: string) {
  const expanded = directivePath.startsWith("~/") ? os.homedir() + directivePath.slice(1) : directivePath
  return path.resolve(dir, expanded)
}

export const inlineFileDirectives: (
  content: string,
  filepath: string,
  fs: FSUtil.Interface,
  visited?: Set<string>,
) => Effect.Effect<string, never, never> = Effect.fnUntraced(function* (
  content: string,
  filepath: string,
  fs: FSUtil.Interface,
  visited: Set<string> = new Set(),
) {
  const matches = fileDirectives(content)
  if (matches.length === 0) return content

  const current = path.resolve(filepath)
  const nextVisited = new Set(visited)
  nextVisited.add(current)

  let result = content
  for (const match of matches) {
    const directive = match[0]
    const target = resolveDirectiveDir(path.dirname(current), match[1].trim())
    if (nextVisited.has(target)) {
      result = result.replace(directive, "")
      continue
    }
    const raw = yield* fs.readFileStringSafe(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (raw === undefined) {
      result = result.replace(directive, "")
      continue
    }
    const parsed = ConfigMarkdown.parseOption(raw)
    if (!parsed) {
      result = result.replace(directive, "")
      continue
    }
    const resolved = yield* inlineFileDirectives(parsed.content, target, fs, nextVisited)
    result = result.replace(directive, resolved)
  }
  return result
})