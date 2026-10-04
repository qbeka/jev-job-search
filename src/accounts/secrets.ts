/**
 * Where passwords and tokens live. On a Mac that is the Keychain, through the system's own
 * `security` command. A value is handed out only as a Secret, which cannot be printed or saved by
 * accident, and it never travels in a command's arguments, where another process could read it.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { ACCOUNTS, childEnv } from "../config.js";
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
    // The value goes in on standard input, as a command to `security -i`, never as an argument.
    const quoted = `"${value.reveal().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = this.run(["-i"], { input: `add-generic-password -U -s "${this.service}" -a "${name}" -w ${quoted}\n` });
    if (r.status !== 0) throw new Error(`the Keychain did not take ${name}`);
  }

  setByPerson(name: string): boolean {
    // With -w last and no value, `security` asks for it itself, twice, without showing it.
    return this.run(["add-generic-password", "-U", "-s", this.service, "-a", name, "-w"], { inherit: true }).status === 0;
  }

  delete(name: string): void {
    this.run(["delete-generic-password", "-s", this.service, "-a", name], {});
  }
}

/** Environment variables, for a machine with no Keychain. The names come from the account entry; the values are read here and nowhere else. */
export class EnvStore implements SecretStore {
  get(name: string): Secret | null {
    const v = process.env[name];
    return v ? new Secret(v) : null;
  }
  set(): void {
    throw new Error("this machine has no Keychain: put the value in .env yourself");
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

export const defaultStore = (): SecretStore => (process.platform === "darwin" ? new KeychainStore() : new EnvStore());

/** Which of a board's password rules a password does not meet. Says which rules, never the password. */
export function passwordProblems(password: Secret): string[] {
  const p = password.reveal();
  const r = ACCOUNTS.passwordRules;
  const out: string[] = [];
  if (p.length < r.minLength) out.push(`at least ${r.minLength} characters`);
  if (r.digit && !/\d/.test(p)) out.push("a digit");
  if (r.lower && !/[a-z]/.test(p)) out.push("a lower-case letter");
  if (r.upper && !/[A-Z]/.test(p)) out.push("an upper-case letter");
  if (r.special && !/[^A-Za-z0-9]/.test(p)) out.push("a special character");
  return out;
}
