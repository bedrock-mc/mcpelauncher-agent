import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSocket, type AgentResponse } from "./socket.ts";

const APP = process.env.MCPELAUNCHER_APP ?? "/Applications/Minecraft Bedrock Launcher.app";
const DATA = process.env.MCPELAUNCHER_DATA ?? join(homedir(), "Library/Application Support/mcpelauncher");
const ABI = "arm64-v8a";

export type Backend = "android" | "ios";

// A running game client driven over its agent socket, whichever backend started it.
export interface Instance {
  readonly id: string;
  readonly backend: Backend;
  readonly version: string;
  readonly dataDir: string;
  readonly pid: number | undefined;
  readonly socket: AgentSocket;
  readonly log: string[];
  // Scale from the last screenshot's pixels to the socket's click coordinates.
  shotScale: number;
  readonly alive: boolean;
  waitForMenu(timeoutMs?: number): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

// The socket is up as soon as the window exists, but the main menu only accepts input ~30 s after the
// first frame renders. Waits for that so callers can click immediately.
export async function waitForMenu(socket: AgentSocket, hovers: (width: number, height: number) => Array<[number, number]>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let state: AgentResponse = { ok: false };
  while (Date.now() < deadline) {
    state = await socket.send("state");
    if (state.ok && (state.fps as number) > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 20_000));
  // The menu starts in keyboard-focus mode and swallows the first press that arrives with the hover
  // that switches it to mouse mode; two idle hovers get that out of the way.
  for (const [x, y] of hovers(state.width as number, state.height as number)) {
    await socket.send("mouse_pos", { x, y });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function appendLog(log: string[], chunk: Buffer | string) {
  for (const line of chunk.toString().split("\n")) if (line) log.push(line);
  if (log.length > 500) log.splice(0, log.length - 500);
}

export interface LaunchOptions {
  version?: string;
  dataDir?: string;
  width: number;
  height: number;
  fpsCap: number;
  hidden: boolean;
}

export function installedVersions(): string[] {
  const dir = join(DATA, "versions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((v) => existsSync(join(dir, v, "lib", ABI, "libminecraftpe.so")))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// One mcpelauncher client plus its control socket; instances are isolated by data dir so several can run.
export class LauncherInstance implements Instance {
  readonly id: string;
  readonly backend = "android";
  readonly version: string;
  readonly dataDir: string;
  readonly socketPath: string;
  readonly proc: ChildProcess;
  socket!: AgentSocket;
  readonly log: string[] = [];
  shotScale = 1;

  private constructor(id: string, version: string, dataDir: string, socketPath: string, proc: ChildProcess) {
    this.id = id;
    this.version = version;
    this.dataDir = dataDir;
    this.socketPath = socketPath;
    this.proc = proc;
  }

  static async launch(id: string, opts: LaunchOptions): Promise<LauncherInstance> {
    const versions = installedVersions();
    const version = opts.version ?? versions[0];
    if (!version || !versions.includes(version)) {
      throw new Error(`version ${opts.version ?? "(none)"} not installed; available: ${versions.join(", ") || "none"}`);
    }
    const dataDir = opts.dataDir ?? DATA;
    mkdirSync(dataDir, { recursive: true });
    const socketPath = join(tmpdir(), `mcpelauncher-agent-${id}.sock`);
    const modsDir = join(DATA, "mods/mcpelauncher-updates", version, ABI);
    const args = [
      "-dg", join(DATA, "versions", version),
      "-dd", dataDir,
      "-ww", String(opts.width), "-wh", String(opts.height),
      "--agent-socket", socketPath,
      "--fps-cap", String(opts.fpsCap),
    ];
    if (opts.hidden) args.push("--hidden");
    if (existsSync(modsDir)) args.push("-m", modsDir + "/");
    const proc = spawn(join(APP, "Contents/MacOS", `mcpelauncher-client-${ABI}`), args, { stdio: ["ignore", "pipe", "pipe"] });
    const inst = new LauncherInstance(id, version, dataDir, socketPath, proc);
    const keep = (chunk: Buffer) => appendLog(inst.log, chunk);
    proc.stdout!.on("data", keep);
    proc.stderr!.on("data", keep);
    const exited = new Promise<never>((_, reject) => proc.once("exit", (code) => reject(new Error(`client exited with code ${code}\n${inst.log.slice(-20).join("\n")}`))));
    inst.socket = await Promise.race([AgentSocket.connect(socketPath, 90_000), exited]);
    return inst;
  }

  waitForMenu(timeoutMs?: number) {
    return waitForMenu(this.socket, () => [[600, 400], [640, 400]], timeoutMs);
  }

  get pid() {
    return this.proc.pid;
  }

  get alive() {
    return this.proc.exitCode === null && !this.proc.killed;
  }

  async stop(graceMs = 35_000) {
    if (!this.alive) return;
    try {
      await this.socket.send("quit");
    } catch {}
    const exited = new Promise<void>((resolve) => this.proc.once("exit", () => resolve()));
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, graceMs))]);
    if (this.alive) this.proc.kill("SIGKILL");
    this.socket.close();
  }
}
