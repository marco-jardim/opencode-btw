# opencode-btw

A TUI plugin for [opencode](https://github.com/anomalyco/opencode) that adds a `/btw` slash command — ask quick side-questions to the LLM without leaving or interrupting your current session.

```
/btw what's the difference between rebase and merge?
```

The answer streams into a floating panel above the prompt. Press **Ctrl+B** to dismiss.

## How it works

1. You type `/btw <question>` in the prompt and press Enter.
2. The plugin creates a **separate ephemeral session** (it does not touch your current conversation).
3. The response streams in real time into an inline panel rendered in the `session_above_prompt` slot.
4. When done (or at any point), press **Ctrl+B** to dismiss the panel. The ephemeral session is automatically deleted.

The plugin is fully self-contained — a single `src/index.tsx` file with no build step required.

## Requirements

- **opencode** with TUI plugin support (v1.3.4+)
- **Upstream patch** — this plugin depends on features not yet merged into upstream opencode:
  - `session_above_prompt` TUI slot
  - `onSlashSubmit` callback on `TuiCommand`
  - `handleSlash` dispatcher in the command system
  - Plugin loader fixes for TUI-only plugins

  See [Upstream Patch](#upstream-patch) below.

## Installation

### From local path

Clone the repo and add it to your **TUI config** (`tui.json`, not `opencode.json`):

```bash
git clone https://github.com/marco-jardim/opencode-btw
```

Then add to `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["/path/to/opencode-btw"]
}
```

> **Important**: This is a TUI-only plugin. It must be registered in `tui.json`, **not** in `opencode.json`. Placing it in `opencode.json` will cause the server plugin loader to fail because there is no server entrypoint.

### From npm (once published)

```bash
opencode plugin install opencode-btw
```

After installing, ensure it appears in your `tui.json` plugin list.

### From GitHub

```bash
opencode plugin install github:marco-jardim/opencode-btw
```

## Usage

Inside an active opencode session:

| Action               | Key                                                 |
| -------------------- | --------------------------------------------------- |
| Ask a question       | `/btw <your question>` + Enter                      |
| Dismiss the panel    | `Ctrl+B`                                            |
| Ask another question | `/btw <new question>` (replaces the previous panel) |

The command accepts any inline text after `/btw`. If you submit `/btw` with no arguments, nothing happens (the command is silently ignored).

The `/btw` command is **hidden** from the command palette — it only works as a slash command typed directly in the prompt. When you type `/btw ` (with a trailing space), the autocomplete dropdown closes automatically, and pressing Enter submits the command.

> **Why Ctrl+B and not Esc?** The opencode TUI has a global Esc handler in `app.tsx` that uses `useKeyHandler` (highest priority) with `stopPropagation()`. This captures Esc before any slot-level handler can intercept it. Ctrl+B avoids this conflict.

## Architecture

```
┌─────────────────────────────────────────────┐
│ opencode TUI                                │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │ scrollbox (messages)                   │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌─ btw ──────────────────────────────────┐ │ ← session_above_prompt slot
│  │  Q: what's the difference between ...  │ │
│  │                                        │ │
│  │  Rebase replays commits on top of ...  │ │ ← streamed response
│  │                                        │ │
│  │  press Ctrl+B to dismiss               │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │ prompt                                 │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Key design decisions

- **Ephemeral sessions**: Each `/btw` invocation creates and deletes its own session. Your main conversation is never touched.
- **State in `tui()` scope**: All Solid signals live in the outer `tui()` function, not inside the slot renderer. Slot renderers in opentui are re-invoked on state changes — if signals lived inside the renderer, they would be recreated and previous state would be lost.
- **Race safety**: A `pendingOp` promise chain serializes `ask` calls, preventing race conditions from rapid invocations.
- **Reactive streaming**: Uses Solid's `createEffect` inside the slot to reactively track message parts and session status — no polling.
- **Instant dismiss**: `dismiss()` calls `setVisible(false)` synchronously for immediate UI feedback, then performs async cleanup (abort + delete session) in the background.
- **Adaptive borders**: Panel border width adjusts dynamically to terminal dimensions minus padding (session container padding + box padding).
- **`useKeyboard` for Ctrl+B**: Uses `useKeyboard` (not `useKeyHandler`) because the slot context works with `useKeyboard`. The Ctrl modifier avoids conflicts with normal text input.

### Plugin API surface used

| API                            | Purpose                                     |
| ------------------------------ | ------------------------------------------- |
| `api.command.register()`       | Registers the `/btw` slash command          |
| `api.slots.register()`         | Renders the panel in `session_above_prompt` |
| `api.client.session.create()`  | Creates the ephemeral session               |
| `api.client.session.prompt()`  | Sends the question                          |
| `api.client.session.abort()`   | Aborts in-flight generation on dismiss      |
| `api.client.session.delete()`  | Cleans up the ephemeral session             |
| `api.state.session.messages()` | Reads streamed messages reactively          |
| `api.state.session.status()`   | Detects when generation is done             |
| `api.state.part()`             | Reads message parts (text content)          |
| `api.theme.current`            | Reads current theme colors                  |
| `api.route.current`            | Guards against non-session routes           |

## Upstream Patch

This plugin requires additions to opencode's TUI plugin infrastructure that are not yet in upstream. Until these are merged, you need to run a patched fork or apply the changes manually.

The patch covers 6 files:

### 1. `packages/plugin/src/tui.ts` — Types

Add `onSlashSubmit` to `TuiCommand` and `session_above_prompt` to `TuiHostSlotMap`:

```typescript
// In TuiCommand type, after onSelect:
onSlashSubmit?: (args: string) => boolean

// In TuiHostSlotMap, add new slot:
session_above_prompt: {
  session_id: string
}
```

### 2. `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — Slot rendering

Add the slot between the scrollbox and the permission prompt:

```tsx
<TuiPluginRuntime.Slot
  name="session_above_prompt"
  session_id={route.sessionID}
/>
```

### 3. `packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx` — Command dispatch

Add `onSlashSubmit` to `CommandOption` type and add `handleSlash` method:

```typescript
// In CommandOption type:
onSlashSubmit?: (args: string) => boolean

// New method in the command dialog init():
handleSlash(name: string, args: string): boolean {
  for (const option of entries()) {
    const slash = option.slash
    if (!slash) continue
    if (slash.name !== name && !slash.aliases?.includes(name)) continue
    if (option.onSlashSubmit) return option.onSlashSubmit(args)
    option.onSelect?.(dialog)
    return true
  }
  return false
},
```

### 4. `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — Submit intercept

Add a new `else if` branch in `submit()`, after the shell-mode block and before the existing slash command handler:

```typescript
} else if (
  inputText.startsWith("/") &&
  iife(() => {
    const firstLine = inputText.split("\n")[0]
    const [slashCmd, ...rest] = firstLine.split(" ")
    const name = slashCmd.slice(1)
    return command.handleSlash(name, rest.join(" "))
  })
) {
  setStore("prompt", "input", "")
  setStore("prompt", "parts", [])
  input.clear()
}
```

### 5. `packages/opencode/src/plugin/shared.ts` — Graceful skip in detect mode

In `readV1Plugin`, add early returns before the throws when `mode === "detect"`:

```typescript
if (kind === "server" && server === undefined) {
  if (mode === "detect") return; // <-- add this
  throw new TypeError(
    `Plugin ${spec} must default export an object with server()`,
  );
}
if (kind === "tui" && tui === undefined) {
  if (mode === "detect") return; // <-- add this
  throw new TypeError(
    `Plugin ${spec} must default export an object with tui()`,
  );
}
```

### 6. `packages/opencode/src/plugin/index.ts` — Skip legacy fallback for v1 TUI-only plugins

In `applyPlugin`, after `readV1Plugin` returns `undefined`, add a guard before the legacy fallback:

```typescript
const plugin = readV1Plugin(load.mod, load.spec, "server", "detect");
if (plugin) {
  // ... existing code ...
  return;
}
// Add this block:
if (plugin === undefined) {
  const def = load.mod.default;
  if (def && typeof def === "object" && ("tui" in def || "id" in def)) return;
}

for (const server of getLegacyPlugins(load.mod)) {
  // ... existing code ...
}
```

### Verifying the patch

```bash
# Should show onSlashSubmit on TuiCommand
grep -n "onSlashSubmit" packages/plugin/src/tui.ts

# Should show the new slot type
grep -n "session_above_prompt" packages/plugin/src/tui.ts

# Should show the Slot rendered in session
grep -n "session_above_prompt" packages/opencode/src/cli/cmd/tui/routes/session/index.tsx

# Should show handleSlash function
grep -n "handleSlash" packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx

# Should show detect mode guard
grep -n "detect.*return" packages/opencode/src/plugin/shared.ts
```

## Plugin Development Notes

Key things learned building this plugin:

1. **TUI plugins go in `tui.json`**, not `opencode.json`. The server plugin loader (`opencode.json`) will fail on TUI-only plugins unless the loader fixes (items 5-6 above) are applied.

2. **`package.json` must export `"./tui"`**. The TUI plugin loader resolves entrypoints via `exports["./tui"]`, not `exports["."]`:

   ```json
   {
     "exports": {
       ".": "./src/index.tsx",
       "./tui": "./src/index.tsx"
     }
   }
   ```

3. **The `id` field is required** in the default export for file-based (local path) plugins:

   ```typescript
   export default { id: "opencode-btw", tui } satisfies TuiPluginModule;
   ```

4. **JSX pragma is required**. The `tsconfig.json` `jsxImportSource` is ignored by the runtime — you must include the pragma in every `.tsx` file:

   ```typescript
   /** @jsxImportSource @opentui/solid */
   ```

5. **Signals must live outside the slot renderer**. Slot renderers are re-invoked by Solid on state changes. If you declare `createSignal` inside the renderer, each re-invocation creates fresh signals, losing previous state. Declare signals in the `tui()` function scope instead.

6. **`useKeyboard` works in slots, but Esc is globally captured**. The `app.tsx` global handler intercepts Esc with `useKeyHandler` + `stopPropagation()` before any slot handler. Use a Ctrl combo (like Ctrl+B) instead.

7. **`console.log` is not visible** in the TUI. For debugging, write to a file: `require("fs").appendFileSync("/path/to/debug.log", message)`.

## Development

```bash
# Clone the repo
git clone https://github.com/marco-jardim/opencode-btw
cd opencode-btw

# Install dependencies
bun install

# Typecheck
bun run tsc --noEmit

# Add to tui.json for testing
# ~/.config/opencode/tui.json:
# { "plugin": ["/path/to/opencode-btw"] }
```

The plugin is a single `.tsx` file with no build step — opencode loads it directly via its plugin system.

### Project structure

```
opencode-btw/
  src/
    index.tsx      # Full plugin implementation
  package.json     # Plugin metadata with ./tui export
  tsconfig.json    # TypeScript config with @opentui/solid JSX
  LICENSE          # MIT
  README.md        # This file
```

## Peer dependencies

| Package               | Version |
| --------------------- | ------- |
| `@opencode-ai/plugin` | ≥ 1.3.7 |
| `@opencode-ai/sdk`    | ≥ 1.3.7 |
| `@opentui/solid`      | ≥ 0.1.0 |
| `solid-js`            | ≥ 1.9.0 |

These are provided by the opencode runtime — you don't need to install them separately.

## License

[MIT](LICENSE)
