/**
 * Where passwords and tokens live: the system's own secret store. On a Mac that is the Keychain,
 * through the `security` command. On Linux it is the desktop keyring (GNOME Keyring, KWallet's
 * Secret Service), through `secret-tool`. On Windows it is Credential Manager, through a fixed
 * PowerShell script. A value is handed out only as a Secret, which cannot be printed or saved by
 * accident, and it never travels in a command's arguments, where another process could read it:
 * it goes in on standard input and comes back on standard output.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { ACCOUNTS, childEnv } from "../config.js";
import { powershellArgs, powershellPath } from "../util/platform.js";
import { Secret } from "../util/redact.js";

export interface SecretStore {
  get(name: string): Secret | null;
  /** Stores a value the tool produced itself (a token). */
  set(name: string, value: Secret): void;
  /** Lets the person type a value into the store themselves. The tool never holds it. True when it was stored. */
  setByPerson(name: string): boolean;
  delete(name: string): void;
}

type Runner = (args: string[], opts: { input?: string; inherit?: boolean }) => Pick<SpawnSyncReturns<string>, "status" | "stdout">;

const security: Runner = (args, opts) =>
  spawnSync("/usr/bin/security", args, { encoding: "utf8", env: childEnv(), stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"], ...(opts.input !== undefined ? { input: opts.input } : {}) });

/** The macOS Keychain. `run` is the `security` command, replaceable in a test. */
export class KeychainStore implements SecretStore {
  constructor(private readonly run: Runner = security, private readonly service: string = ACCOUNTS.keychainService) {}

  get(name: string): Secret | null {
    const r = this.run(["find-generic-password", "-s", this.service, "-a", name, "-w"], {});
    const value = (r.stdout ?? "").replace(/\n$/, "");
    return r.status === 0 && value ? new Secret(value) : null;
  }

  set(name: string, value: Secret): void {
    // The value goes in on standard input, as one command line to `security -i`, never as an argument.
    // A line break would end that line and start another command, so a value with one is refused.
    if (/[\x00-\x1f\x7f]/.test(value.reveal())) throw new Error(`the value for ${name} holds a character the Keychain command cannot take`);
    const quoted = `"${value.reveal().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = this.run(["-i"], { input: `add-generic-password -U -s "${this.service}" -a "${name}" -w ${quoted}\n` });
    // The command's own exit code says little, so the item is read back.
    if (r.status !== 0 || this.get(name)?.reveal() !== value.reveal()) throw new Error(`the Keychain did not take ${name}`);
  }

  setByPerson(name: string): boolean {
    // With -w last and no value, `security` asks for it itself, twice, without showing it.
    return this.run(["add-generic-password", "-U", "-s", this.service, "-a", name, "-w"], { inherit: true }).status === 0;
  }

  delete(name: string): void {
    this.run(["delete-generic-password", "-s", this.service, "-a", name], {});
  }
}

type Run = (command: string, args: string[], opts: { input?: string; inherit?: boolean; env?: Record<string, string> }) => Pick<SpawnSyncReturns<string>, "status" | "stdout">;

const runCommand: Run = (command, args, opts) =>
  spawnSync(command, args, { encoding: "utf8", env: childEnv(opts.env ?? {}), windowsHide: true, stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"], ...(opts.input !== undefined ? { input: opts.input } : {}) });

/** A value that goes in as one line on standard input must be one line. */
const oneLine = (name: string, value: Secret): string => {
  if (/[\x00-\x1f\x7f]/.test(value.reveal())) throw new Error(`the value for ${name} holds a character the secret store's command cannot take`);
  return value.reveal();
};

/**
 * The Linux desktop keyring, through `secret-tool` (the libsecret-tools package). The item is found
 * by two attributes, the service and the account, which hold names and never a secret.
 */
export class LibsecretStore implements SecretStore {
  constructor(private readonly run: Run = runCommand, private readonly service: string = ACCOUNTS.keychainService) {}

  private attrs(name: string): string[] {
    return ["service", this.service, "account", name];
  }

  get(name: string): Secret | null {
    const r = this.run("secret-tool", ["lookup", ...this.attrs(name)], {});
    const value = (r.stdout ?? "").replace(/\n$/, "");
    return r.status === 0 && value ? new Secret(value) : null;
  }

  set(name: string, value: Secret): void {
    // `secret-tool store` reads the value from standard input, to its end.
    const r = this.run("secret-tool", ["store", `--label=${this.service}: ${name}`, ...this.attrs(name)], { input: oneLine(name, value) });
    if (r.status !== 0 || this.get(name)?.reveal() !== value.reveal()) throw new Error(`the keyring did not take ${name}. Is it unlocked?`);
  }

  setByPerson(name: string): boolean {
    // With a terminal on standard input, `secret-tool store` asks for the value itself, without showing it.
    return this.run("secret-tool", ["store", `--label=${this.service}: ${name}`, ...this.attrs(name)], { inherit: true }).status === 0;
  }

  delete(name: string): void {
    this.run("secret-tool", ["clear", ...this.attrs(name)], {});
  }
}

// Fixed scripts. The names come from the environment and the value from standard input, so nothing is ever joined into script text.
const VAULT = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
  "$vault = New-Object Windows.Security.Credentials.PasswordVault",
  "$service = $env:JEV_SECRET_SERVICE",
  "$item = $env:JEV_SECRET_ITEM",
];
const VAULT_REMOVE = "try { $vault.Remove($vault.Retrieve($service, $item)) } catch { }";
const VAULT_ADD = "$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($service, $item, $value)))";
export const VAULT_SCRIPTS = {
  get: [...VAULT, "try { $c = $vault.Retrieve($service, $item) } catch { exit 3 }", "$c.RetrievePassword()", "[Console]::Out.Write($c.Password)"].join("\n"),
  set: [...VAULT, "$value = [Console]::In.ReadLine()", "if ([string]::IsNullOrEmpty($value)) { exit 4 }", VAULT_REMOVE, VAULT_ADD].join("\n"),
  ask: [
    ...VAULT,
    "$typed = Read-Host -AsSecureString 'Password (not shown)'",
    "$value = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($typed))",
    "if ([string]::IsNullOrEmpty($value)) { exit 4 }",
    VAULT_REMOVE,
    VAULT_ADD,
  ].join("\n"),
  delete: [...VAULT, VAULT_REMOVE].join("\n"),
} as const;

/**
 * Windows Credential Manager (its Web Credentials vault), through Windows PowerShell, which every
 * Windows 10 and 11 has. Each call runs one of the fixed scripts above.
 */
export class WindowsVaultStore implements SecretStore {
  constructor(private readonly run: Run = runCommand, private readonly service: string = ACCOUNTS.keychainService, private readonly powershell: string = powershellPath()) {}

  private call(script: string, name: string, opts: { input?: string; inherit?: boolean } = {}) {
    return this.run(this.powershell, powershellArgs(script, { interactive: !!opts.inherit }), { ...opts, env: { JEV_SECRET_SERVICE: this.service, JEV_SECRET_ITEM: name } });
  }

  get(name: string): Secret | null {
    const r = this.call(VAULT_SCRIPTS.get, name);
    const value = r.stdout ?? "";
    return r.status === 0 && value ? new Secret(value) : null;
  }

  set(name: string, value: Secret): void {
    const r = this.call(VAULT_SCRIPTS.set, name, { input: `${oneLine(name, value)}\n` });
    // The value is read back: the vault has limits of its own, and a value it cut short must not pass as stored.
    if (r.status !== 0 || this.get(name)?.reveal() !== value.reveal()) throw new Error(`Windows Credential Manager did not take ${name}`);
  }

  setByPerson(name: string): boolean {
    return this.call(VAULT_SCRIPTS.ask, name, { inherit: true }).status === 0;
  }

  delete(name: string): void {
    this.call(VAULT_SCRIPTS.delete, name);
  }
}

/** The environment variable that stands in for a stored item on a machine with no secret store: "accounts-password" is JEV_ACCOUNTS_PASSWORD. */
export const envNameOf = (item: string) => `JEV_${item.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/** Environment variables, for a machine with no secret store (a Linux machine without `secret-tool`). The values are read here and nowhere else. */
export class EnvStore implements SecretStore {
  get(name: string): Secret | null {
    const v = process.env[envNameOf(name)];
    return v ? new Secret(v) : null;
  }
  set(): void {
    throw new Error("this machine has no secret store. On Linux, install libsecret-tools (the `secret-tool` command) and a keyring, or put the value in .env yourself");
  }
  setByPerson(): boolean {
    return false;
  }
  delete(): void {
    /* nothing to delete: the person owns .env */
  }
}

/** A store in memory, for tests. */
export class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  get(name: string): Secret | null {
    const v = this.values.get(name);
    return v ? new Secret(v) : null;
  }
  set(name: string, value: Secret): void {
    this.values.set(name, value.reveal());
  }
  setByPerson(): boolean {
    return false;
  }
  delete(name: string): void {
    this.values.delete(name);
  }
}

/** The Keychain item that holds one employer account's own password. */
export const itemFor = (accountId: string) => `account:${accountId}`;

/**
 * A new random password for one employer account: long, with every kind of character a board asks
 * for. Each account gets its own, so nothing is shared between employers and the person has no
 * password to think of.
 */
export function generatePassword(): Secret {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%*-_=+"];
  const pick = (from: string) => from[randomInt(from.length)] as string;
  const chars = [...sets.map(pick), ...Array.from({ length: ACCOUNTS.generatedLength - sets.length }, () => pick(sets.join("")))];
  // Shuffled, so the four that were forced are not always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return new Secret(chars.join(""));
}

let hasSecretTool: boolean | null = null;
/** Whether `secret-tool` is on the search path. The keyring itself is not touched to find out. Looked up once per process. */
const secretToolInstalled = (): boolean => (hasSecretTool ??= (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, "secret-tool"))));

/** What kind of store this machine has: the system's own, or, on a Linux machine without `secret-tool`, the environment. */
export function storeKind(platform: NodeJS.Platform = process.platform, secretTool: () => boolean = secretToolInstalled): "keychain" | "vault" | "libsecret" | "env" {
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "vault";
  return secretTool() ? "libsecret" : "env";
}

export function defaultStore(): SecretStore {
  const kind = storeKind();
  return kind === "keychain" ? new KeychainStore() : kind === "vault" ? new WindowsVaultStore() : kind === "libsecret" ? new LibsecretStore() : new EnvStore();
}

/** Which of a board's password rules a password does not meet. Says which rules, never the password. */
export function passwordProblems(password: Secret): string[] {
  const p = password.reveal();
  const r = ACCOUNTS.mustHave;
  const out: string[] = [];
  // A secret store hands back anything else in another form, which would then be typed as the password.
  if (/[^\x21-\x7e]/.test(p)) out.push("only letters, digits and symbols from a plain keyboard, with no spaces");
  if (p.length < r.minLength) out.push(`at least ${r.minLength} characters`);
  if (r.digit && !/\d/.test(p)) out.push("a digit");
  if (r.lower && !/[a-z]/.test(p)) out.push("a lower-case letter");
  if (r.upper && !/[A-Z]/.test(p)) out.push("an upper-case letter");
  if (r.special && !/[^A-Za-z0-9]/.test(p)) out.push("a special character");
  return out;
}
