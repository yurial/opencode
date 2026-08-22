export * as ConfigMarkdown from "./markdown"

import matter from "gray-matter"
import os from "os"
import path from "path"

/**
 * Parse a markdown document into its YAML frontmatter `data` and body `content`.
 *
 * `{env:NAME}` placeholders are substituted in the raw text before YAML parsing
 * so values referencing the host environment land as plain strings in `data`
 * (and as plain text in `content`). Substitution order is `env[NAME]`
 * (when an `env` map is provided) then `process.env[NAME]`; missing variables
 * resolve to the empty string. YAML parse failures fall back to a more
 * permissive colon-tolerant parser; if even that yields no frontmatter data
 * while the input starts with `---\n`, an error is raised.
 *
 * @param content raw markdown source, including any frontmatter block
 * @param env optional override map consulted before `process.env` for `{env:NAME}`
 * @returns `{ data, content }` where `data` is the parsed frontmatter object
 *   and `content` is the markdown body without the frontmatter block
 * @throws Error when the frontmatter opens with `---\n` but cannot be parsed
 *   even after the permissive fallback
 */
export function parse(content: string, env?: Record<string, string>) {
  const substituted = resolveEnvDirectives(content, env)
  let result: ReturnType<typeof matter>
  try {
    result = matter(substituted)
  } catch {
    result = matter(sanitize(substituted))
    if (!Object.keys(result.data).length && content.match(/^---\r?\n/)) {
      throw new Error("frontmatter could not be parsed")
    }
  }
  return result
}

/**
 * Lenient variant of {@link parse} that returns `undefined` instead of throwing
 * when the frontmatter is unrecoverable. `{env:NAME}` substitution still runs
 * before parsing so the same env semantics apply.
 *
 * @param content raw markdown source
 * @param env optional override map consulted before `process.env`
 * @returns parsed `{ data, content }`, or `undefined` when parsing fails
 */
export function parseOption(content: string, env?: Record<string, string>) {
  try {
    return parse(content, env)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}

export const FILE_DIRECTIVE_REGEX = /\{file:([^}]+)\}/g

export function fileDirectives(template: string) {
  return Array.from(template.matchAll(FILE_DIRECTIVE_REGEX))
}

/**
 * Matches `{env:NAME}` directives where `NAME` contains no `}`. The capture
 * group holds the variable name.
 */
export const ENV_DIRECTIVE_REGEX = /\{env:([^}]+)\}/g

/**
 * Extract every `{env:NAME}` occurrence in `template`.
 *
 * @param template source text to scan
 * @returns array of `RegExpMatchArray` whose `[0]` is the full directive and
 *   `[1]` is the captured variable name (already non-empty)
 */
export function envDirectives(template: string) {
  return Array.from(template.matchAll(ENV_DIRECTIVE_REGEX))
}

/**
 * Substitute every `{env:NAME}` placeholder in `content` with the value of the
 * named environment variable.
 *
 * Lookup order per directive: `env?.[NAME]`, then `process.env[NAME]`. A missing
 * variable in both sources resolves to the empty string, matching the
 * behaviour of `ConfigVariable.substitute` for JSON config substitution. The
 * operation is a plain text replacement, so call it on raw markdown before
 * YAML parsing when the value should land inside frontmatter.
 *
 * @param content source text that may contain `{env:NAME}` directives
 * @param env optional override map consulted before `process.env`
 * @returns text with every `{env:NAME}` placeholder replaced
 */
export function resolveEnvDirectives(content: string, env?: Record<string, string>): string {
  return content.replace(ENV_DIRECTIVE_REGEX, (_, varName: string) => {
    return (env?.[varName] ?? process.env[varName]) ?? ""
  })
}

function resolveDirectiveDir(dir: string, directivePath: string) {
  const expanded = directivePath.startsWith("~/") ? os.homedir() + directivePath.slice(1) : directivePath
  return path.resolve(dir, expanded)
}

/**
 * Resolve every `{file:path}` directive in `content` by reading the referenced
 * file and inlining its body in place of the directive.
 *
 * After all file inclusions resolve, `{env:NAME}` directives remaining in the
 * assembled text are substituted through {@link resolveEnvDirectives}, so env
 * placeholders placed in either the original content or any inlined file body
 * are resolved in one pass. Recursive `{file:}` chains follow, with cycle
 * detection against `visited` paths. A missing, unreadable, or unparseable
 * referenced file is replaced with an empty string instead of throwing.
 *
 * @param content text that may contain `{file:path}` and `{env:NAME}` directives
 * @param filepath absolute path of the file owning `content`, used as the
 *   source identifier for cycle detection and as the base directory for
 *   relative `{file:}` paths when `baseDir` is not provided
 * @param read async reader returning the file body or `undefined` when absent
 * @param visited absolute paths already followed in the current resolution
 *   chain; cycles are replaced with an empty string and the chain continues
 * @param baseDir directory used to resolve relative `{file:}` paths; defaults
 *   to the directory of `filepath`
 * @param env optional override map consulted before `process.env` for the
 *   final env substitution pass
 * @returns the content with all `{file:}` and `{env:}` directives resolved
 */
export async function resolveFileDirectives(
  content: string,
  filepath: string,
  read: (path: string) => Promise<string | undefined>,
  visited: Set<string> = new Set(),
  baseDir?: string,
  env?: Record<string, string>,
): Promise<string> {
  const matches = fileDirectives(content)
  if (matches.length === 0) return resolveEnvDirectives(content, env)

  const current = path.resolve(filepath)
  const base = baseDir ?? path.dirname(current)
  const nextVisited = new Set(visited)
  nextVisited.add(current)

  let result = content
  for (const match of matches) {
    const directive = match[0]
    const target = resolveDirectiveDir(base, match[1].trim())
    if (nextVisited.has(target)) {
      result = result.replace(directive, "")
      continue
    }
    const raw = await read(target)
    if (raw === undefined) {
      result = result.replace(directive, "")
      continue
    }
    const parsed = parseOption(raw, env)
    if (!parsed) {
      result = result.replace(directive, "")
      continue
    }
    const resolved = await resolveFileDirectives(parsed.content, target, read, nextVisited, undefined, env)
    result = result.replace(directive, resolved)
  }
  return resolveEnvDirectives(result, env)
}
