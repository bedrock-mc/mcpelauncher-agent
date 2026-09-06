import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSocket } from "./socket.ts";

const APP = process.env.MCPELAUNCHER_APP ?? "/Applications/Minecraft Bedrock Launcher.app";
const DATA = process.env.MCPELAUNCHER_DATA ?? join(homedir(), "Library/Application Support/mcpelauncher");
const ABI = "arm64-v8a";

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

// One running game client plus its control socket; instances are isolated by data dir so several can run.
export class Instance {
  readonly id: string;
  readonly version: string;
  readonly dataDir: string;
  readonly socketPath: string;
  readonly proc: ChildProcess;
  socket!: AgentSocket;
  readonly log: string[] = [];
  // Scale from the last screenshot's pixels to window content pixels, so callers click on what they saw.
  shotScale = 1;

  private constructor(id: string, version: string, dataDir: string, socketPath: string, proc: ChildProcess) {
    this.id = id;
    this.version = version;
    this.dataDir = dataDir;
    this.socketPath = socketPath;
    this.proc = proc;
  }

  static async launch(id: string, opts: LaunchOptions): Promise<Instance> {
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
    const inst = new Instance(id, version, dataDir, socketPath, proc);
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line) inst.log.push(line);
      if (inst.log.length > 500) inst.log.splice(0, inst.log.length - 500);
    };
    proc.stdout!.on("data", keep);
    proc.stderr!.on("data", keep);
    const exited = new Promise<never>((_, reject) => proc.once("exit", (code) => reject(new Error(`client exited with code ${code}\n${inst.log.slice(-20).join("\n")}`))));
    inst.socket = await Promise.race([AgentSocket.connect(socketPath, 90_000), exited]);
    return inst;
  }

  // The socket is up as soon as the window exists, but the main menu only accepts input ~30 s after the
  // first frame renders. Waits for that so callers can click immediately.
  async waitForMenu(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.socket.send("state");
      if (state.ok && (state.fps as number) > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 20_000));
    // The menu starts in keyboard-focus mode and swallows the first press that arrives with the hover
    // that switches it to mouse mode; two idle hovers get that out of the way.
    for (const x of [600, 640]) {
      await this.socket.send("mouse_pos", { x, y: 400 });
      await new Promise((r) => setTimeout(r, 1000));
    }
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
