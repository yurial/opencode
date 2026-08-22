import matter from "gray-matter"
process.env.TMP = "/tmp"
const md = `---
permission:
  "*": allow
  external_directory:
    "{env:HOME}": allow
    "{env:TMP}": allow
  question: allow
---
body`
const substituted = md.replace(/\{env:([^}]+)\}/g, (_, varName: string) => {
  return (process.env[varName]) ?? ""
})
console.log("substituted:", substituted)
console.log("parsed:", JSON.stringify(matter(substituted).data, null, 2))
