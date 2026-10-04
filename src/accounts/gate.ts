/**
 * Where the apply loop meets the sign-in: one call that takes a real tab on an account board to
 * the application, or says why it could not. Also what `resume` needs to see that the person
 * finished a sign-in by hand.
 */
import { ACCOUNTS, RUN } from "../config.js";
import type { Page } from "../browser/cdp.js";
import { sleep } from "../browser/cdp.js";
import { gmailClient } from "../mail/gmail.js";
import { mailVerifier } from "../mail/verification.js";
import { accountId, ensureSignedIn, type AuthResult } from "./auth.js";
import { cdpAuthPage } from "./authPage.js";
import { adapterFor } from "./capability.js";
import { mutateState, stateOf } from "./config.js";
import { defaultStore } from "./secrets.js";

/** Signs in on the tab for an application on an account board. Null when the link is not on one. */
export async function signInFor(page: Page, applicationUrl: string): Promise<AuthResult | null> {
  const found = adapterFor(applicationUrl);
  if (!found) return null;
  const store = defaultStore();
  const client = gmailClient(store);
  const auth = cdpAuthPage(page);
  const result = await ensureSignedIn(auth, { adapter: found.adapter, tenant: found.tenant, applicationUrl, secrets: store, verifier: client ? mailVerifier(client) : null });
  if (!result.ok) return result;
  // A draft the board saved opens in the middle. The form is taken back to its first page, so every page is read and checked.
  for (let i = 0; i < RUN.maxPages && (await auth.click(found.adapter.controls.back)); i++) await sleep(ACCOUNTS.stepMs);
  return result;
}

/** True once the tab shows the application: the person finished the sign-in themselves. A pause on the account is lifted. */
export async function signedInNow(page: Page, applicationUrl: string): Promise<boolean> {
  const found = adapterFor(applicationUrl);
  if (!found) return false;
  const s = await cdpAuthPage(page).read(found.adapter.controls, found.adapter.words);
  if (found.adapter.tenantOf(s.url)?.origin !== found.tenant.origin || found.adapter.view(s) !== "signed_in") return false;
  const id = accountId(found.adapter.provider, found.tenant.tenant);
  const at = new Date().toISOString();
  mutateState((st) => {
    st.accounts[id] = { ...stateOf(st, id), knownSince: stateOf(st, id).knownSince ?? at, lastLoginAt: at, pausedUntil: null, pausedWhy: null, pendingSince: null };
  });
  return true;
}
