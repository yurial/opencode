import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Auth } from "../../src/auth"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Vcs } from "../../src/project/vcs"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { EventV2Bridge } from "../../src/event-v2-bridge"

export const workspaceLayerWithRuntimeFlags = (overrides: Partial<RuntimeFlags.Info>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Workspace.node,
      Auth.node,
      Session.node,
      SessionPrompt.node,
      Project.node,
      Vcs.node,
      Database.node,
      EventV2Bridge.node,
      FSUtil.node,
      InstanceStore.node,
      SessionStore.node,
    ]),
    [
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
      [RuntimeFlags.node, RuntimeFlags.layer(overrides)],
      // The workspace graph pulls in the scheduler (via the tool registry),
      // whose SessionExecution dependency is unbound; bind a real local
      // execution so served routes keep a working wake.
      [SessionExecution.node, SessionExecutionLocal.node],
    ],
  )
