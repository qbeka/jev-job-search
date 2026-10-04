/**
 * data/accounts.json: the job-board accounts the person allowed, and their standing rule for
 * making new ones. It holds no secret: a password is in the Keychain, named here at most.
 * data/runs/accounts-state.json is what the tool remembers between runs: when it last signed in,
 * how many tries today, a pause after a lockout, how many accounts it made today.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ACCOUNTS, PATHS } from "../config.js";
import { withStore, writeAtomic } from "../util/store.js";

const isSafeOrigin = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.origin === value && (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")));
  } catch {
    return false;
  }
};

/** off: the person said the tool must leave this employer alone, whatever the rule for the board says. */
export const Mode = z.enum(["existing_only", "create_if_missing", "off"]);

/** Where an account's password is: an item in the secret store (the Keychain on a Mac), or an environment variable the person names. */
const SecretRef = z.union([z.object({ keychain: z.string() }), z.object({ passwordEnv: z.string() })]);

export const Account = z.object({
  /** A name the person can read: "workday:acme". */
  id: z.string(),
  provider: z.enum(["workday"]),
  /** The employer on that provider: accounts are per employer, never one for the whole provider. */
  tenant: z.string(),
  /** The exact origins a credential may be typed on. Nothing else, ever. HTTPS only; plain http is taken for a board on this machine, which is how the tests run. */
  allowedOrigins: z.array(z.string().url().refine(isSafeOrigin, "must be an https origin with no path")).min(1),
  email: z.string().email(),
  secret: SecretRef.default({ keychain: ACCOUNTS.passwordItem }),
  mode: Mode,
  /** May the tool read the verification email this board sends to that address. */
  emailVerification: z.boolean().default(false),
  /** The account-registration agreements the person approved, by name. "account_terms" is the terms box on the sign-up form. */
  agreements: z.array(z.string()).default([]),
  createdAt: z.string().nullable().default(null),
});
export type Account = z.infer<typeof Account>;

/** The person's standing rule for one provider: any employer on it may get an account on these terms. */
const ProviderRule = z.object({
  email: z.string().email(),
  mode: z.enum(["existing_only", "create_if_missing"]),
  emailVerification: z.boolean().default(false),
  agreements: z.array(z.string()).default([]),
  maxNewAccountsPerDay: z.number().int().min(0).default(ACCOUNTS.maxNewAccountsPerDay),
  secret: SecretRef.default({ keychain: ACCOUNTS.passwordItem }),
});
export type ProviderRule = z.infer<typeof ProviderRule>;

export const AccountsFile = z.object({
  version: z.literal(1).default(1),
  /** False when the person switched the sign-ins off. What is set up stays, and nothing signs in. */
  enabled: z.boolean().default(true),
  providers: z.object({ workday: ProviderRule.optional() }).default({}),
  accounts: z.array(Account).default([]),
});
export type AccountsFile = z.infer<typeof AccountsFile>;

export function loadAccounts(file = PATHS.accounts): AccountsFile {
  if (!existsSync(file)) return AccountsFile.parse({});
  const parsed = AccountsFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ")}`);
  return parsed.data;
}

export function saveAccounts(a: AccountsFile, file = PATHS.accounts): void {
  writeAtomic(file, JSON.stringify(a, null, 2) + "\n");
}

export function mutateAccounts<T>(fn: (a: AccountsFile) => T, file = PATHS.accounts): T {
  return withStore(() => {
    const a = loadAccounts(file);
    const out = fn(a);
    saveAccounts(a, file);
    return out;
  });
}

const AccountState = z.object({
  /** When the tool first knew this account exists on the board: it registered it, or signed in to it. */
  knownSince: z.string().nullable().default(null),
  lastLoginAt: z.string().nullable().default(null),
  /** Sign-in tries on one day. */
  attempts: z.object({ day: z.string(), count: z.number().int() }).default({ day: "", count: 0 }),
  /**
   * Set when a sign-in was refused or did not go through. The account is then left alone until the person signs
   * in themselves or clears it: nothing is retried on a timer. The date is kept for records that had one.
   */
  pausedUntil: z.string().nullable().default(null),
  pausedWhy: z.string().nullable().default(null),
  /** Set just before Create Account is clicked and cleared once the board's answer is known. Left behind only by a run that died in between. */
  pendingSince: z.string().nullable().default(null),
});
export type AccountState = z.infer<typeof AccountState>;

const StateFile = z.object({
  accounts: z.record(AccountState).default({}),
  /** Accounts the tool made, per day, to hold the person's daily limit. */
  created: z.record(z.number().int()).default({}),
});
export type StateFile = z.infer<typeof StateFile>;

/** A pause with no end: only the person lifts it. */
export const PAUSED = "9999-12-31T00:00:00.000Z";

export function loadState(file = PATHS.accountsState): StateFile {
  if (!existsSync(file)) return StateFile.parse({});
  try {
    return StateFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // It holds the pauses and the day's count. Starting over silently would lift every pause.
    throw new Error(`${file} cannot be read. It records which accounts are paused, so nothing signs in until it is fixed or removed by you.`);
  }
}

export function mutateState<T>(fn: (s: StateFile) => T, file = PATHS.accountsState): T {
  return withStore(() => {
    const s = loadState(file);
    const out = fn(s);
    writeAtomic(file, JSON.stringify(s, null, 2));
    return out;
  });
}

export const stateOf = (s: StateFile, id: string): AccountState => s.accounts[id] ?? AccountState.parse({});
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
