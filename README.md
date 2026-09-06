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

## Run

```
bun install
bun run src/index.ts
```

Claude Code: `claude mcp add minecraft -- bun run /path/to/mcpelauncher-agent/src/index.ts`.

## Tools

`launch` · `stop` · `list` · `state` · `screenshot` · `key` · `hold_key` · `type` · `chat` · `look` ·
`click` · `mouse_move_to` · `scroll` · `set_fps` · `wait` · `log`

Every tool takes an optional `instance`; `launch` with a separate `data_dir` gives each bot its own login and
worlds.

## Socket protocol

The client listens on `--agent-socket <path>` and speaks one JSON object per line:

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
| `fps` | `cap` | |
| `quit` | | |

Requests may carry an `id`, echoed back in the reply.
