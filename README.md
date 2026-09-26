# mcpelauncher-agent

MCP server that drives the **real** Minecraft Bedrock client through the agent socket added to the
[bedrock-mc mcpelauncher fork](https://github.com/bedrock-mc/mcpelauncher-manifest). Input is injected
below the game (same path as a keyboard and mouse), frames are read back from the GL framebuffer, and no
game symbols are involved — so it survives game updates the launcher itself supports.

## Requirements

- macOS, Apple Silicon, the fork's `mcpelauncher-client-arm64-v8a` installed in
  `/Applications/Minecraft Bedrock Launcher.app` (or `MCPELAUNCHER_APP=<app path>`), a version installed
  through the launcher UI, and a signed-in Xbox account in that data dir.
- [Bun](https://bun.sh).

Truly headless is not possible: Metal needs a logged-in GUI session. The window stays hidden by default and
renders at a low frame cap, so several instances fit on one machine.

### iOS backend

`launch` with `backend: "ios"` (or `MCPELAUNCHER_BACKEND=ios` to make it the default) drives the decrypted
iOS client under PlayCover instead, through the agent server in
[bedrock-mc/mcbe-macos](https://github.com/bedrock-mc/mcbe-macos)'s `libmacfix` (enabled by
`MACFIX_AGENT_PORT`, TCP on 127.0.0.1). It needs that app installed and patched with `scripts/setup.sh`
(`MCPE_IOS_APP=<app path>` to override the PlayCover location; `MCPE_IOS_AGENT_PORT`, default 47555).

- One instance per Mac, with the app's own data container: `data_dir` is rejected, and `width`/`height`/
  `hidden` are ignored (the window is visible, sized by PlayCover's settings).
- `launch` quits PlayCover first and refuses to start when PlayCover's keychain database is empty (PlayCover
  encrypts it whenever the game exits while PlayCover runs; launch the game once from PlayCover to restore it).
- Screenshot and click coordinates are the game's render pixels. The real Mac pointer still reaches the game,
  so keep it off the window while an agent drives it.
- `type` needs a focused text box (`state.text_input`): chat opens unfocused, and Enter or a click focuses it
  (`chat` does this). `scroll` has no horizontal axis. `cursor_locked` is true only while macOS captures the
  pointer (full screen); `pointer_lock_requested` says the game wants it (in-world).
- `stop` takes ~35 s: UIKit waits for the game's background tasks before it exits, then the process is killed
  if it is still alive.

## Run

```
bun install
bun run src/index.ts
```

Claude Code: `claude mcp add minecraft -- bun run /path/to/mcpelauncher-agent/src/index.ts`.

## Tools

`launch` · `stop` · `list` · `state` · `screenshot` · `key` · `hold_key` · `type` · `chat` · `look` ·
`click` · `mouse_move_to` · `scroll` · `add_server` · `open_uri` · `set_fps` · `wait` · `log`

Every tool takes an optional `instance`; `launch` with a separate `data_dir` gives each bot its own login and
worlds (Android backend only).

## Socket protocol

The launcher client listens on `--agent-socket <path>` (the iOS client on `127.0.0.1:$MACFIX_AGENT_PORT`) and
speaks one JSON object per line:

| cmd | fields | reply |
|---|---|---|
| `state` | | `width height focused fps fps_cap cursor_locked mouse_x mouse_y` |
| `screenshot` | `width?` `height?` | `png_base64 width height` |
| `key` | `key` `action=tap\|press\|release` `hold_ms` `mods[]` | |
| `text` | `text` | |
| `mouse_move` | `dx dy` (relative, in-world look) | |
| `mouse_pos` | `x y` (absolute, menus) | |
| `click` | `button=1\|2\|3` `x? y?` `action` `hold_ms` | |
| `scroll` | `dx dy` | |
| `uri` | `uri` (must start with `minecraft:`) | |
| `fps` | `cap` | |
| `quit` | | |

Requests may carry an `id`, echoed back in the reply. The iOS server also reports `pointer_lock_requested` and
`text_input` in `state`, and `text` fails when no text box is focused.
