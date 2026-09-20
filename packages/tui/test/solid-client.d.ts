// The client build of solid-js exposes no bundled types; its API surface is
// identical to the typed main export. Tests import the client build directly
// because bun resolves the bare "solid-js" export to the server build under
// test conditions, and only the client build is reactive.
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}
