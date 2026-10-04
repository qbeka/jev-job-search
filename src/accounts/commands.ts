/**
 * What the `accounts` command does, apart from the terminal: set the standing rule for a
 * provider, add one employer, say what is set up, lift a pause, forget an account. The password
 * itself is typed by the person into the Keychain's own prompt and never passes through here.
 */
import { ACCOUNTS } from "../config.js";
import { accountId } from "./auth.js";
import { adapterFor } from "./capability.js";
import { dayOf, loadAccounts, loadState, mutateAccounts, mutateState, stateOf, type Account } from "./config.js";
import { itemFor, passwordProblems, type SecretStore } from "./secrets.js";

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

/** The one password, by its name in the secret store: the Keychain on a Mac, JEV_ACCOUNTS_PASSWORD in .env elsewhere. */
const secretRef = (): Account["secret"] => ({ keychain: ACCOUNTS.passwordItem });

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

/** Tells the tool to leave one employer alone, whatever the rule for its board says. */
export function leaveAlone(link: string, email: string, files: Files = {}): Account {
  const a = addEmployer(link, { email, create: false, terms: false, verifyEmail: false }, files);
  return mutateAccounts((f) => {
    const at = f.accounts.findIndex((x) => x.id === a.id);
    const next: Account = { ...a, mode: "off" };
    f.accounts[at] = next;
    return next;
  }, files.accounts);
}

/** Switches every sign-in off or on. What is set up, the passwords and the sessions all stay. */
export function setEnabled(on: boolean, files: Files = {}): void {
  mutateAccounts((f) => {
    f.enabled = on;
  }, files.accounts);
}

/** The accounts a name stands for: an id, an employer's name, a link to its site, or "all". */
export function accountsNamed(which: string, files: Files = {}): Account[] {
  const all = loadAccounts(files.accounts).accounts;
  if (which === "all") return all;
  const id = adapterFor(which);
  const wanted = id ? accountId(id.adapter.provider, id.tenant.tenant) : which.toLowerCase();
  return all.filter((a) => a.id === wanted || a.tenant === wanted);
}

/**
 * Removes what this machine holds for one account, or with "all" for every account and the rule:
 * the entry, its password in the store, and what the tool remembered about it. The account on the
 * employer's own site is not touched. Returns the accounts removed, so their sessions can be cleared.
 */
export function forgetAccounts(which: string, store: SecretStore, files: Files = {}): Account[] {
  const gone = accountsNamed(which, files);
  mutateAccounts((f) => {
    f.accounts = f.accounts.filter((a) => !gone.some((g) => g.id === a.id));
    if (which === "all") f.providers = {};
  }, files.accounts);
  mutateState((s) => {
    for (const g of gone) delete s.accounts[g.id];
  }, files.state);
  for (const g of gone) store.delete(itemFor(g.id));
  if (which === "all") store.delete(ACCOUNTS.passwordItem);
  return gone;
}

/** What a set of answers lets the tool do, in plain words, for the person to read before it is saved. */
export function describeConsent(c: Consent, where: string): string[] {
  const out = [`For ${where}, as ${c.email}:`, "  - The tool signs in to an account you have there, when it holds that account's password or a session you started."];
  if (c.create) out.push(`  - EXPERIMENTAL. Where you have no account, the tool makes one: your address, and a password it makes up for that employer alone and keeps in your Keychain. At most ${c.maxNew ?? ACCOUNTS.maxNewAccountsPerDay} new accounts a day. Each one is a real account with that employer, in your name.`);
  else out.push("  - Where you have no account, nothing is made. The job is left for you.");
  if (c.create) out.push(c.terms ? "  - It ticks the box that accepts the employer's candidate-account terms, for you. You are agreeing to each employer's terms without reading them one by one. A marketing box is never ticked." : "  - It does not accept account terms. A sign-up that asks for them is left open for you.");
  if (c.create) out.push(c.verifyEmail ? "  - EXPERIMENTAL. It reads the one email an employer sends to prove your address, through Gmail if you connected it, and opens its link. Otherwise you click the link." : "  - You click the link in each employer's verification email yourself.");
  out.push("  - It never passes a robot check, a phone code, a passkey or single sign-on. Those stop the job and wait for you.");
  return out;
}

/** Lifts every pause, or one account's, and forgets today's sign-in tries: for after the person fixed what was wrong. */
export function clearPauses(files: Files = {}, only?: string): number {
  return mutateState((s) => {
    let n = 0;
    for (const [id, a] of Object.entries(s.accounts)) {
      if (only && id !== only) continue;
      if (a.pausedUntil) n++;
      s.accounts[id] = { ...a, pausedUntil: null, pausedWhy: null, pendingSince: null, attempts: { day: "", count: 0 } };
    }
    return n;
  }, files.state);
}

/** What is set up, as lines for the terminal. No secret is in any of it. */
export function describeAccounts(store: SecretStore, files: Files = {}, now = new Date()): string[] {
  const f = loadAccounts(files.accounts);
  const s = loadState(files.state);
  const lines: string[] = [];
  if (!f.enabled) lines.push("Sign-ins are switched OFF. Nothing signs in until you switch them on: /accounts on");
  const rule = f.providers.workday;
  if (rule) {
    const made = s.created[dayOf(now)] ?? 0;
    lines.push(`Workday, any employer, as ${rule.email}: ${rule.mode === "create_if_missing" ? `sign in, or make an account where there is none (experimental; at most ${rule.maxNewAccountsPerDay} new a day, ${made} made today)` : "sign in only, to the employers listed below"}`);
    if (rule.mode === "create_if_missing") lines.push(`  account terms on sign-up: ${rule.agreements.includes("account_terms") ? "accepted for you" : "left for you"}; verification email: ${rule.emailVerification ? "read from your connected mailbox (experimental)" : "you click the link"}`);
  } else {
    lines.push("Workday, any employer: no standing rule. The tool uses only the employers listed below.");
  }
  const shared = store.get(ACCOUNTS.passwordItem);
  if (shared) lines.push(`A password for accounts you already had is stored${passwordProblems(shared).some((p) => /plain keyboard/.test(p)) ? ", but it holds a character the Keychain cannot hand back as typed" : ""}. It is tried once at an employer that has no password of its own.`);
  if (!f.accounts.length) lines.push("No employer account yet. To sign in to one yourself, once: /accounts signin <employer or link>");
  for (const a of f.accounts) {
    const st = stateOf(s, a.id);
    const how = a.mode === "off" ? "left alone, as you said" : a.createdAt ? `made by the tool on ${a.createdAt.slice(0, 10)}` : a.mode === "existing_only" ? "your own account" : "to be made on first use";
    const secret = a.mode === "off" ? "" : store.get(itemFor(a.id)) ? "its own password is stored" : shared ? "uses the password for accounts you had" : "no password stored: uses a session you start";
    lines.push(`${a.id}  ${a.email}  ${how}${secret ? `; ${secret}` : ""}; ${st.lastLoginAt ? `last signed in ${st.lastLoginAt.slice(0, 10)}` : "never signed in"}${st.pausedUntil ? `  PAUSED: ${st.pausedWhy ?? ""} (sign in yourself, or /accounts password ${a.tenant} and /accounts clear)` : ""}`);
  }
  return lines;
}
