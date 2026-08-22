export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

export async function load(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      console.error(`failed to parse agent markdown ${item}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    })
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])
    const body = md.content.trim()
    const frontmatterPrompt = md.data.prompt
    const prompt =
      frontmatterPrompt !== undefined
        ? await ConfigMarkdown.resolveFileDirectives(frontmatterPrompt, item, new Set(), dir).catch(
            () => frontmatterPrompt,
          )
        : await ConfigMarkdown.resolveFileDirectives(body, item).catch(() => body)

    const config = {
      name,
      ...md.data,
      prompt,
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      console.error(`failed to parse mode markdown ${item}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    })
    if (!md) continue

    const body = md.content.trim()
    const frontmatterPrompt = md.data.prompt
    const prompt =
      frontmatterPrompt !== undefined
        ? await ConfigMarkdown.resolveFileDirectives(frontmatterPrompt, item, new Set(), dir).catch(
            () => frontmatterPrompt,
          )
        : await ConfigMarkdown.resolveFileDirectives(body, item).catch(() => body)

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt,
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
