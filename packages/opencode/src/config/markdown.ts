import { Filesystem } from "@/util/filesystem"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export const fallbackSanitization = ConfigMarkdownCore.sanitize

export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)

  try {
    return ConfigMarkdownCore.parse(template)
  } catch (err) {
    throw new FrontmatterError(
      {
        path: filePath,
        message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      },
      { cause: err },
    )
  }
}

export const FILE_DIRECTIVE_REGEX = ConfigMarkdownCore.FILE_DIRECTIVE_REGEX
export const fileDirectives = ConfigMarkdownCore.fileDirectives

export async function resolveFileDirectives(
  content: string,
  filepath: string,
  visited: Set<string> = new Set(),
  baseDir?: string,
): Promise<string> {
  return ConfigMarkdownCore.resolveFileDirectives(
    content,
    filepath,
    async (p) => {
      try {
        return await Filesystem.readText(p)
      } catch {
        return undefined
      }
    },
    visited,
    baseDir,
  )
}

export * as ConfigMarkdown from "./markdown"