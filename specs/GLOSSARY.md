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
| core-discard-context/attachment-id | The optional id of a file attachment of a V2 user message, assigned where the message projection creates the message from admitted session input; the part id under which a V2 user file part is marked, filtered, counted, and projected; an attachment persisted without the field is not addressable | core-discard-context |
| core-discard-context/discard-call | An assistant tool part whose tool name is `discard_context`; the durable record of one marking invocation, carrying the marked part ids in its input | core-discard-context |
| core-discard-context/discarded-token-total | The session-wide sum of output and reasoning tokens over fully-discarded-messages; identical for every marker surface of the session | core-discard-context (R7.1) |
| core-discard-context/fully-discarded-message | An assistant message whose every eligible content part (text, reasoning, or tool other than a discard-call) is a marked-part; the unit of exact token attribution | core-discard-context |
| core-discard-context/marked-ids | The deduplicated union of string ids collected from the inputs of every discard-call in the session history | core-discard-context (R3.1) |
| core-discard-context/marked-part | A content part of an assistant or user message whose id is a member of marked-ids; eligible part types are text, reasoning, and tool for assistant messages and text and file for user messages; in the V1 runtime an assistant tool part also matches when its provider call id is a member; in the V2 runtime a user file part also matches when its core-discard-context/attachment-id is a member | core-discard-context |
| core-discard-context/projected-id-marker | The fixed `[part id: <id>]` line placed on its own line at the start of a part's projected text on provider turns where the flag resolves enabled; projection-only, never present in durable history, session reads, marker surfaces, or exported transcripts | core-discard-context |
| core-discard-context/provider-call-id | The tool-call id under which a tool part appears in the provider context; in the V1 runtime it differs from the tool part's own id | core-discard-context |
| event-retention/prune-floor | For one aggregate, the minimum watermark for that aggregate over the maps currently in the window; aggregates absent from every live map have no floor and are never pruned | event-retention (R3) |
| event-retention/watermark | The per-aggregate value inside a posted map: a non-negative integer declaring the highest event seq the replica already possesses for that aggregate | event-retention |
| event-retention/watermark-map | The complete record a replica posts as the /sync/history request payload, mapping aggregate IDs to watermark values | event-retention |
| event-retention/window | The server's in-memory bounded collection of the most recently posted maps, each stamped with receipt time; bounded by SYNC_WATERMARK_WINDOW_SIZE and SYNC_WATERMARK_TTL | event-retention (R2) |
| tool-interactive/auto-feed cycle | The runtime-driven alternation in which every settled interactive tool result (bounded new output + status) is followed by an automatic continuation provider turn; the model initiates each exchange with start/write/wait and the runtime never starts a turn for background output | tool-interactive (R15) |
| tool-interactive/delivery cursor | The monotonically advancing byte offset of a job's spooled combined output up to which output has been embedded in tool results; bytes elided by chunk-cap truncation are never re-embedded | tool-interactive (R25) |
| tool-interactive/exchange | One auto-fed provider turn: the durable settlement of one interactive start/write/wait result followed by the automatic continuation turn; counted against the job's exchange budget, distinct from the agent step budget that it also consumes | tool-interactive (R18, R21) |
| tool-interactive/job | One spawned interactive child process (PTY, own process group) owned by a Session, identified by an opaque `ijob_*` jobID, spooling its combined output to a managed file, surviving across provider turns until exactly one terminal status | tool-interactive (R2) |
| tool-interactive/quiescence | `interactive.quiet_window_ms` elapsed with zero new output bytes while the process is alive; the settle condition that yields status `waiting` (the model's move) | tool-interactive (R10) |
| tool-interactive/terminal status | A job status that ends the job exactly once: `done` (exit 0), `failed` (non-zero exit, signal, or spawn failure), or `cancelled` (killed with a reason); alive statuses are exactly `waiting`, `running`, `timeout` | tool-interactive (R5–R6) |
| tui-session-display/empty-reasoning-part | A reasoning part whose text is empty after trimming and after dropping provider placeholder payloads; it carries no renderable body | tui-session-display |
| tui-session-display/meta-part | A generic persisted session part (dedicated meta type, kind + opaque payload) stored in the session database and replayed with history, rendered as transcript lines, and permanently excluded from provider context and copied/exported transcripts | tui-session-display |
| tui-session-display/reasoning-timer | Elapsed-time indicator of a reasoning part, derived only from its recorded start and end timestamps; live while unfinalized, fixed afterwards | tui-session-display |
| tui-session-display/thinking-mode | The reasoning display mode of the session screen: "show" renders reasoning bodies, "hide" collapses them to header lines; persisted TUI-locally | tui-session-display |
| tui-theme/ThemeJson | The theme JSON file composed of `$schema`, `defs`, and `theme` | tui-theme |
| tui-theme/VGA | The fixed ansiToRgba table mapping integer values 0–255 to RGBA; the terminal palette is never read | tui-theme (R3) |
| tui-theme/defs | Named constants declared in the theme file's `defs` section; a bare name in a value resolves as a `defs` reference first, then as a `theme` key | tui-theme (R2) |
| tui-theme/fadeColor | The fade-in α animation, `fadeColor(color, α)`, applied to the prompt meta line (agent name, model) | tui-theme |
| tui-theme/hover | Pointer hover over a card row; the row swaps its idle color pair for the hover pair | tui-theme (T10) |
| tui-theme/key | One of the 52 color keys plus `thinkingOpacity` mapped onto UI elements | tui-theme |
| tui-theme/scope | A tree-sitter highlight scope; scope names are external tree-sitter identifiers | tui-theme |
| tui-theme/selectedForeground | The foreground color over a highlighted surface: `selectedListItemText` if set, otherwise black/white by luminance over a transparent background, otherwise `background` | tui-theme (R6) |
| tui-theme/tint | The base + overlay α blend (prompt highlight, logo, bg-pulse, question model variant, diff-viewer fade) | tui-theme |
