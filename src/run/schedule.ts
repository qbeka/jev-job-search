/**
 * Running `daily` every day at a set time, through the system's own scheduler, in the person's
 * account: a LaunchAgent on macOS, a systemd user timer on Linux, a task in Task Scheduler on
 * Windows. Nothing is installed until the person runs `schedule install`, and `schedule remove`
 * takes it away again. The computer has to be on and the person signed in at that time, because
 * the run drives a browser window.
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
  <array>${str(o.node)}${str(path.posix.join(o.root, "bin", "jev.js"))}${str("daily")}</array>
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

/** The scheduler's own command, by its arguments: launchctl, systemctl or schtasks. Replaceable in a test. */
type Scheduler = (args: string[]) => { status: number | null };
const launchctl: Scheduler = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8", env: childEnv() });
const systemctl: Scheduler = (args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: childEnv() });
const schtasks: Scheduler = (args) => spawnSync("schtasks.exe", args, { encoding: "utf8", env: childEnv(), windowsHide: true });
const domain = () => `gui/${process.getuid?.() ?? 0}`;

/** The systemd timer's file. Its service sits next to it under the same name. */
export const timerFile = (home = homedir()) => path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", `${DAILY.systemdUnit}.timer`);
const serviceFileOf = (timer: string) => timer.replace(/\.timer$/, ".service");
/** The small command file Task Scheduler runs on Windows. It lives with the other run data. */
export const taskFile = () => path.join(PATHS.runs, "daily-task.cmd");

/** A value inside a systemd unit: `%` starts a specifier there, and a quoted word ends at a quote. */
const unitWord = (s: string) => `"${s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The systemd service and timer: run `jev daily` in the project folder at that time each day, with its output in the daily log. */
export function systemdUnits(o: { node: string; root: string; hour: number; minute: number; searchPath: string; log: string }): { service: string; timer: string } {
  const at = `${String(o.hour).padStart(2, "0")}:${String(o.minute).padStart(2, "0")}`;
  const plain = (s: string) => s.replace(/%/g, "%%");
  const service = `[Unit]
Description=jev-job-search daily run

[Service]
Type=oneshot
WorkingDirectory=${plain(o.root)}
Environment=${unitWord(`PATH=${o.searchPath}`)}
ExecStart=${unitWord(o.node)} ${unitWord(path.posix.join(o.root, "bin", "jev.js"))} daily
StandardOutput=append:${plain(o.log)}
StandardError=append:${plain(o.log)}
`;
  const timer = `[Unit]
Description=jev-job-search daily run, every day at ${at}

[Timer]
OnCalendar=*-*-* ${at}:00
Persistent=false

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** The command file Task Scheduler runs: the same run, in the project folder, with its output in the daily log. */
export function taskScript(o: { node: string; root: string; hour: number; minute: number; searchPath: string; log: string }): string {
  // Inside a command file `%` starts a variable, so a path that holds one doubles it.
  const q = (s: string) => `"${s.replace(/%/g, "%%")}"`;
  const at = `${String(o.hour).padStart(2, "0")}:${String(o.minute).padStart(2, "0")}`;
  return ["@echo off", `rem jev-job-search daily at ${at}`, `set "PATH=${o.searchPath.replace(/%/g, "%%")}"`, `cd /d ${q(o.root)}`, `${q(o.node)} ${q(path.win32.join("bin", "jev.js"))} daily >> ${q(o.log)} 2>&1`, ""].join("\r\n");
}

type ScheduleOptions = { file?: string; run?: Scheduler; platform?: NodeJS.Platform };
const kindOf = (platform: NodeJS.Platform = process.platform): "launchd" | "systemd" | "task" => (platform === "darwin" ? "launchd" : platform === "win32" ? "task" : "systemd");

export function installSchedule(at: string = DAILY.at, o: ScheduleOptions & { node?: string; root?: string; searchPath?: string } = {}): { file: string; at: string } {
  const time = timeOfDay(at);
  if (!time) throw new Error(`"${at}" is not a time of day. Give it as HH:MM, for example 09:00`);
  const kind = kindOf(o.platform);
  const what = { node: o.node ?? process.execPath, root: o.root ?? ROOT, ...time, searchPath: o.searchPath ?? process.env.PATH ?? "/usr/bin:/bin", log: PATHS.dailyLog };
  const clock = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
  mkdirSync(path.dirname(PATHS.dailyLog), { recursive: true });
  if (kind === "systemd") {
    const file = o.file ?? timerFile();
    const run = o.run ?? systemctl;
    const units = systemdUnits(what);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(serviceFileOf(file), units.service);
    writeFileSync(file, units.timer);
    run(["daemon-reload"]);
    if (run(["enable", "--now", path.basename(file)]).status !== 0) throw new Error(`systemd did not take the schedule. Its files are ${file} and ${serviceFileOf(file)}. On a system without systemd, run \`npx jev daily\` from your own scheduler`);
    return { file, at: clock };
  }
  if (kind === "task") {
    const file = o.file ?? taskFile();
    const run = o.run ?? schtasks;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, taskScript(what));
    // /F replaces a task of the same name, so a new time replaces the old one. The task runs only while the person is signed in.
    if (run(["/Create", "/F", "/SC", "DAILY", "/ST", clock, "/TN", DAILY.windowsTask, "/TR", `"${file}"`]).status !== 0) throw new Error(`Task Scheduler did not take the schedule. The command file is at ${file}`);
    return { file, at: clock };
  }
  const file = o.file ?? agentFile();
  const run = o.run ?? launchctl;
  mkdirSync(path.dirname(file), { recursive: true });
  // One that is already loaded is taken out first, so a new time replaces the old one.
  run(["bootout", `${domain()}/${DAILY.label}`]);
  writeFileSync(file, agentPlist(what));
  if (run(["bootstrap", domain(), file]).status !== 0) throw new Error(`macOS did not take the schedule. The file is at ${file}`);
  return { file, at: clock };
}

export function removeSchedule(o: ScheduleOptions = {}): boolean {
  const kind = kindOf(o.platform);
  if (kind === "systemd") {
    const file = o.file ?? timerFile();
    const run = o.run ?? systemctl;
    const was = existsSync(file);
    run(["disable", "--now", path.basename(file)]);
    rmSync(file, { force: true });
    rmSync(serviceFileOf(file), { force: true });
    run(["daemon-reload"]);
    return was;
  }
  if (kind === "task") {
    const file = o.file ?? taskFile();
    const was = existsSync(file);
    (o.run ?? schtasks)(["/Delete", "/F", "/TN", DAILY.windowsTask]);
    rmSync(file, { force: true });
    return was;
  }
  const file = o.file ?? agentFile();
  (o.run ?? launchctl)(["bootout", `${domain()}/${DAILY.label}`]);
  const was = existsSync(file);
  rmSync(file, { force: true });
  return was;
}

/** Whether a schedule is installed, whether the system's scheduler has it, and the time of day it runs. */
export function scheduleStatus(o: ScheduleOptions = {}): { installed: boolean; loaded: boolean; file: string; at: string | null } {
  const kind = kindOf(o.platform);
  const file = o.file ?? (kind === "systemd" ? timerFile() : kind === "task" ? taskFile() : agentFile());
  const installed = existsSync(file);
  let at: string | null = null;
  if (installed) {
    const text = readFileSync(file, "utf8");
    const m = kind === "systemd" ? /OnCalendar=\*-\*-\* (\d+):(\d+)/.exec(text) : kind === "task" ? /rem jev-job-search daily at (\d+):(\d+)/.exec(text) : /<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/.exec(text);
    if (m) at = `${String(m[1]).padStart(2, "0")}:${String(m[2]).padStart(2, "0")}`;
  }
  const ask = kind === "systemd" ? () => (o.run ?? systemctl)(["is-enabled", path.basename(file)]) : kind === "task" ? () => (o.run ?? schtasks)(["/Query", "/TN", DAILY.windowsTask]) : () => (o.run ?? launchctl)(["print", `${domain()}/${DAILY.label}`]);
  return { installed, loaded: installed && ask().status === 0, file, at };
}

/** The next moment a schedule at this time of day runs, after now. */
export function nextRun(at: string, now = new Date()): Date | null {
  const t = timeOfDay(at);
  if (!t) return null;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hour, t.minute, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
