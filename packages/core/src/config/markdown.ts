export * as ConfigMarkdown from "./markdown"

import matter from "gray-matter"
import os from "os"
import path from "path"

export function parse(content: string) {
  let result: ReturnType<typeof matter>
  try {
    result = matter(content)
  } catch {
    result = matter(sanitize(content))
    if (!Object.keys(result.data).length && content.match(/^---\r?\n/)) {
      throw new Error("frontmatter could not be parsed")
    }
  }
  return result
}

export function parseOption(content: string) {
  try {
    return parse(content)
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

function resolveDirectiveDir(dir: string, directivePath: string) {
  const expanded = directivePath.startsWith("~/") ? os.homedir() + directivePath.slice(1) : directivePath
  return path.resolve(dir, expanded)
}

export async function resolveFileDirectives(
  content: string,
  filepath: string,
  read: (path: string) => Promise<string | undefined>,
  visited: Set<string> = new Set(),
  baseDir?: string,
): Promise<string> {
  const matches = fileDirectives(content)
  if (matches.length === 0) return content

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
    const parsed = parseOption(raw)
    if (!parsed) {
      result = result.replace(directive, "")
      continue
    }
    const resolved = await resolveFileDirectives(parsed.content, target, read, nextVisited)
    result = result.replace(directive, resolved)
  }
  return result
}