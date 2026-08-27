# Specification Glossary

| Term | Definition | Defined in |
|---|---|---|
| config-v1/channel | One of the three configuration input kinds: file key, environment variable, CLI flag | config-v1 |
| config-v1/config-document | One parsed JSONC file contributing keys to the effective V1 configuration | config-v1 |
| config-v1/global-config | Config documents read from the XDG config directory, overridable via OPENCODE_CONFIG_DIR | config-v1 |
| config-v1/instance-config | The merged effective configuration for one project instance | config-v1 |
| config-v1/managed-config | Administrator-authored config from a system managed directory or macOS managed preferences | config-v1 |
| config-v1/prime-time | Model-level usage window (primeTimeStart, primeTimeEnd, primeTimeDay) during which the model must not be used | config-v1 (R17) |
| config-v1/project-config | Config documents discovered by walking from the working directory up to the worktree root | config-v1 |
| config-v1/remote-config | Config fetched from a well-known URL of an authenticated server or an organization account | config-v1 |
| config-v1/tui-config | A tui.json/tui.jsonc document configuring the terminal UI | config-v1 |
| config-v1/variable-substitution | The {env:VAR} and {file:path} token expansion applied to config text before parsing | config-v1 |
| config-v2/directory-entry | A discovered .opencode directory whose resource subdirectories contribute entries | config-v2 |
| config-v2/document | An authored opencode.json/opencode.jsonc file contributing to one Location's configuration | config-v2 |
| config-v2/entry-list | Ordered list of documents and directory entries, lowest priority first, returned by the V2 config service | config-v2 |
| config-v2/location | The open project directory plus its project root; V2 config is read once per Location open | config-v2 |
| config-v2/patch-options | Request options authored as partial records (headers, body, aisdk) merged over catalog defaults | config-v2 |
