#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Instance, installedVersions } from "./instance.ts";

const instances = new Map<string, Instance>();
let current: string | undefined;

function pick(id?: string): Instance {
  const key = id ?? current;
  const inst = key ? instances.get(key) : undefined;
  if (!inst || !inst.alive) throw new Error(key ? `instance ${key} is not running` : "no running instance; call launch first");
  return inst;
}

const text = (s: unknown) => ({ content: [{ type: "text" as const, text: typeof s === "string" ? s : JSON.stringify(s) }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const instanceArg = { instance: z.string().optional().describe("Instance id; defaults to the most recently launched") };

const server = new McpServer({ name: "mcpelauncher-agent", version: "0.1.0" });

server.tool(
  "launch",
  "Start a real Minecraft Bedrock client (via mcpelauncher) with the agent socket attached",
  {
    id: z.string().default("main").describe("Instance id, unique per running client"),
    version: z.string().optional().describe("Installed game version; defaults to the newest"),
    data_dir: z.string().optional().describe("Separate data dir (own Xbox login, worlds, settings) for running several bots"),
    width: z.number().int().min(320).default(854),
    height: z.number().int().min(180).default(480),
    fps_cap: z.number().int().min(0).default(10).describe("Render cap; the game ticks at full speed regardless"),
    hidden: z.boolean().default(true).describe("Keep the window hidden (still renders for screenshots)"),
    wait_for_menu: z.boolean().default(true).describe("Block until the main menu accepts input (~40 s); false returns as soon as the window exists"),
  },
  async ({ id, version, data_dir, width, height, fps_cap, hidden, wait_for_menu }) => {
    if (instances.get(id)?.alive) throw new Error(`instance ${id} already running`);
    const inst = await Instance.launch(id, { version, dataDir: data_dir, width, height, fpsCap: fps_cap, hidden });
    instances.set(id, inst);
    current = id;
    if (wait_for_menu) await inst.waitForMenu();
    const state = await inst.socket.call("state");
    return text({ instance: id, version: inst.version, pid: inst.proc.pid, ...state });
  },
);

server.tool("stop", "Quit a running client (in-game quit, force-killed after 35s)", instanceArg, async ({ instance }) => {
  const inst = pick(instance);
  await inst.stop();
  instances.delete(inst.id);
  if (current === inst.id) current = [...instances.keys()].pop();
  return text({ stopped: inst.id });
});

server.tool("list", "List installed game versions and running instances", {}, async () =>
  text({
    versions: installedVersions(),
    instances: [...instances.values()].filter((i) => i.alive).map((i) => ({ id: i.id, version: i.version, pid: i.proc.pid, data_dir: i.dataDir })),
    current,
  }),
);

server.tool("state", "Window size, focus, measured fps and cursor lock", instanceArg, async ({ instance }) => text(await pick(instance).socket.call("state")));

server.tool(
  "screenshot",
  "Capture the current frame as PNG",
  { ...instanceArg, width: z.number().int().min(64).optional().describe("Downscale to this width (aspect kept); default = window size") },
  async ({ instance, width }) => {
    const res = await pick(instance).socket.call("screenshot", width ? { width } : {});
    return { content: [{ type: "image" as const, data: res.png_base64 as string, mimeType: "image/png" }, { type: "text" as const, text: `${res.width}x${res.height}` }] };
  },
);

const keySchema = z.string().describe("Key name: a-z, 0-9, f1-f12, space, enter, escape, tab, shift, ctrl, alt, up/down/left/right, ...");

server.tool(
  "key",
  "Press a key (tap by default; use action press/release to hold across calls)",
  { ...instanceArg, key: keySchema, action: z.enum(["tap", "press", "release"]).default("tap"), hold_ms: z.number().int().min(1).default(60), mods: z.array(z.enum(["shift", "ctrl", "alt", "super"])).optional() },
  async ({ instance, ...args }) => text(await pick(instance).socket.call("key", args)),
);

server.tool(
  "hold_key",
  "Hold a key for a duration (walking: w/a/s/d, jump: space, sneak: shift, sprint: ctrl)",
  { ...instanceArg, key: keySchema, ms: z.number().int().min(1).max(60_000) },
  async ({ instance, key, ms }) => {
    const inst = pick(instance);
    await inst.socket.call("key", { key, action: "press" });
    await sleep(ms);
    await inst.socket.call("key", { key, action: "release" });
    return text({ ok: true, key, ms });
  },
);

server.tool("type", "Type text into the focused text field", { ...instanceArg, text: z.string() }, async ({ instance, text: t }) => text(await pick(instance).socket.call("text", { text: t })));

server.tool("chat", "Open chat, type a message and send it", { ...instanceArg, message: z.string() }, async ({ instance, message }) => {
  const inst = pick(instance);
  await inst.socket.call("key", { key: "t" });
  await sleep(400);
  await inst.socket.call("text", { text: message });
  await sleep(100);
  await inst.socket.call("key", { key: "enter" });
  return text({ ok: true });
});

server.tool("look", "Turn the camera by a relative mouse delta (pixels)", { ...instanceArg, dx: z.number(), dy: z.number() }, async ({ instance, dx, dy }) => text(await pick(instance).socket.call("mouse_move", { dx, dy })));

server.tool(
  "click",
  "Click at window coordinates (or at the last position). left = attack/break, right = use/place",
  { ...instanceArg, button: z.enum(["left", "right", "middle"]).default("left"), x: z.number().optional(), y: z.number().optional(), action: z.enum(["tap", "press", "release"]).default("tap"), hold_ms: z.number().int().min(1).default(60) },
  async ({ instance, ...args }) => text(await pick(instance).socket.call("click", args)),
);

server.tool("mouse_move_to", "Move the cursor to window coordinates (menus; in-world use look)", { ...instanceArg, x: z.number(), y: z.number() }, async ({ instance, x, y }) => text(await pick(instance).socket.call("mouse_pos", { x, y })));

server.tool("scroll", "Scroll the mouse wheel (hotbar / lists)", { ...instanceArg, dy: z.number() }, async ({ instance, dy }) => text(await pick(instance).socket.call("scroll", { dy })));

server.tool(
  "add_server",
  "Add an external server to the game's server list via a minecraft: deep link, without clicking through the UI",
  { ...instanceArg, name: z.string(), address: z.string().describe("host or host:port (default port 19132)") },
  async ({ instance, name, address }) => {
    const uri = `minecraft://?addExternalServer=${encodeURIComponent(name)}|${encodeURIComponent(address)}`;
    return text(await pick(instance).socket.call("uri", { uri }));
  },
);

server.tool(
  "open_uri",
  "Send a raw minecraft: URI to the game (deep links: servers, worlds, marketplace)",
  { ...instanceArg, uri: z.string().describe("Must start with minecraft:") },
  async ({ instance, uri }) => text(await pick(instance).socket.call("uri", { uri })),
);

server.tool("set_fps", "Change the render cap at runtime (0 = uncapped while focused)", { ...instanceArg, cap: z.number().int().min(0) }, async ({ instance, cap }) => text(await pick(instance).socket.call("fps", { cap })));

server.tool("wait", "Wait for the game to catch up", { ms: z.number().int().min(1).max(60_000) }, async ({ ms }) => {
  await sleep(ms);
  return text({ ok: true });
});

server.tool("log", "Recent client log lines", { ...instanceArg, lines: z.number().int().min(1).max(500).default(50) }, async ({ instance, lines }) => text(pick(instance).log.slice(-lines).join("\n")));

process.on("SIGINT", async () => {
  await Promise.all([...instances.values()].map((i) => i.stop(5_000)));
  process.exit(0);
});

await server.connect(new StdioServerTransport());
