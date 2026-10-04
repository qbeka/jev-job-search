/**
 * Signs in to a job board the person has an account on, or makes the account where they said the
 * tool may. One pass, every exit bounded: one sign-in try, one sign-up, one verification email,
 * a fixed number of steps. Whatever it cannot do with certainty it leaves to the person, with the
 * reason. A wrong password is never retried and never leads to a new account.
 *
 * A credential is typed only into a box the adapter names, only while the tab is on an origin the
 * account allows, and only after the box was checked to be the right kind. Nothing a page says
 * changes which credential is used or where it goes.
 */
import { ACCOUNTS, GMAIL } from "../config.js";
import type { WaitingFor } from "../jobs/queue.js";
import { Secret } from "../util/redact.js";
import { dayOf, loadAccounts, loadState, mutateAccounts, mutateState, stateOf, type Account, type ProviderRule } from "./config.js";
import type { Adapter, AuthPage, AuthSnapshot, Verifier } from "./provider.js";
import { EnvStore, type SecretStore } from "./secrets.js";

export type AuthContext = {
  adapter: Adapter;
  tenant: { tenant: string; origin: string };
  /** The address that opens the application, to return to after a verification link. */
  applicationUrl: string;
  secrets: SecretStore;
  /** Reads the verification email. Null when the person has not connected a mailbox. */
  verifier: Verifier | null;
  files?: { accounts?: string; state?: string };
  now?: () => Date;
};

export type AuthStop = {
  ok: false;
  /** queued: nothing is wrong, the job waits for another day (today's limit of new accounts). */
  status: "login_required" | "awaiting_user_action" | "awaiting_email_verification" | "queued";
  waitingFor: WaitingFor | null;
  reason: string;
  steps: string[];
};
export type AuthResult = { ok: true; account: Account; created: boolean; steps: string[] } | AuthStop;

export const accountId = (provider: string, tenant: string) => `${provider}:${tenant}`;

class Halt extends Error {
  constructor(readonly status: AuthStop["status"], readonly waitingFor: WaitingFor | null, reason: string) {
    super(reason);
  }
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const secretOf = (store: SecretStore, ref: Account["secret"]): Secret | null => ("keychain" in ref ? store.get(ref.keychain) : new EnvStore().get(ref.passwordEnv));

/**
 * Types one value into one named box and checks it stayed. The tab must be on an allowed origin,
 * and a password goes only into a password box, an address only into a box that is not one.
 */
async function enter(page: AuthPage, selector: string, value: string | Secret, allowed: string[], kind: "text" | "password" | "code"): Promise<void> {
  if (!allowed.includes(originOf(await page.url()))) throw new Halt("awaiting_user_action", "unknown", "the page left the employer's own site, so nothing was typed");
  const box = await page.holds(selector);
  if (!box) throw new Halt("awaiting_user_action", "unknown", "a box the sign-in needs is not on the page");
  if ((kind === "password") !== box.password) throw new Halt("awaiting_user_action", "unknown", "a box on the sign-in page is not the kind it should be, so nothing was typed");
  if (!(await page.focus(selector))) throw new Halt("awaiting_user_action", "unknown", "a box on the sign-in page would not take the keyboard");
  if (value instanceof Secret) await page.typeSecret(value);
  else await page.type(value);
  const now = await page.holds(selector);
  if (!now || now.length !== value.length || (!(value instanceof Secret) && now.value !== value)) throw new Halt("awaiting_user_action", "unknown", "what was typed on the sign-in page did not stay in its box");
}

export async function ensureSignedIn(page: AuthPage, ctx: AuthContext): Promise<AuthResult> {
  const { adapter } = ctx;
  const now = ctx.now ?? (() => new Date());
  const steps: string[] = [];
  const id = accountId(adapter.provider, ctx.tenant.tenant);
  const file = loadAccounts(ctx.files?.accounts);
  const rule: ProviderRule | null = file.providers[adapter.provider] ?? null;
  let account: Account | null = file.accounts.find((a) => a.id === id) ?? null;
  const state = () => stateOf(loadState(ctx.files?.state), id);
  /** True when the tool has reason to believe the account exists on the board. */
  const known = () => !!account && (account.mode === "existing_only" || !!account.createdAt || !!state().knownSince);
  const mayRegister = () => !known() && (account ? account.mode === "create_if_missing" : rule?.mode === "create_if_missing");
  const terms = account ?? rule;
  const stop = (status: AuthStop["status"], waitingFor: WaitingFor | null, reason: string): AuthStop => ({ ok: false, status, waitingFor, reason, steps });
  if (!terms) return stop("login_required", "login", `no account is set up for ${ctx.tenant.tenant}. To allow one: npx jev accounts add`);
  if (account && !account.allowedOrigins.includes(ctx.tenant.origin)) return stop("login_required", "login", `the account for ${ctx.tenant.tenant} is not allowed on ${ctx.tenant.origin}`);
  const allowed = account?.allowedOrigins ?? [ctx.tenant.origin];
  const email = terms.email;
  const password = secretOf(ctx.secrets, terms.secret);
  if (!password) return stop("login_required", "login", "no password is stored for your job-board accounts. Set one: npx jev accounts password");
  const paused = state().pausedUntil;
  if (paused && Date.parse(paused) > now().getTime()) return stop("awaiting_user_action", "login", `${state().pausedWhy ?? "the account is paused"}. Sign in yourself in the tool's window, or fix it and run: npx jev accounts status --clear`);

  const read = (): Promise<AuthSnapshot> => page.read(adapter.controls, adapter.words);
  const click = async (selector: string, what: string) => {
    if (!(await page.click(selector))) throw new Halt("awaiting_user_action", "unknown", `the ${what} button is not on the page`);
    steps.push(`clicked ${what}`);
    await page.wait(ACCOUNTS.stepMs);
  };
  /** Reads the page after a click until it has moved to another view or says something, within a few reads. */
  const settled = async (was: string): Promise<AuthSnapshot> => {
    let s = await read();
    for (let i = 1; i < ACCOUNTS.settleReads && !s.errors.length && adapter.view(s) === was; i++) {
      await page.wait(ACCOUNTS.stepMs);
      s = await read();
    }
    return s;
  };
  const saveAccount = (patch: Partial<Account>): Account =>
    mutateAccounts((f) => {
      const at = f.accounts.findIndex((a) => a.id === id);
      const next: Account = { ...(f.accounts[at] ?? { id, provider: adapter.provider, tenant: ctx.tenant.tenant, allowedOrigins: [ctx.tenant.origin], email, secret: terms.secret, mode: "existing_only", emailVerification: terms.emailVerification, agreements: terms.agreements, createdAt: null }), ...patch };
      if (at >= 0) f.accounts[at] = next;
      else f.accounts.push(next);
      return next;
    }, ctx.files?.accounts);
  const pause = (why: string) =>
    mutateState((s) => {
      s.accounts[id] = { ...stateOf(s, id), pausedUntil: new Date(now().getTime() + ACCOUNTS.lockoutPauseHours * 3_600_000).toISOString(), pausedWhy: why };
    }, ctx.files?.state);

  let triedLogin = false;
  let triedRegister = false;
  let verified = false;
  let created = false;
  let unknown = 0;
  /** When the board was last asked for something that makes it send mail. */
  let askedAt: Date | null = null;

  try {
    for (let step = 0; step < ACCOUNTS.maxSteps; step++) {
      const s = await read();
      if (!allowed.includes(originOf(s.url))) return stop("awaiting_user_action", "sso", "the sign-in moved to another site, which this account is not used on. Finish it yourself in the tool's window");
      if (s.present.declineCookies) {
        // The cookie notice lies over the form. Declining is the choice that shares the least.
        await page.click(adapter.controls.declineCookies);
        steps.push("declined the cookie notice");
        await page.wait(ACCOUNTS.stepMs / 2);
        continue;
      }
      const view = adapter.view(s);
      steps.push(`page: ${view}`);

      if (view === "signed_in") {
        const who = adapter.identity(s);
        if (who && who !== email.toLowerCase()) return stop("awaiting_user_action", "login", "the tool's window is signed in to this employer with another address. Sign out there, then run: npx jev resume");
        account = saveAccount({});
        const at = now().toISOString();
        mutateState((st) => {
          st.accounts[id] = { ...stateOf(st, id), knownSince: stateOf(st, id).knownSince ?? at, lastLoginAt: at, pausedUntil: null, pausedWhy: null };
        }, ctx.files?.state);
        return { ok: true, account, created, steps };
      }

      if (view === "challenge") return stop("awaiting_user_action", "robot_check", "the sign-in page asks you to confirm you are not a robot. The page is open in the tool's window");
      if (view === "elsewhere") return stop("awaiting_user_action", "sso", "this employer signs people in another way (single sign-on, a passkey or a phone code). Sign in yourself in the tool's window");

      if (view === "method") {
        await click(adapter.controls.withEmail, "Sign in with email");
        continue;
      }

      if (view === "sign_in") {
        if (!known()) {
          if (!mayRegister()) return stop("login_required", "login", `no account is set up for ${ctx.tenant.tenant}. To allow one: npx jev accounts add`);
          if (triedRegister) return stop("awaiting_user_action", "login", "the sign-up did not finish and the page is back at the sign-in. Look at it in the tool's window");
          await click(adapter.controls.toRegister, "Create Account");
          continue;
        }
        if (triedLogin) return stop("awaiting_user_action", "login", "the sign-in did not go through and the page does not say why. Sign in yourself in the tool's window");
        const today = dayOf(now());
        const tries = state().attempts;
        if (tries.day === today && tries.count >= ACCOUNTS.maxLoginAttempts) return stop("awaiting_user_action", "login", `the tool tried to sign in ${tries.count} times today and leaves the account alone until tomorrow. Sign in yourself in the tool's window`);
        triedLogin = true;
        await enter(page, adapter.controls.email, email, allowed, "text");
        await enter(page, adapter.controls.password, password, allowed, "password");
        steps.push("typed the address and the password");
        mutateState((st) => {
          const was = stateOf(st, id);
          st.accounts[id] = { ...was, attempts: { day: today, count: was.attempts.day === today ? was.attempts.count + 1 : 1 } };
        }, ctx.files?.state);
        askedAt = now();
        await click(adapter.controls.signIn, "Sign In");
        const result = adapter.afterSignIn(await settled("sign_in"));
        steps.push(`sign-in: ${result}`);
        if (result === "wrong_password") {
          pause("the board refused the stored password");
          return stop("awaiting_user_action", "login", "the board refused the stored password. Nothing was retried. Sign in yourself in the tool's window, or set the right password: npx jev accounts password");
        }
        if (result === "locked") {
          pause("the board says the account is locked");
          return stop("awaiting_user_action", "login", `the board says the account is locked. The tool leaves it alone for ${ACCOUNTS.lockoutPauseHours} hours`);
        }
        if (result === "challenge") return stop("awaiting_user_action", "robot_check", "the sign-in page asks you to confirm you are not a robot. The page is open in the tool's window");
        continue;
      }

      if (view === "register") {
        if (known()) {
          await click(adapter.controls.toSignIn, "Sign In");
          continue;
        }
        if (!mayRegister()) return stop("login_required", "login", `no account is set up for ${ctx.tenant.tenant}. To allow one: npx jev accounts add`);
        if (triedRegister) return stop("awaiting_user_action", "login", "the sign-up did not go through and the page does not say why. Look at it in the tool's window");
        const today = dayOf(now());
        const limit = rule?.maxNewAccountsPerDay ?? ACCOUNTS.maxNewAccountsPerDay;
        if ((loadState(ctx.files?.state).created[today] ?? 0) >= limit) return stop("queued", null, `today's limit of ${limit} new accounts is reached. This job waits for another day`);
        if (s.present.terms && !terms.agreements.includes("account_terms")) return stop("awaiting_user_action", "agreement", "the sign-up asks you to accept the account terms, which you have not approved for the tool. Accept them yourself in the tool's window, or allow it: npx jev accounts add");
        triedRegister = true;
        await enter(page, adapter.controls.email, email, allowed, "text");
        await enter(page, adapter.controls.password, password, allowed, "password");
        if (s.present.passwordAgain) await enter(page, adapter.controls.passwordAgain, password, allowed, "password");
        if (s.present.terms) {
          if (!(await page.holds(adapter.controls.terms))?.checked) await page.click(adapter.controls.terms);
          if (!(await page.holds(adapter.controls.terms))?.checked) throw new Halt("awaiting_user_action", "agreement", "the account terms box would not take a tick. Tick it yourself in the tool's window");
        }
        steps.push("filled the sign-up form");
        // From this click on the account may exist, so it is written down first.
        account = saveAccount({ mode: "create_if_missing", createdAt: now().toISOString() });
        mutateState((st) => {
          st.created[today] = (st.created[today] ?? 0) + 1;
        }, ctx.files?.state);
        created = true;
        askedAt = now();
        await click(adapter.controls.register, "Create Account");
        const result = adapter.afterRegister(await settled("register"));
        steps.push(`sign-up: ${result}`);
        const notMade = () => {
          created = false;
          mutateState((st) => {
            st.created[today] = Math.max(0, (st.created[today] ?? 1) - 1);
          }, ctx.files?.state);
        };
        if (result === "exists") {
          // The board already has an account for this address. It is signed in to, once, like any other.
          notMade();
          account = saveAccount({ mode: "existing_only", createdAt: null });
          continue;
        }
        if (result === "password_refused" || result === "challenge") {
          notMade();
          mutateAccounts((f) => {
            f.accounts = f.accounts.filter((a) => a.id !== id);
          }, ctx.files?.accounts);
          account = null;
          return result === "challenge"
            ? stop("awaiting_user_action", "robot_check", "the sign-up page asks you to confirm you are not a robot. The page is open in the tool's window")
            : stop("awaiting_user_action", "login", "the board refused the password for a new account: it does not meet this employer's rules. Choose another: npx jev accounts password");
        }
        continue;
      }

      if (view === "verify_email") {
        if (verified) return stop("awaiting_email_verification", null, "the verification email was used and the board still asks for it. Look at the tool's window");
        if (!terms.emailVerification) return stop("awaiting_email_verification", null, "the board mailed you a link to prove the address is yours, and you have not let the tool read that mail. Click the link yourself, then run: npx jev resume");
        if (!ctx.verifier) return stop("awaiting_email_verification", null, "the board mailed you a link to prove the address is yours, and no mailbox is connected. Click the link yourself, or connect Gmail (npx jev gmail connect), then run: npx jev resume");
        const madeAt = account?.createdAt ? new Date(account.createdAt) : null;
        const recent = madeAt && now().getTime() - madeAt.getTime() < GMAIL.requestTtlMs ? madeAt : null;
        const request = () => ({ accountId: id, recipient: email, allowedOrigins: allowed, since: recent ?? askedAt ?? now(), shape: adapter.mail });
        let found = await ctx.verifier.find(request());
        for (let resent = 0; !found.ok && resent < ACCOUNTS.maxResends; resent++) {
          if (!(await page.clickByText(adapter.words.panel, adapter.resend))) break;
          steps.push("asked the board to send the email again");
          askedAt = now();
          await page.wait(ACCOUNTS.stepMs);
          found = await ctx.verifier.find({ ...request(), since: askedAt });
        }
        if (!found.ok) return stop("awaiting_email_verification", null, `${found.why}. Click the link in the board's email yourself, then run: npx jev resume`);
        verified = true;
        if (found.link) {
          const went = await page.follow(found.link, allowed);
          ctx.verifier.consume(found.messageId);
          steps.push("opened the verification link");
          if (!went.ok) return stop("awaiting_user_action", "unknown", `the verification link did not stay on the employer's site${went.why ? ` (${went.why})` : ""}. Nothing more was done`);
          await page.navigate(ctx.applicationUrl);
          await page.wait(ACCOUNTS.stepMs);
        } else if (found.code && adapter.controls.code) {
          await enter(page, adapter.controls.code, found.code, allowed, "code");
          ctx.verifier.consume(found.messageId);
          await click(adapter.controls.sendCode, "Verify");
          steps.push("typed the verification code");
        } else {
          return stop("awaiting_email_verification", null, "the board's email held nothing the tool can use. Follow it yourself, then run: npx jev resume");
        }
        // The address is proven: one sign-in is allowed again.
        triedLogin = false;
        continue;
      }

      // A page still drawing itself looks like nothing at first.
      if (++unknown >= ACCOUNTS.unknownReads) return stop("awaiting_user_action", "unknown", "the page is not a sign-in the tool knows. Look at it in the tool's window");
      await page.wait(ACCOUNTS.stepMs);
    }
    return stop("awaiting_user_action", "unknown", "the sign-in took more steps than the tool allows itself. Look at it in the tool's window");
  } catch (err) {
    if (err instanceof Halt) return stop(err.status, err.waitingFor, err.message);
    throw err;
  }
}
