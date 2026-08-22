import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"
process.env.TMP = "/tmp"
const md = await Bun.file("/home/iu.diachenko/.config/opencode/agents/main.md").text()
const parsed = ConfigMarkdownCore.parse(md)
console.log("permission.external_directory:", JSON.stringify(parsed.data.permission?.external_directory, null, 2))

const md2 = `---
permission:
  external_directory:
    "{env:HOME}": allow
    "{env:TMP}": allow
---`
const parsed2 = ConfigMarkdownCore.parse(md2)
console.log("inline test:", JSON.stringify(parsed2.data.permission?.external_directory, null, 2))
