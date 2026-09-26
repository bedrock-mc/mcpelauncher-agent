import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendLog, waitForMenu, type Instance } from "./instance.ts";
import { AgentSocket } from "./socket.ts";

const run = promisify(execFile);
const PLAYCOVER = join(homedir(), "Library/Containers/io.playcover.PlayCover");
const APP = process.env.MCPE_IOS_APP ?? join(PLAYCOVER, "Applications/com.mojang.minecraftpe.app");
const KEYCHAIN = join(PLAYCOVER, "PlayChain/com.mojang.minecraftpe.db");
const DATA = join(homedir(), "Library/Containers/com.mojang.minecraftpe");
const PORT = Number(process.env.MCPE_IOS_AGENT_PORT ?? 47555);
const PROCESS = "minecraftpe";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function iosVersion(): string | undefined {
  const plist = join(APP, "Info.plist");
  if (!existsSync(plist)) return undefined;
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
  return m?.[1];
}

async function pidOf(name: string): Promise<number | undefined> {
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-x", name]);
    return Number(stdout.trim().split("\n")[0]) || undefined;
  } catch {
    return undefined;
  }
}

function running(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// PlayCover re-encrypts the keychain into KeyCover when the game exits while it runs, and only decrypts it
// when it launches the game itself; a direct launch with an empty keychain aborts on start.
async function preflight() {
  if (await pidOf("PlayCover")) {
    await run("/usr/bin/osascript", ["-e", 'quit app "PlayCover"']).catch(() => {});
    for (let i = 0; i < 20 && (await pidOf("PlayCover")); i++) await sleep(500);
    if (await pidOf("PlayCover")) throw new Error("PlayCover is running and did not quit; quit it and launch again");
  }
  if (!existsSync(KEYCHAIN) || statSync(KEYCHAIN).size === 0) {
    throw new Error(`the game's keychain (${KEYCHAIN}) is empty: PlayCover has encrypted it. Launch Minecraft once from PlayCover, quit it with PlayCover closed, then retry`);
  }
}

// The iOS Minecraft client under PlayCover with the macfix agent server (MACFIX_AGENT_PORT). One per Mac:
// it uses the app's single data container. Hidden instances launch in the background and keep rendering.
export class IosInstance implements Instance {
  readonly backend = "ios";
  readonly dataDir = DATA;
  readonly log: string[] = [];
  shotScale = 1;
  private logStream?: ChildProcess;

  private constructor(readonly id: string, readonly version: string, public pid: number | undefined, readonly socket: AgentSocket) {}

  static async launch(id: string, opts: { version?: string; dataDir?: string; hidden?: boolean }): Promise<IosInstance> {
    if (opts.dataDir) throw new Error("data_dir is not supported by the ios backend: the iOS client has one data container");
    const version = iosVersion();
    if (!version) throw new Error(`iOS Minecraft not installed at ${APP} (set MCPE_IOS_APP)`);
    if (opts.version && opts.version !== version) throw new Error(`the ios backend has only ${version} installed`);
    if (await pidOf(PROCESS)) {
      throw new Error("iOS Minecraft is already running; quit it first (the agent server is only enabled at launch)");
    }
    await preflight();
    const args = ["--env", `MACFIX_AGENT_PORT=${PORT}`];
    if (opts.hidden) args.push("-g", "--env", "MACFIX_AGENT_HIDDEN=1");
    await run("/usr/bin/open", [...args, APP]);
    let pid: number | undefined;
    const deadline = Date.now() + 30_000;
    while (!(pid = await pidOf(PROCESS)) && Date.now() < deadline) await sleep(250);
    if (!pid) throw new Error("the game did not start within 30s");
    const socket = await Promise.race([
      AgentSocket.connect({ host: "127.0.0.1", port: PORT }, 60_000),
      (async (): Promise<never> => {
        while (running(pid)) await sleep(500);
        throw new Error("the game exited during startup (check ~/Library/Logs/DiagnosticReports/minecraftpe-*.ips)");
      })(),
    ]);
    const inst = new IosInstance(id, version, pid, socket);
    inst.logStream = spawn("/usr/bin/log", ["stream", "--style", "compact", "--predicate", `processID == ${pid}`], { stdio: ["ignore", "pipe", "ignore"] });
    inst.logStream.stdout!.on("data", (chunk: Buffer) => appendLog(inst.log, chunk));
    return inst;
  }

  waitForMenu(timeoutMs?: number) {
    return waitForMenu(this.socket, (w, h) => [[w * 0.45, h * 0.6], [w * 0.5, h * 0.6]], timeoutMs);
  }

  get alive() {
    return running(this.pid);
  }

  // UIKit holds a quit up to ~35 s for the game's background tasks before it exits.
  async stop(graceMs = 45_000) {
    if (this.alive) {
      try {
        await this.socket.send("quit");
      } catch {}
      const deadline = Date.now() + graceMs;
      while (this.alive && Date.now() < deadline) await sleep(500);
      if (this.alive) process.kill(this.pid!, "SIGTERM");
      for (let i = 0; i < 20 && this.alive; i++) await sleep(500);
      if (this.alive) process.kill(this.pid!, "SIGKILL");
    }
    this.socket.close();
    this.logStream?.kill();
  }
}
