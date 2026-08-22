export * as InlineFiles from "./inline-files"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { ConfigMarkdown, envDirectives, fileDirectives } from "../config/markdown"
import { FSUtil } from "../fs-util"

function resolveDirectiveDir(dir: string, directivePath: string) {
  const expanded = directivePath.startsWith("~/") ? os.homedir() + directivePath.slice(1) : directivePath
  return path.resolve(dir, expanded)
}

/**
 * Resolve every `{file:path}` directive in `content` (read from `filepath`) and
 * inline the referenced files' bodies.
 *
 * Mirrors the behaviour of {@link ConfigMarkdown.resolveFileDirectives} for
 * Effect-based callers: recursive `{file:}` chains with cycle detection,
 * missing/unreadable references replaced by empty strings, and a final pass
 * that substitutes `{env:NAME}` placeholders through
 * {@link ConfigMarkdown.resolveEnvDirectives} once every inclusion has been
 * resolved.
 *
 * @param content text that may contain `{file:path}` and `{env:NAME}` directives
 * @param filepath absolute path of the file owning `content`, used for cycle
 *   detection and as the base directory for relative `{file:}` paths
 * @param fs filesystem service used to read referenced files
 * @param visited absolute paths already followed in the current resolution
 *   chain; defaults to an empty set
 * @param env optional override map consulted before `process.env` for the
 *   final env substitution pass
 * @returns the content with every `{file:}` and `{env:}` directive resolved
 */
export const inlineFileDirectives: (
  content: string,
  filepath: string,
  fs: FSUtil.Interface,
  visited?: Set<string>,
  env?: Record<string, string>,
) => Effect.Effect<string, never, never> = Effect.fnUntraced(function* (
  content: string,
  filepath: string,
  fs: FSUtil.Interface,
  visited: Set<string> = new Set(),
  env?: Record<string, string>,
) {
  const matches = fileDirectives(content)
  const envMatches = envDirectives(content)
  if (matches.length === 0 && envMatches.length === 0) return content

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
    const parsed = ConfigMarkdown.parseOption(raw, env)
    if (!parsed) {
      result = result.replace(directive, "")
      continue
    }
    const resolved = yield* inlineFileDirectives(parsed.content, target, fs, nextVisited, env)
    result = result.replace(directive, resolved)
  }
  return ConfigMarkdown.resolveEnvDirectives(result, env)
})
