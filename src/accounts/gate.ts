/**
 * Where the apply loop meets the sign-in: one call that takes a real tab on an account board to
 * the application, or says why it could not. Also what `resume` and `accounts signin` need to see
 * that the person finished a sign-in by hand.
 */
import { ACCOUNTS, RUN } from "../config.js";
import type { Page } from "../browser/cdp.js";
import { sleep } from "../browser/cdp.js";
import { trace } from "../browser/session.js";
import { gmailClient } from "../mail/gmail.js";
import { mailVerifier } from "../mail/verification.js";
import { accountId, ensureSignedIn, type AuthResult } from "./auth.js";
import { cdpAuthPage } from "./authPage.js";
import { adapterFor } from "./capability.js";
import { loadAccounts, mutateAccounts, mutateState, stateOf } from "./config.js";
import { defaultStore, itemFor } from "./secrets.js";

/**
 * Signs in on the tab for an application on an account board. Null when the link is not on one.
 * In a rehearsal an account the person has is signed in to, and none is made.
 */
export async function signInFor(page: Page, applicationUrl: string, opts: { rehearsal?: boolean } = {}): Promise<AuthResult | null> {
  const found = adapterFor(applicationUrl);
  if (!found) return null;
  const store = defaultStore();
  const client = gmailClient(store);
  const auth = cdpAuthPage(page);
  const result = await ensureSignedIn(auth, { adapter: found.adapter, tenant: found.tenant, applicationUrl, secrets: store, verifier: client ? mailVerifier(client) : null, rehearsal: !!opts.rehearsal, note: trace });
  trace(`sign-in: ${result.steps.join("; ")}`);
  if (!result.ok) return result;
  // A draft the board saved opens in the middle. The form is taken back to its first page, so every page is read and checked.
  for (let i = 0; i < RUN.maxPages && (await auth.click(found.adapter.controls.back)); i++) await sleep(ACCOUNTS.stepMs);
  return result;
}

/**
 * True once the tab shows the application: the person finished the sign-in themselves. The account
 * is written down as theirs, with the address the page shows or the one given, and a pause on it is lifted.
 */
export async function signedInNow(page: Page, applicationUrl: string, email = ""): Promise<boolean> {
  const found = adapterFor(applicationUrl);
  if (!found) return false;
  const s = await cdpAuthPage(page).read(found.adapter.controls, found.adapter.words);
  if (found.adapter.tenantOf(s.url)?.origin !== found.tenant.origin || found.adapter.view(s) !== "signed_in") return false;
  const id = accountId(found.adapter.provider, found.tenant.tenant);
  const address = found.adapter.identity(s) ?? email;
  mutateAccounts((f) => {
    if (f.accounts.some((a) => a.id === id) || !address) return;
    f.accounts.push({ id, provider: found.adapter.provider, tenant: found.tenant.tenant, allowedOrigins: [found.tenant.origin], email: address, secret: { keychain: itemFor(id) }, mode: "existing_only", emailVerification: false, agreements: [], createdAt: null });
  });
  const at = new Date().toISOString();
  mutateState((st) => {
    st.accounts[id] = { ...stateOf(st, id), knownSince: stateOf(st, id).knownSince ?? at, lastLoginAt: at, pausedUntil: null, pausedWhy: null, pendingSince: null };
  });
  return true;
}

/** The address accounts use when a page does not show one: the standing rule's, or an entry's. */
export const accountEmail = (): string => {
  const f = loadAccounts();
  return f.providers.workday?.email ?? f.accounts[0]?.email ?? "";
};
