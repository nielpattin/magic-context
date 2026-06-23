# Magic Context Fork — Sync & Maintenance Runbook

This is the **local Pi fork** of [`cortexkit/magic-context`](https://github.com/cortexkit/magic-context).
Upstream is tracked as `origin`; all local changes live on the **`pi-local`** branch. Never commit on `master`.

Read this doc whenever you need to update the fork from upstream or apply a local fix.

## Current setup

| What | Value |
| --- | --- |
| Fork path | `C:\Users\niel\.pi\agent\magic-context` |
| Working branch | `pi-local` (based on `origin/master`; at setup: HEAD `f3e681b`, past tag `v0.26.0`) |
| Upstream remote | `origin` → `https://github.com/cortexkit/magic-context` |
| Pi extension package | `packages/pi-plugin` (`@cortexkit/pi-magic-context`), flat self-contained `src/` |
| Build output | `packages/pi-plugin/dist/index.js` (+ `dist/subagent-entry.js`) |
| Pi registration | `~/.pi/agent/settings.json` → `packages` entry: source `...\magic-context\packages\pi-plugin`, extensions `["+dist\index.js"]` |
| Pi config | `~/.pi/agent/magic-context.jsonc` (fork-agnostic; schema: `assets/magic-context.schema.json`) |

### How Pi loads the fork
Pi loads the **built** `packages/pi-plugin/dist/index.js`, not source. So after **any** code change you must **rebuild** and **restart Pi**.

The build is a bun bundle that **externalizes** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@huggingface/transformers`, and `node:sqlite` (these come from Pi's runtime). Do not bundle them in.

### Upstream architecture (so comparisons make sense)
Upstream is a bun monorepo with two independent packages:
- `packages/pi-plugin` = `@cortexkit/pi-magic-context` — the Pi integration (flat `src/`, self-contained, does **not** import the opencode package). **This is what we fork-use.**
- `packages/plugin` = `@cortexkit/opencode-magic-context` — host-agnostic core for OpenCode (nested `agents/config/features/hooks/plugin/shared/tools/tui`). Not used by Pi.

Our fork clones upstream as-is, so local `packages/pi-plugin/src/` mirrors upstream `packages/pi-plugin/src/`. Sync comparison is `src/` vs `src/`.

---

## Local patches on `pi-local` (uncommitted)

The following changes are staged/unstaged on `pi-local` on top of the upstream base. They have NOT been committed yet.

### 1. Windows subagent spawn fixes (`subagent-runner.ts`)

Three bugs prevented the historian/dreamer/sidekick subagent from spawning on Windows. All fixes are in `packages/pi-plugin/src/subagent-runner.ts`.

#### 1a. ENOENT — `pi` binary not found (cortexkit/magic-context#177)
- **Root cause:** `resolveBundledPiCli()` used CJS `require.resolve("@earendil-works/pi-coding-agent/package.json")`, but that package is ESM-only (exports has no `require` condition) → throws `ERR_PACKAGE_PATH_NOT_EXPORTED` → returns null → falls back to `spawn("pi")` → Windows can't execute the pnpm `.cmd` shim without `shell:true` → `ENOENT`.
- **Fix:** Removed `resolveBundledPiCli()`. Added `resolveHostPiCli()` which returns `process.argv[1]` (the host Pi's own `cli.js` path, since the plugin runs inside the host `pi` process invoked as `node .../dist/cli.js`). The runner spawns `process.execPath` with `[cli.js, ...args]` via a `spawnViaNode` flag. No bundled/PATH fallback. The child runs the SAME Pi version as the host (0.79.x, not the stale bundled 0.74.0 dev-dep).

#### 1b. ENAMETOOLONG — system prompt exceeds Windows 32K cmdline limit
- **Root cause:** After the ENOENT fix let spawns succeed, Windows' `CreateProcessW` 32,767 character command-line limit was immediately exposed. The historian system prompt (~60KB) passed via `--system-prompt` in argv alone exceeds this limit.
- **Fix:** Added `WINDOWS_CMDLINE_SAFE_MAX = 24_000` (conservative ceiling under CreateProcessW's 32K hard limit). Added `estimateCmdlineLength(args, execPath, piBinary)` — conservative upper-bound estimator. When `floodStd` is true (total cmdline with full system prompt exceeds 24K on Windows), set a short neutral system prompt via `--system-prompt` (`SHORT_SYSTEM_PROMPT_LABEL`) and prepend the full system prompt to stdin content as `systemPrompt + "\n\n" + userMessage`. No conflicting system prompt means the user-content instructions take effect. `buildArgs` accepts `shortSystemPrompt` flag.

#### 1c. Historian returning coding-agent responses (not compartment summaries)
- **Root cause:** The ENAMETOOLONG fix piped the system prompt to stdin, but Pi treats stdin as user content (concatenated into the initial user message in print mode), not as a system prompt. The child Pi ran with Pi's default "coding agent" system prompt, and the historian instructions in stdin became user-level content the model treated as a coding-agent request.
- **Fix:** On Windows when `floodStd` is true, set a short neutral system prompt (`SHORT_SYSTEM_PROMPT_LABEL`: "You are a conversation historian. Produce structured compartment summaries following the format specified in the user message.") via `--system-prompt`, and prepend the full ~60KB historian prompt to stdin content. The short label replaces Pi's default coding-agent prompt so it doesn't conflict with the historian role. The full instructions in user content take effect.

### 2. `/mc-stream` — full-screen TUI for live subagent streaming

Four new files provide a `/mc-stream` slash command that opens a full-screen overlay showing live historian/dreamer/sidekick subagent output.

#### `subagent-stream-bus.ts` — process-global event bus
- Singleton event bus that buffers all progress events per run (capped at 20 runs, 500 events each).
- Subscribers get notified on every update via `subscribe()`.
- `getCurrentRun()` prefers RUNNING runs over finished ones (so a skip/no-op that finishes instantly doesn't shadow an active background recomp).
- `removeRun()` removes skip/no-op runs with zero events from the bus entirely.
- Events keyed by `runId` with human label (e.g. `historian[first]`, `recomp[1]`).

#### `subagent-stream-view.ts` — full-screen TUI component
- Renders header (agent label, status icon, elapsed time, model), streaming content, footer (keybindings + scroll %).
- **Thinking extraction:** Pi stores thinking content in `block.thinking`, NOT `block.text`. The `extractContentParts` function checks `b.thinking` for `type: "thinking"` and `type: "reasoning"` blocks. Text blocks use `b.text` as usual.
- **Streaming:** `message_update` events carry `assistantMessageEvent.partial.content` with streaming deltas. Both `message.content` and `assistantMessageEvent.partial.content` are checked independently (not gated by `!text`) so thinking and text can coexist in different fields.
- `message_end` provides the final complete output.
- Auto-scrolls to bottom while running; arrow keys/PgUp/PgDn/Home/End to scroll manually.
- 100% width, 100% height, no border styling. Viewport = full terminal rows minus 4 chrome lines (header status, header separator, footer separator, footer).
- Modeled on pi-subagents' `ConversationViewer` (`packages/packages/pi-subagents/src/ui/conversation-viewer.ts`).

#### `commands/mc-stream.ts` — slash command registration
- Registers `/mc-stream`. Opens `ctx.ui.custom()` with overlay mode (`overlay: true`, `width: "100%"`, `maxHeight: "100%"`).
- Factory returns a `StreamViewer` component.

#### Wiring in `pi-historian-runner.ts`, `pi-recomp-runner.ts`, `pi-recomp-client-shared.ts`
- `pi-historian-runner.ts`: `buildProgressLogger` creates a `runId` per pass, calls `bus.startRun()` on first `spawned` event, `bus.publish()` for every event, `bus.finishRun()` on `child_exit`.
- `pi-recomp-runner.ts`: `spawnPiRecompRun` immediately starts a bus run (`recomp/upgrade`) the moment it fires, before `work()` runs, so the bus has an entry from the instant the status line lights up. On completion, if zero subagent events were published (skip/no-op), `removeRun()` clears it instead of marking it DONE.
- `pi-recomp-client-shared.ts`: each `runner.run()` call gets a unique `runId` with labeled pass counter (`recomp[1]`, `recomp[2]`, etc.). `onProgress` calls `streamBus.startRun()` on first `spawned`, `streamBus.publish()` for every event, `streamBus.finishRun()` on `child_exit`.

#### `index.ts` — command registration
- Imports and registers `registerMcStreamCommand(pi)` alongside other `/ctx-*` commands.

### 3. Status line update (`status-line.ts`)
- Minor update to surface recomp/stream status.

### Key technical discoveries

- **Pi's `session.subscribe` (print mode) DOES emit `message_update` events** with `assistantMessageEvent` containing streaming deltas (`text_delta`, `partial`). Earlier code comments claiming only `message_start`/`message_end` were emitted were WRONG. Proven via Pi's `agent-session.js` line 274-275 (`_handleAgentEvent` calls `this._emit(event)` for ALL events) and `print-mode.js` line 80-82 (subscribes to all session events, writes to stdout unfiltered).
- **Pi stores thinking content in `block.thinking`, NOT `block.text`.** Proven via Pi's `assistant-message.js` line 71 (`content.type === "thinking" && content.thinking.trim()`) and `export-html/template.js` line 1249 (`block.type === 'thinking' && block.thinking.trim()`).
- **Windows `CreateProcessW` cmdline limit is 32,767 characters.** Conservative safe ceiling is 24K to leave headroom for libuv quoting/escaping expansion.
- **Pi's `.cmd` shim on Windows cannot be spawned via Node `spawn` without `shell:true`.** The fix spawns `process.execPath` (node) with `[cli.js, ...args]` instead.

---

## Workflow A — when upstream releases a new version

### 1. Fetch latest
```bash
cd ~/.pi/agent/magic-context
git fetch origin --tags
```
See what's new:
```bash
git tag -l 'v0.*' | sort -V | tail          # latest tags
git log --oneline pi-local..origin/master    # commits upstream has that pi-local lacks
```

### 2. Inspect the new version in a throwaway worktree (don't touch pi-local)
```bash
git worktree add --detach ~/.cache/mc-new <new-tag>   # or origin/master
```
(For read-only inspection you can also point the librarian skill at `cortexkit/magic-context`.)

### 3. Compare new upstream vs local pi-local
```bash
NEW=~/.cache/mc-new/packages/pi-plugin
LOCAL=~/.pi/agent/magic-context/packages/pi-plugin

# file-level: only-upstream / only-local / differ
diff -rq "$NEW/src" "$LOCAL/src"

# line-level churn across shared files
echo "upstream-side: $(diff -r "$NEW/src" "$LOCAL/src" | grep -c '^<')"
echo "local-side:    $(diff -r "$NEW/src" "$LOCAL/src" | grep -c '^>')"

# non-test files upstream added that we lack
diff -rq "$NEW/src" "$LOCAL/src" | grep 'Only in.*mc-new' | grep -v '\.test\.ts'

# recent upstream changelog
sed -n '1,80p' ~/.cache/mc-new/CHANGELOG.md
```
Clean up the worktree when done: `git worktree remove --force ~/.cache/mc-new`

### 4. Update pi-local
- **Rebase (recommended):** `git checkout pi-local && git rebase <new-tag>` (or `origin/master`).
  - If pi-local has local fixes, rebase replays them; resolve conflicts per file. The local patches above (especially `subagent-runner.ts`) will likely conflict if upstream touches the same areas.
- **Selective:** cherry-pick specific commits with `git cherry-pick <sha>`.

### 5. Rebuild + reload
```bash
cd ~/.pi/agent/magic-context/packages/pi-plugin && bun run build
```
Then **restart Pi** to load the new `dist/index.js`.

### 6. Verify
- Restart Pi; confirm magic-context loads with no extension errors.
- If upstream changed the config schema, diff `assets/magic-context.schema.json` and merge any new keys into `~/.pi/agent/magic-context.jsonc`.
- Verify `/mc-stream` works during a `/ctx-recomp` run.
- Verify subagent spawn works on Windows (historian auto-triggers or manual `/ctx-recomp`).

---

## Workflow B — apply a local fix on top of upstream
```bash
cd ~/.pi/agent/magic-context
git checkout pi-local          # always work on pi-local
# ...edit packages/pi-plugin/src/...
cd packages/pi-plugin && bun run build
# restart Pi to load the rebuilt dist
git add -p && git commit -m "fix(pi-plugin): <what>"
```
To later pull upstream on top of local fixes: `git fetch origin && git rebase origin/master`, then rebuild.

---

## Gotchas
- **Pi version drift:** upstream `pi-plugin` peer-deps target Pi `^0.74.0`; this Pi runs `0.79.x`. If the build loads but errors at runtime, suspect Pi API drift (upstream usually keeps parity, but verify).
- **Don't bundle runtime externals** (`@earendil-works/pi-*`, `@huggingface/transformers`, `node:sqlite`) — they're provided by Pi.
- **Always rebuild after code changes** — Pi loads `dist/`, not `src/`.
- The old `@nielpattin/pi-magic-context` monorepo package was removed (pi-packages commit `ed89ed9`). This fork is the only magic-context.
- **Windows spawn fixes are critical:** without the `subagent-runner.ts` patches, the historian/dreamer/sidekick cannot spawn on Windows (ENOENT, ENAMETOOLONG, or coding-agent role corruption). If rebasing onto a new upstream version, these patches MUST be preserved.
- **Thinking content field:** Pi uses `block.thinking` for thinking blocks, not `block.text`. Any extraction code must check `b.thinking`.
- **`/mc-stream` event bus is process-global:** the bus singleton survives across command invocations within the same Pi process. Runs are cleaned up on `child_exit` or when a skip/no-op produces zero events.

---

## Quick "AI, update the fork" prompt
> Read `~/.pi/agent/magic-context/FORK-SYNC.md`. Fetch the latest upstream tag for `cortexkit/magic-context`, compare `packages/pi-plugin/src` (new tag) against the local `pi-local` branch, summarize what's new/changed (new files, churn, changelog highlights). Then rebase `pi-local` onto the new tag, run `bun run build` in `packages/pi-plugin`, and tell me to restart Pi. If there are conflicts or config-schema changes, stop and report. Pay special attention to `subagent-runner.ts` — the Windows spawn fixes (ENOENT, ENAMETOOLONG, historian role) must be preserved during rebase.
