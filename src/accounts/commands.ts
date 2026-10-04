/**
 * What the `accounts` command does, apart from the terminal: set the standing rule for a
 * provider, add one employer, say what is set up, lift a pause, forget an account. The password
 * itself is typed by the person into the Keychain's own prompt and never passes through here.
 */
import { ACCOUNTS } from "../config.js";
import { accountId } from "./auth.js";
import { adapterFor } from "./capability.js";
import { dayOf, loadAccounts, loadState, mutateAccounts, mutateState, stateOf, type Account } from "./config.js";
import { passwordProblems, type SecretStore } from "./secrets.js";

export type Consent = {
  email: string;
  /** May the tool make an account where the employer has none for this address. */
  create: boolean;
  /** May it tick the account terms box on the sign-up form. */
  terms: boolean;
  /** May it read the verification email the board sends to that address. */
  verifyEmail: boolean;
  maxNew?: number;
};
type Files = { accounts?: string; state?: string };

const secretRef = (): Account["secret"] => (process.platform === "darwin" ? { keychain: ACCOUNTS.passwordItem } : { passwordEnv: "JEV_ACCOUNTS_PASSWORD" });

/** The standing rule for every employer on a provider. */
export function setRule(provider: "workday", c: Consent, files: Files = {}): void {
  mutateAccounts((f) => {
    f.providers[provider] = {
      email: c.email,
      mode: c.create ? "create_if_missing" : "existing_only",
      emailVerification: c.verifyEmail,
      agreements: c.terms ? ["account_terms"] : [],
      maxNewAccountsPerDay: c.maxNew ?? ACCOUNTS.maxNewAccountsPerDay,
      secret: secretRef(),
    };
  }, files.accounts);
}

/** One employer, from any link to its careers site. Without `create` it is an account the person already has. */
export function addEmployer(link: string, c: Consent, files: Files = {}): Account {
  const found = adapterFor(link);
  if (!found) throw new Error("that link is not on a job board the tool can sign in to. Today that is Workday: a link like https://acme.wd5.myworkdayjobs.com/...");
  const id = accountId(found.adapter.provider, found.tenant.tenant);
  return mutateAccounts((f) => {
    const was = f.accounts.find((a) => a.id === id);
    const next: Account = {
      id,
      provider: found.adapter.provider,
      tenant: found.tenant.tenant,
      allowedOrigins: [found.tenant.origin],
      email: c.email,
      secret: secretRef(),
      mode: c.create ? "create_if_missing" : "existing_only",
      emailVerification: c.verifyEmail,
      agreements: c.terms ? ["account_terms"] : [],
      createdAt: was?.createdAt ?? null,
    };
    f.accounts = [...f.accounts.filter((a) => a.id !== id), next];
    return next;
  }, files.accounts);
}

/** Forgets one account, or with "all" every account and every rule. Nothing is changed on the board itself. */
export function removeAccounts(which: string, files: Files = {}): number {
  const n = mutateAccounts((f) => {
    const before = f.accounts.length;
    if (which === "all") {
      f.accounts = [];
      f.providers = {};
      return before;
    }
    f.accounts = f.accounts.filter((a) => a.id !== which && a.tenant !== which);
    return before - f.accounts.length;
  }, files.accounts);
  mutateState((s) => {
    for (const id of Object.keys(s.accounts)) if (which === "all" || id === which || id.endsWith(`:${which}`)) delete s.accounts[id];
  }, files.state);
  return n;
}

/** Lifts every pause and forgets today's sign-in tries: for after the person fixed what was wrong. */
export function clearPauses(files: Files = {}): number {
  return mutateState((s) => {
    let n = 0;
    for (const [id, a] of Object.entries(s.accounts)) {
      if (a.pausedUntil) n++;
      s.accounts[id] = { ...a, pausedUntil: null, pausedWhy: null, attempts: { day: "", count: 0 } };
    }
    return n;
  }, files.state);
}

/** What is set up, as lines for the terminal. No secret is in any of it. */
export function describeAccounts(store: SecretStore, files: Files = {}, now = new Date()): string[] {
  const f = loadAccounts(files.accounts);
  const s = loadState(files.state);
  const lines: string[] = [];
  const password = store.get(ACCOUNTS.passwordItem);
  const problems = password ? passwordProblems(password) : [];
  lines.push(`Password for job-board accounts: ${!password ? "not set. Set it: npx jev accounts password" : problems.length ? `stored, but Workday will refuse it (it needs ${problems.join(", ")})` : "stored in the Keychain"}`);
  const rule = f.providers.workday;
  if (rule) {
    const made = s.created[dayOf(now)] ?? 0;
    lines.push(`Workday, any employer: ${rule.mode === "create_if_missing" ? `sign in, or make an account where there is none (at most ${rule.maxNewAccountsPerDay} new a day, ${made} made today)` : "sign in only, to the employers listed below"} as ${rule.email}`);
    lines.push(`  account terms on sign-up: ${rule.agreements.includes("account_terms") ? "accepted for you" : "left for you"}; verification email: ${rule.emailVerification ? "read from your connected mailbox" : "left for you"}`);
  } else {
    lines.push("Workday, any employer: not allowed. To allow it: npx jev accounts add workday --email you@example.com --create --terms --verify-email");
  }
  if (!f.accounts.length) lines.push("No employer account yet.");
  for (const a of f.accounts) {
    const st = stateOf(s, a.id);
    const paused = st.pausedUntil && Date.parse(st.pausedUntil) > now.getTime();
    lines.push(`${a.id}  ${a.email}  ${a.createdAt ? `made by the tool on ${a.createdAt.slice(0, 10)}` : a.mode === "existing_only" ? "your own account" : "to be made on first use"}  ${st.lastLoginAt ? `last signed in ${st.lastLoginAt.slice(0, 10)}` : "never signed in"}${paused ? `  PAUSED: ${st.pausedWhy ?? ""} (lift it: npx jev accounts status --clear)` : ""}`);
  }
  return lines;
}
