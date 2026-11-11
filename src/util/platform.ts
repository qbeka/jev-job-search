/**
 * What differs between macOS, Linux and Windows, in one place: how a command is found and
 * started, how a link or a file is opened, and how the person is told something. Nothing here
 * takes words from a web page as script text: data travels as an argument or in the environment
 * of a fixed script.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { childEnv } from "../config.js";

export type Os = "mac" | "windows" | "linux";

/** Every system that is not a Mac or Windows is treated as Linux: the same tools are looked for. */
export const osOf = (platform: NodeJS.Platform = process.platform): Os => (platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux");

/** What the place secrets are kept is called, in words for the person. */
export function storeWords(os: Os = osOf()): string {
  return os === "mac" ? "your Mac's Keychain" : os === "windows" ? "Windows Credential Manager" : "your keyring";
}

/** Windows PowerShell 5.1, which every Windows 10 and 11 has. The newer `pwsh` cannot reach the credential vault the same way. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The arguments that run one fixed script in PowerShell. The script travels encoded, so no quoting
 * rule of the shell applies to it, and it reads its data from the environment or standard input.
 */
export function powershellArgs(script: string, o: { interactive?: boolean } = {}): string[] {
  return ["-NoProfile", "-NoLogo", ...(o.interactive ? [] : ["-NonInteractive"]), "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * Where a command is on Windows, by the search path and the extensions Windows itself tries. A
 * command installed with npm is a `.cmd` file there, which cannot be started like a program.
 * Null when it is nowhere on the path.
 */
export function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  if (/[\\/]/.test(command)) return exists(command) ? command : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ["", ...exts]) {
      const file = path.win32.join(dir, command + ext.toLowerCase());
      if (ext === "" && !/\.[a-z0-9]+$/i.test(command)) continue;
      if (exists(file)) return file;
    }
  }
  return null;
}

/** One argument inside the double quotes of a `cmd /c` line. Refused when it holds what those quotes cannot carry. */
function cmdQuoted(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error("an argument holds a character that cannot be passed to a .cmd command on Windows");
  // A backslash before the closing quote would escape it for the program that reads the line.
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

export type SpawnPlan = { file: string; args: string[]; verbatim: boolean };

/**
 * How to start a command so that it works on every system. On macOS and Linux that is the command
 * as it is. On Windows a program is started by its full path, and a `.cmd` or `.bat` file through
 * `cmd /c` with every argument quoted here, never by the shell's own guess.
 */
export function spawnPlan(command: string, args: string[], o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean } = {}): SpawnPlan {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args, verbatim: false };
  const env = o.env ?? process.env;
  const found = findOnWindowsPath(command, env, o.exists);
  if (!found) return { file: command, args, verbatim: false };
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args, verbatim: false };
  const line = [found, ...args].map(cmdQuoted).join(" ");
  return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** The command that opens a link or a file in the person's own program for it. */
export function openCommand(target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "/usr/bin/open", args: [target] };
  // Not `start`: that is a shell word, and a link's `&` would end the command there.
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target] };
  return { command: "xdg-open", args: [target] };
}

const detached = (command: string, args: string[], extra: Record<string, string> = {}) => {
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, env: childEnv(extra), windowsHide: true });
    child.on("error", () => undefined); // a helper that is not installed is not an error
    child.unref();
  } catch {
    /* help that cannot be given is not an error */
  }
};

/** Opens a link or a file in the person's own browser or program. Quietly does nothing where there is no way to. */
export function openExternal(target: string): void {
  const { command, args } = openCommand(target);
  detached(command, args);
}

// The words are read from the environment by a fixed script, never joined into it.
const WINDOWS_NOTIFY = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(8000, $env:JEV_NOTIFY_TITLE, $env:JEV_NOTIFY_BODY, [System.Windows.Forms.ToolTipIcon]::Info)",
  "Start-Sleep -Seconds 8",
  "$n.Dispose()",
].join("\n");

/** The command that posts one notification. The words travel as arguments or in the environment, never as script text. */
export function notifyCommand(title: string, body: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; env: Record<string, string> } {
  if (platform === "darwin") return { command: "/usr/bin/osascript", args: ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], env: {} };
  if (platform === "win32") return { command: powershellPath(env), args: powershellArgs(WINDOWS_NOTIFY), env: { JEV_NOTIFY_TITLE: title, JEV_NOTIFY_BODY: body } };
  // After `--` nothing is read as an option, whatever a company is called.
  return { command: "notify-send", args: ["--app-name=jev-job-search", "--", title, body], env: {} };
}

/** A notification on the person's desktop. */
export function notifyDesktop(title: string, body: string): void {
  const n = notifyCommand(title, body);
  detached(n.command, n.args, n.env);
}
