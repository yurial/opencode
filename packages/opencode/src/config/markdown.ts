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

export const ENV_DIRECTIVE_REGEX = ConfigMarkdownCore.ENV_DIRECTIVE_REGEX
export const envDirectives = ConfigMarkdownCore.envDirectives

export const resolveEnvDirectives = ConfigMarkdownCore.resolveEnvDirectives

/**
 * Opencode wrapper around {@link ConfigMarkdownCore.resolveFileDirectives} that
 * threads the project's filesystem reader through and preserves the optional
 * `baseDir` / `env` arguments. See core docs for the full contract.
 */
export async function resolveFileDirectives(
  content: string,
  filepath: string,
  visited: Set<string> = new Set(),
  baseDir?: string,
  env?: Record<string, string>,
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
    env,
  )
}

export * as ConfigMarkdown from "./markdown"
