import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// On every launch the mcpelauncher-updates mod (which newer game versions need) asks for the Google login, and
// the client runs the launcher UI (`mcpelauncher-ui-qt --request-google-credentials`) to confirm it in a window.
// Nobody can click that on a hidden or virtual display, so the agent always approves it: it finds the helper,
// borrows its X display and presses "Authorize". This is the launcher's prompt, not game input. Linux only;
// needs xdotool.

interface Helper {
  pid: number;
  display: string;
  xauthority?: string;
  mod: string;
}

function findHelper(): Helper | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd: string[];
    let environ: string;
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (!cmd.includes("--request-google-credentials")) continue;
      environ = readFileSync(`/proc/${entry}/environ`, "utf8");
    } catch {
      continue;
    }
    const env = new Map<string, string>();
    for (const kv of environ.split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) env.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const display = env.get("DISPLAY");
    if (!display) continue;
    // Inside a flatpak sandbox XAUTHORITY only exists in its mount namespace; /proc/<pid>/root reaches it.
    const xa = env.get("XAUTHORITY");
    const xauthority = xa ? [join(`/proc/${entry}/root`, xa), xa].find((p) => existsSync(p)) : undefined;
    const mod = cmd.indexOf("--mod");
    return { pid: Number(entry), display, xauthority, mod: mod >= 0 ? (cmd[mod + 1] ?? "") : "" };
  }
  return undefined;
}

// Approves the Google credentials prompt once it appears, logging what happened. Never throws.
export async function approveCredentialsPrompt(log: (line: string) => void, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    const helper = findHelper();
    if (helper) {
      const env = { ...process.env, DISPLAY: helper.display, ...(helper.xauthority ? { XAUTHORITY: helper.xauthority } : {}) };
      try {
        const win = await findPromptWindow(env);
        if (win) {
          // "Authorize the mod to access your Google Credentials" is the window's only button, bottom right.
          await run("xdotool", ["mousemove", "--window", win.id, String(win.width - 200), String(win.height - 31), "click", "1"], { env });
          log(`[agent] approved the Google credentials prompt for ${helper.mod || "a mod"}`);
          return true;
        }
        seen = await describeWindows(env);
      } catch (e) {
        const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? "xdotool is not installed" : (e as Error).message;
        log(`[agent] could not approve the Google credentials prompt: ${msg}`);
        return false;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`[agent] Google credentials were requested but no prompt window appeared (windows: ${seen || "none"})`);
  return false;
}

interface PromptWindow {
  id: string;
  width: number;
  height: number;
}

async function windows(env: NodeJS.ProcessEnv): Promise<Array<PromptWindow & { name: string; cls: string }>> {
  // No match is an exit status of 1; a missing xdotool must still surface.
  const { stdout } = await run("xdotool", ["search", "--onlyvisible", "--name", ""], { env }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") throw e;
    return { stdout: "" };
  });
  const out = [];
  for (const id of stdout.split("\n").filter(Boolean)) {
    const name = (await run("xdotool", ["getwindowname", id], { env }).catch(() => ({ stdout: "" }))).stdout.trim();
    const cls = (await run("xdotool", ["getwindowclassname", id], { env }).catch(() => ({ stdout: "" }))).stdout.trim();
    const geo = (await run("xdotool", ["getwindowgeometry", "--shell", id], { env }).catch(() => ({ stdout: "" }))).stdout;
    out.push({ id, name, cls, width: Number(/WIDTH=(\d+)/.exec(geo)?.[1] ?? 0), height: Number(/HEIGHT=(\d+)/.exec(geo)?.[1] ?? 0) });
  }
  return out;
}

// The launcher UI's prompt window (titled "Request Google Credentials"; it has no class), big enough to hold
// the dialog.
async function findPromptWindow(env: NodeJS.ProcessEnv): Promise<PromptWindow | undefined> {
  return (await windows(env)).find((w) => /google credentials/i.test(w.name) && w.width >= 300 && w.height >= 200);
}

async function describeWindows(env: NodeJS.ProcessEnv): Promise<string> {
  return (await windows(env)).map((w) => `${JSON.stringify(w.name)}/${w.cls} ${w.width}x${w.height}`).join(", ");
}
