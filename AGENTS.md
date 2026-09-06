# mcpelauncher-agent — agent guidelines

Bun + TypeScript MCP server over the `--agent-socket` of the bedrock-mc mcpelauncher fork
(github.com/bedrock-mc/mcpelauncher-manifest, local clone ~/Coding/other/mcpelauncher-manifest). The socket
protocol is documented in README.md; the server side is `mcpelauncher-client/src/agent_server.cpp` in the fork.

- New socket commands go in both places in the same change: `agent_server.cpp` and a tool in `src/index.ts`.
- `bun run scripts/smoke.ts` is the end-to-end check; it needs the fork's client installed in
  "Minecraft Bedrock Launcher.app" and a signed-in game data dir. The menu is not interactive for ~30 s
  after launch.
- Never add clicking/typing into the game on the model's behalf beyond what the tools already do explicitly;
  every action stays a tool call the caller chose.
