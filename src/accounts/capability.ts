/**
 * Whether the tool can apply on a site that wants an account: it can where the person has an
 * account it knows, or where they allowed it to make one. Every other account site stays what it
 * was, a job for the person.
 */
import { ACCOUNTS } from "../config.js";
import { accountId } from "./auth.js";
import { dayOf, loadAccounts, loadState, stateOf, type Account } from "./config.js";
import type { Adapter } from "./provider.js";
import { workday } from "./workday.js";

const ADAPTERS: readonly Adapter[] = [workday];

export function adapterFor(url: string): { adapter: Adapter; tenant: { tenant: string; origin: string } } | null {
  for (const adapter of ADAPTERS) {
    const tenant = adapter.tenantOf(url);
    if (tenant) return { adapter, tenant };
  }
  return null;
}

export type Capability = {
  adapter: Adapter;
  tenant: { tenant: string; origin: string };
  account: Account | null;
  /** can: the tool may sign in now. wait: it may, on another day. no: the person has not allowed it. */
  verdict: "can" | "wait" | "no";
  /** True when applying means making a new account first. */
  creates: boolean;
  reason: string | null;
};

type Files = { accounts?: string; state?: string };

/** Null for a link that is not on a board the tool can sign in to: the older rules decide about it. */
export function capabilityFor(url: string, files: Files = {}, now = new Date()): Capability | null {
  const found = adapterFor(url);
  if (!found) return null;
  const { adapter, tenant } = found;
  const id = accountId(adapter.provider, tenant.tenant);
  const file = loadAccounts(files.accounts);
  const state = loadState(files.state);
  const account = file.accounts.find((a) => a.id === id) ?? null;
  const rule = file.providers[adapter.provider] ?? null;
  const st = stateOf(state, id);
  const base = { adapter, tenant, account };
  if (!file.enabled) return { ...base, verdict: "no", creates: false, reason: "sign-ins are switched off (/accounts on)" };
  if (account?.mode === "off") return { ...base, verdict: "no", creates: false, reason: `you told the tool to leave ${tenant.tenant} alone` };
  if (st.pausedUntil) return { ...base, verdict: "wait", creates: false, reason: `${st.pausedWhy ?? "the account is paused"}. Sign in yourself in the tool's window, or run: npx jev accounts status --clear` };
  if (account && (account.mode === "existing_only" || account.createdAt || st.knownSince)) return { ...base, verdict: "can", creates: false, reason: null };
  const mayCreate = account ? account.mode === "create_if_missing" : rule?.mode === "create_if_missing";
  if (!mayCreate) return { ...base, verdict: "no", creates: false, reason: `${adapter.provider} (needs an account per company)` };
  const limit = rule?.maxNewAccountsPerDay ?? ACCOUNTS.maxNewAccountsPerDay;
  if ((state.created[dayOf(now)] ?? 0) >= limit) return { ...base, verdict: "wait", creates: true, reason: `today's limit of ${limit} new accounts is reached` };
  return { ...base, verdict: "can", creates: true, reason: null };
}

/**
 * Says, for each job a run would take, whether it may: null, or the reason it may not today. It
 * counts the new accounts the jobs already taken will make, so one run never plans more than the
 * day allows, and it takes one job per new employer.
 */
export function accountGate(files: Files = {}, now = new Date()): (url: string) => string | null {
  const planned = new Set<string>();
  const made = loadState(files.state).created[dayOf(now)] ?? 0;
  const limit = loadAccounts(files.accounts).providers.workday?.maxNewAccountsPerDay ?? ACCOUNTS.maxNewAccountsPerDay;
  return (url) => {
    const c = capabilityFor(url, files, now);
    if (!c) return null;
    if (c.verdict !== "can") return c.reason;
    if (!c.creates) return null;
    if (planned.has(c.tenant.tenant)) return "another job in this run opens the account for this employer first";
    if (made + planned.size >= limit) return `today's limit of ${limit} new accounts is reached`;
    planned.add(c.tenant.tenant);
    return null;
  };
}
