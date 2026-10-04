/**
 * Running `daily` every day at a set time, through macOS's own scheduler (a LaunchAgent in the
 * person's account). Nothing is installed until the person runs `schedule install`, and
 * `schedule remove` takes it away again. The Mac has to be on and signed in at that time.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, DAILY, PATHS, ROOT } from "../config.js";

export const agentFile = (home = homedir()) => path.join(home, "Library", "LaunchAgents", `${DAILY.label}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "09:00" as an hour and a minute. Null for anything that is not a time of day. */
export function timeOfDay(at: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** The LaunchAgent: run `jev daily` in the project folder at that time each day, with its output in the daily log. */
export function agentPlist(o: { node: string; root: string; hour: number; minute: number; searchPath: string; log: string }): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(DAILY.label)}
  <key>ProgramArguments</key>
  <array>${str(o.node)}${str(path.join(o.root, "bin", "jev.js"))}${str("daily")}</array>
  <key>WorkingDirectory</key>${str(o.root)}
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${o.hour}</integer><key>Minute</key><integer>${o.minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${str(o.searchPath)}</dict>
  <key>StandardOutPath</key>${str(o.log)}
  <key>StandardErrorPath</key>${str(o.log)}
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

type Launchctl = (args: string[]) => { status: number | null };
const launchctl: Launchctl = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8", env: childEnv() });
const domain = () => `gui/${process.getuid?.() ?? 0}`;

export function installSchedule(at: string = DAILY.at, o: { file?: string; run?: Launchctl; node?: string; root?: string; searchPath?: string } = {}): { file: string; at: string } {
  if (process.platform !== "darwin" && !o.run) throw new Error("the scheduled run uses macOS's scheduler. On another system, run `npx jev daily` from your own scheduler");
  const time = timeOfDay(at);
  if (!time) throw new Error(`"${at}" is not a time of day. Give it as HH:MM, for example 09:00`);
  const file = o.file ?? agentFile();
  const run = o.run ?? launchctl;
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(PATHS.dailyLog), { recursive: true });
  // One that is already loaded is taken out first, so a new time replaces the old one.
  run(["bootout", `${domain()}/${DAILY.label}`]);
  writeFileSync(file, agentPlist({ node: o.node ?? process.execPath, root: o.root ?? ROOT, ...time, searchPath: o.searchPath ?? process.env.PATH ?? "/usr/bin:/bin", log: PATHS.dailyLog }));
  if (run(["bootstrap", domain(), file]).status !== 0) throw new Error(`macOS did not take the schedule. The file is at ${file}`);
  return { file, at: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}` };
}

export function removeSchedule(o: { file?: string; run?: Launchctl } = {}): boolean {
  const file = o.file ?? agentFile();
  (o.run ?? launchctl)(["bootout", `${domain()}/${DAILY.label}`]);
  const was = existsSync(file);
  rmSync(file, { force: true });
  return was;
}

/** Whether a schedule is installed, whether macOS has it loaded, and the time of day it runs. */
export function scheduleStatus(o: { file?: string; run?: Launchctl } = {}): { installed: boolean; loaded: boolean; file: string; at: string | null } {
  const file = o.file ?? agentFile();
  const installed = existsSync(file);
  let at: string | null = null;
  if (installed) {
    const m = /<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/.exec(readFileSync(file, "utf8"));
    if (m) at = `${String(m[1]).padStart(2, "0")}:${String(m[2]).padStart(2, "0")}`;
  }
  return { installed, loaded: installed && (o.run ?? launchctl)(["print", `${domain()}/${DAILY.label}`]).status === 0, file, at };
}

/** The next moment a schedule at this time of day runs, after now. */
export function nextRun(at: string, now = new Date()): Date | null {
  const t = timeOfDay(at);
  if (!t) return null;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hour, t.minute, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
