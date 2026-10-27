import { createSimpleContext } from "./helper"

// `reason` is rendered to stderr by the app epilogue; `cause` tags the exit
// trigger for the lifecycle record (R4.2-R4.4) and defaults to "exit".
export type Exit = (reason?: unknown, cause?: string) => void

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { exit: Exit }) => input.exit,
})
