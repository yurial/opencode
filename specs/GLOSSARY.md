# Specification Glossary

| Term | Definition | Defined in |
|---|---|---|
| config-v1/channel | One of the three configuration input kinds: file key, environment variable, CLI flag | config-v1 |
| config-v1/config-document | One parsed JSONC file contributing keys to the effective V1 configuration | config-v1 |
| config-v1/global-config | Config documents read from the XDG config directory, overridable via OPENCODE_CONFIG_DIR | config-v1 |
| config-v1/instance-config | The merged effective configuration for one project instance | config-v1 |
| config-v1/managed-config | Administrator-authored config from a system managed directory or macOS managed preferences | config-v1 |
| config-v1/prime-time | Model-level usage window (primeTimeStart, primeTimeEnd, primeTimeDay), evaluated in the window's timezone (explicit offset shared by both bounds, or process-local when neither has one), during which the model must not be used; with primeTimeRetry the block is retryable and the retry is scheduled at the window end, falling back to standard backoff when no window end exists; otherwise it is terminal | config-v1 (R17, R18) |
| config-v1/project-config | Config documents discovered by walking from the working directory up to the worktree root | config-v1 |
| config-v1/remote-config | Config fetched from a well-known URL of an authenticated server or an organization account | config-v1 |
| config-v1/tui-config | A tui.json/tui.jsonc document configuring the terminal UI | config-v1 |
| config-v1/variable-substitution | The {env:VAR} and {file:path} token expansion applied to config text before parsing | config-v1 |
| config-v2/directory-entry | A discovered .opencode directory whose resource subdirectories contribute entries | config-v2 |
| config-v2/document | An authored opencode.json/opencode.jsonc file contributing to one Location's configuration | config-v2 |
| config-v2/entry-list | Ordered list of documents and directory entries, lowest priority first, returned by the V2 config service | config-v2 |
| config-v2/location | The open project directory plus its project root; V2 config is read once per Location open | config-v2 |
| config-v2/patch-options | Request options authored as partial records (headers, body, aisdk) merged over catalog defaults | config-v2 |
| event-retention/prune-floor | For one aggregate, the minimum watermark for that aggregate over the maps currently in the window; aggregates absent from every live map have no floor and are never pruned | event-retention (R3) |
| event-retention/watermark | The per-aggregate value inside a posted map: a non-negative integer declaring the highest event seq the replica already possesses for that aggregate | event-retention |
| event-retention/watermark-map | The complete record a replica posts as the /sync/history request payload, mapping aggregate IDs to watermark values | event-retention |
| event-retention/window | The server's in-memory bounded collection of the most recently posted maps, each stamped with receipt time; bounded by SYNC_WATERMARK_WINDOW_SIZE and SYNC_WATERMARK_TTL | event-retention (R2) |
| tui-session-display/empty-reasoning-part | A reasoning part whose text is empty after trimming and after dropping provider placeholder payloads; it carries no renderable body | tui-session-display |
| tui-session-display/meta-part | A generic persisted session part (dedicated meta type, kind + opaque payload) stored in the session database and replayed with history, rendered as transcript lines, and permanently excluded from provider context and copied/exported transcripts | tui-session-display |
| tui-session-display/reasoning-timer | Elapsed-time indicator of a reasoning part, derived only from its recorded start and end timestamps; live while unfinalized, fixed afterwards | tui-session-display |
| tui-session-display/thinking-mode | The reasoning display mode of the session screen: "show" renders reasoning bodies, "hide" collapses them to header lines; persisted TUI-locally | tui-session-display |
