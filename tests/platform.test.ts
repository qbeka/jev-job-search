import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { linuxDialogCommands, WINDOWS_DIALOG } from "../src/accounts/ask.js";
import { CRED_SCRIPTS, LibsecretStore, storeKind, WindowsCredentialStore } from "../src/accounts/secrets.js";
import { systemPromptArgs } from "../src/answers/resolve.js";
import { childEnv, chromeCandidates, DAILY, findChrome } from "../src/config.js";
import { installSchedule, removeSchedule, scheduleStatus, systemdUnits, taskScript } from "../src/run/schedule.js";
import { findOnWindowsPath, notifyCommand, openCommand, osOf, powershellArgs, powershellPath, spawnPlan, storeWords } from "../src/util/platform.js";
import { Secret } from "../src/util/redact.js";

const decoded = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1] ?? "", "base64").toString("utf16le");

describe("the browser, wherever it is installed", () => {
  it("knows the usual places on each system", () => {
    expect(chromeCandidates("darwin", { HOME: "/Users/someone" })[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(chromeCandidates("linux", {})).toContain("/usr/bin/google-chrome");
    const win = chromeCandidates("win32", { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" });
    expect(win[0]).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(win.some((p) => p.endsWith("msedge.exe"))).toBe(true);
  });

  it("takes the first one that is there, and the person's own path before any of them", () => {
    expect(findChrome("linux", {}, (f) => f === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
    expect(findChrome("linux", {}, () => false)).toBe("/usr/bin/google-chrome");
    expect(findChrome("linux", { CHROME_PATH: " /opt/mine/chrome " }, () => true)).toBe("/opt/mine/chrome");
  });
});

describe("starting a command on each system", () => {
  it("leaves a command as it is on macOS and Linux", () => {
    expect(spawnPlan("claude", ["-p", ""], { platform: "darwin" })).toEqual({ file: "claude", args: ["-p", ""], verbatim: false });
    expect(spawnPlan("codex", ["exec"], { platform: "linux" })).toEqual({ file: "codex", args: ["exec"], verbatim: false });
  });

  const env = { PATH: "C:\\tools;C:\\Users\\someone\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };

  it("finds a Windows program by the path and the extensions Windows tries", () => {
    expect(findOnWindowsPath("claude", env, (f) => f === "C:\\tools\\claude.exe")).toBe("C:\\tools\\claude.exe");
    expect(findOnWindowsPath("claude", env, () => false)).toBeNull();
    expect(spawnPlan("claude", ["--version"], { platform: "win32", env, exists: (f) => f === "C:\\tools\\claude.exe" })).toEqual({ file: "C:\\tools\\claude.exe", args: ["--version"], verbatim: false });
  });

  it("starts an npm command, which is a .cmd file on Windows, through cmd with every argument quoted", () => {
    const shim = "C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.cmd";
    const plan = spawnPlan("codex", ["exec", "-", "--model", "a b", ""], { platform: "win32", env, exists: (f) => f === shim });
    expect(plan.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.verbatim).toBe(true);
    expect(plan.args).toEqual(["/d", "/s", "/c", `""${shim}" "exec" "-" "--model" "a b" """`]);
  });

  it("refuses an argument that the quotes of a .cmd line cannot carry, instead of letting the shell read it", () => {
    const exists = (f: string) => f === "C:\\tools\\codex.cmd";
    for (const bad of ['say "hi"', "%PATH%", "two\nlines"]) expect(() => spawnPlan("codex", [bad], { platform: "win32", env, exists }), bad).toThrow(/cannot be passed/);
  });

  it.runIf(process.platform === "win32")("really passes arguments through a .cmd file on Windows, the way npm installs a command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev cmd "));
    const out = path.join(dir, "seen.json");
    writeFileSync(path.join(dir, "echo.js"), "require('node:fs').writeFileSync(process.env.JEV_TEST_OUT, JSON.stringify(process.argv.slice(2)));\n");
    // What npm writes for a command: a .cmd file that hands its arguments on to node.
    writeFileSync(path.join(dir, "shim.cmd"), '@ECHO off\r\n"%~dp0\\node_stand_in.cmd" %*\r\n');
    writeFileSync(path.join(dir, "node_stand_in.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo.js" %*\r\n`);
    const args = ["exec", "-", "--model", "two words", "", "a&b|c<d>e", "C:\\dir with space\\"];
    const plan = spawnPlan("shim", args, { env: { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` } });
    expect(plan.verbatim).toBe(true);
    const r = spawnSync(plan.file, plan.args, { encoding: "utf8", env: childEnv({ JEV_TEST_OUT: out }), windowsVerbatimArguments: plan.verbatim });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(args);
  });

  it("gives Claude Code its system prompt as a file on Windows, where a command line cannot carry it, and removes the file", () => {
    expect(systemPromptArgs("RULES", "darwin").args).toEqual(["--system-prompt", "RULES"]);
    const win = systemPromptArgs("RULES", "win32");
    expect(win.args[0]).toBe("--system-prompt-file");
    const file = win.args[1] as string;
    expect(readFileSync(file, "utf8")).toBe("RULES");
    win.cleanup();
    expect(existsSync(file)).toBe(false);
  });
});

describe("opening a link and telling the person", () => {
  it("opens a link with each system's own opener, never through a shell", () => {
    const link = "https://mail.google.com/mail/u/0/#search/a%20b&c";
    expect(openCommand(link, "darwin")).toEqual({ command: "/usr/bin/open", args: [link] });
    expect(openCommand(link, "linux")).toEqual({ command: "xdg-open", args: [link] });
    expect(openCommand(link, "win32")).toEqual({ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", link] });
  });

  it("posts a notification with the words as data, never as script text", () => {
    const title = "jev-job-search needs you";
    const body = `Acme"; rm -rf ~ #: type the code`;
    const mac = notifyCommand(title, body, "darwin");
    expect(mac.args.slice(-2)).toEqual([title, body]);
    expect(mac.args.slice(0, -2).join(" ")).not.toContain("Acme");
    const linux = notifyCommand(title, `--icon=x ${body}`, "linux");
    expect(linux.command).toBe("notify-send");
    expect(linux.args.indexOf("--")).toBeLessThan(linux.args.indexOf(`--icon=x ${body}`));
    const win = notifyCommand(title, body, "win32", { SystemRoot: "C:\\Windows" });
    expect(win.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(win.env).toEqual({ JEV_NOTIFY_TITLE: title, JEV_NOTIFY_BODY: body });
    expect(decoded(win.args)).not.toContain("Acme");
    expect(decoded(win.args)).toContain("$env:JEV_NOTIFY_BODY");
  });

  it("names the system and its secret store in words", () => {
    expect([osOf("darwin"), osOf("win32"), osOf("linux"), osOf("freebsd")]).toEqual(["mac", "windows", "linux", "linux"]);
    expect(storeWords("windows")).toContain("Credential Manager");
    expect(powershellPath({})).toMatch(/powershell\.exe$/);
    expect(powershellArgs("x")).toContain("-NonInteractive");
    expect(powershellArgs("x", { interactive: true })).not.toContain("-NonInteractive");
  });
});

describe("the secret store of each system", () => {
  const SECRET = "Corr3ct-horse!battery";

  it("is the Keychain on a Mac, Credential Manager on Windows, the keyring on Linux, and .env only where there is none", () => {
    expect(storeKind("darwin")).toBe("keychain");
    expect(storeKind("win32")).toBe("wincred");
    expect(storeKind("linux", () => true)).toBe("libsecret");
    expect(storeKind("linux", () => false)).toBe("env");
  });

  it("talks to the Linux keyring with the secret on standard input, never as an argument", () => {
    const kept = new Map<string, string>();
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const store = new LibsecretStore((command, args, opts) => {
      calls.push({ command, args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
      const key = args.slice(-4).join("|");
      if (args[0] === "store") kept.set(key, opts.input ?? "");
      if (args[0] === "clear") kept.delete(key);
      if (args[0] === "lookup") return { status: kept.has(key) ? 0 : 1, stdout: kept.get(key) ?? "" };
      return { status: 0, stdout: "" };
    }, "svc");
    expect(store.get("account:acme")).toBeNull();
    store.set("account:acme", new Secret(SECRET));
    expect(store.get("account:acme")?.reveal()).toBe(SECRET);
    expect(calls.every((c) => c.command === "secret-tool")).toBe(true);
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(SECRET);
    expect(calls.find((c) => c.args[0] === "store")?.args.slice(-4)).toEqual(["service", "svc", "account", "account:acme"]);
    store.delete("account:acme");
    expect(store.get("account:acme")).toBeNull();
    expect(() => store.set("x", new Secret("two\nlines"))).toThrow(/cannot take/);
  });

  it("says so when the keyring did not keep the value", () => {
    const store = new LibsecretStore(() => ({ status: 0, stdout: "" }), "svc");
    expect(() => store.set("x", new Secret(SECRET))).toThrow(/keyring did not take/);
  });

  it("talks to Windows Credential Manager through fixed scripts: names in the environment, the secret on standard input", () => {
    const kept = new Map<string, string>();
    const calls: { command: string; args: string[]; input?: string; env?: Record<string, string> }[] = [];
    const store = new WindowsCredentialStore((command, args, opts) => {
      calls.push({ command, args, ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.env ? { env: opts.env } : {}) });
      const script = decoded(args);
      const key = `${opts.env?.JEV_SECRET_SERVICE}|${opts.env?.JEV_SECRET_ITEM}`;
      if (script === CRED_SCRIPTS.set) kept.set(key, (opts.input ?? "").replace(/\n$/, ""));
      if (script === CRED_SCRIPTS.delete) kept.delete(key);
      if (script === CRED_SCRIPTS.get) return { status: kept.has(key) ? 0 : 3, stdout: kept.get(key) ?? "" };
      return { status: 0, stdout: "" };
    }, "svc", "powershell.exe");
    store.set("gmail-refresh-token", new Secret(SECRET));
    expect(store.get("gmail-refresh-token")?.reveal()).toBe(SECRET);
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(SECRET);
    expect(calls.map((c) => decoded(c.args)).join("\n")).not.toContain(SECRET);
    expect(JSON.stringify(calls.map((c) => c.env))).not.toContain(SECRET);
    expect(calls[0]?.env).toEqual({ JEV_SECRET_SERVICE: "svc", JEV_SECRET_ITEM: "gmail-refresh-token" });
    store.delete("gmail-refresh-token");
    expect(store.get("gmail-refresh-token")).toBeNull();
    // The script that stores a value reads it back itself, and a refusal from it is said.
    expect(CRED_SCRIPTS.set).toContain("[JevCred]::Read($target) -cne $value");
    const refusing = new WindowsCredentialStore(() => ({ status: 6, stdout: "" }), "svc", "powershell.exe");
    expect(() => refusing.set("x", new Secret(SECRET))).toThrow(/did not take/);
  });

  it("keeps a person's words out of every script it runs", () => {
    for (const script of [...Object.values(CRED_SCRIPTS), WINDOWS_DIALOG]) expect(script).not.toMatch(/\$\{|`/);
    const [zenity, kdialog] = linuxDialogCommands("Your password at Acme.");
    expect(zenity?.args).toContain("--hide-text");
    expect(kdialog?.args).toContain("--password");
  });
});

describe("the schedule on Linux and Windows", () => {
  const what = { node: "/usr/bin/node", root: "/home/someone/jev 100%", hour: 7, minute: 5, searchPath: "/usr/bin:/bin", log: "/home/someone/daily.log" };

  it("writes a systemd service and timer that run `jev daily` in the project folder, and nothing more", () => {
    const { service, timer } = systemdUnits(what);
    expect(service).toContain('ExecStart="/usr/bin/node" "/home/someone/jev 100%%/bin/jev.js" daily');
    expect(service).toContain("WorkingDirectory=/home/someone/jev 100%%");
    expect(timer).toContain("OnCalendar=*-*-* 07:05:00");
    expect(service + timer).not.toMatch(/--submit|KEY|TOKEN|PASSWORD/);
  });

  it("is installed with systemd only when asked, and removed again", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-systemd-"));
    const file = path.join(dir, "user", `${DAILY.systemdUnit}.timer`);
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0 };
    };
    const o = { file, run, platform: "linux" as const };
    expect(scheduleStatus(o)).toMatchObject({ installed: false, loaded: false });
    expect(installSchedule("7:30", { ...o, node: "/n", root: "/r", searchPath: "/usr/bin" })).toMatchObject({ at: "07:30" });
    expect(existsSync(file.replace(/\.timer$/, ".service"))).toBe(true);
    expect(calls).toEqual([["daemon-reload"], ["enable", "--now", `${DAILY.systemdUnit}.timer`]]);
    expect(scheduleStatus(o)).toMatchObject({ installed: true, loaded: true, at: "07:30" });
    expect(removeSchedule(o)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.timer$/, ".service"))).toBe(false);
    expect(removeSchedule(o)).toBe(false);
    expect(() => installSchedule("7:30", { ...o, run: () => ({ status: 1 }) })).toThrow(/systemd did not take/);
  });

  it("writes a Windows command file that runs `jev daily` in the project folder, and nothing more", () => {
    const text = taskScript({ node: "C:\\Program Files\\nodejs\\node.exe", root: "C:\\Users\\someone\\jev 100%", hour: 7, minute: 5, searchPath: "C:\\Windows", log: "C:\\Users\\someone\\daily.log" });
    expect(text).toContain('cd /d "C:\\Users\\someone\\jev 100%%"');
    expect(text).toContain('"C:\\Program Files\\nodejs\\node.exe" "bin\\jev.js" daily >> "C:\\Users\\someone\\daily.log" 2>&1');
    expect(text).not.toMatch(/--submit|KEY|TOKEN|PASSWORD/);
  });

  it("is installed in Task Scheduler only when asked, and removed again", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-task-"));
    const file = path.join(dir, "daily-task.cmd");
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0 };
    };
    const o = { file, run, platform: "win32" as const };
    expect(installSchedule("21:15", { ...o, node: "C:\\n.exe", root: "C:\\r", searchPath: "C:\\Windows" })).toMatchObject({ at: "21:15" });
    expect(calls[0]).toEqual(["/Create", "/F", "/SC", "DAILY", "/ST", "21:15", "/TN", DAILY.windowsTask, "/TR", `"${file}"`]);
    expect(scheduleStatus(o)).toMatchObject({ installed: true, loaded: true, at: "21:15" });
    expect(removeSchedule(o)).toBe(true);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["/Delete", "/F"]);
    expect(existsSync(file)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("a stand-in command on macOS and Linux", () => {
  it("is started as it is, with its arguments untouched", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-plan-"));
    const file = path.join(dir, "shim");
    writeFileSync(file, '#!/bin/sh\nprintf "1=[%s] 2=[%s] 3=[%s]" "$1" "$2" "$3"\n');
    chmodSync(file, 0o755);
    const plan = spawnPlan(file, ["two words", "", 'say "hi" 100%']);
    const r = spawnSync(plan.file, plan.args, { encoding: "utf8", env: childEnv() });
    expect(r.stdout).toBe('1=[two words] 2=[] 3=[say "hi" 100%]');
  });
});
