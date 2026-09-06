// End-to-end check: start the MCP server over stdio, launch a hidden client, screenshot, click Play, stop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "bun", args: ["run", new URL("../src/index.ts", import.meta.url).pathname] }));

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(" "));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const parts = res.content as Array<{ type: string; text?: string; data?: string }>;
  for (const p of parts) {
    if (p.type === "image" && p.data) {
      const out = `/tmp/mcpelauncher-agent-${name}-${Date.now()}.png`;
      writeFileSync(out, Buffer.from(p.data, "base64"));
      console.log(`${name}: image -> ${out}`);
    } else if (p.text) console.log(`${name}: ${p.text.slice(0, 300)}`);
  }
  if (res.isError) throw new Error(`${name} failed`);
  return parts;
};

await call("list");
await call("launch", { width: 640, height: 360, fps_cap: 10, hidden: true });
await call("wait", { ms: 35000 }); // the menu is not interactive for ~30 s after launch
await call("state");
await call("screenshot", { width: 640 });
await call("click", { x: 640, y: 425 });
await call("wait", { ms: 2000 });
await call("screenshot", { width: 640 });
await call("key", { key: "escape" });
await call("stop");
await client.close();
