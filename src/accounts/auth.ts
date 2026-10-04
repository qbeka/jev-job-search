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
import { dayOf, loadAccounts, loadState, mutateAccounts, mutateState, PAUSED, stateOf, type Account, type ProviderRule } from "./config.js";
import type { Adapter, AuthPage, AuthSnapshot, Verifier } from "./provider.js";
import { generatePassword, itemFor, type SecretStore } from "./secrets.js";

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
  /** True in a rehearsal: an account the person has is signed in to, and nothing is made or asked for. */
  rehearsal?: boolean;
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

/** The password an account names: an item in the secret store, or an environment variable the person named themselves. */
const secretOf = (store: SecretStore, ref: Account["secret"]): Secret | null => {
  if ("keychain" in ref) return store.get(ref.keychain);
  const v = process.env[ref.passwordEnv];
  return v ? new Secret(v) : null;
};

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
  /** Left by a run that clicked Create Account and died before the board answered: when that was. */
  const leftBehind = state().pendingSince;
  /** Set once this pass clicked Create Account and the board has not said no: the account is taken to exist. */
  let created = false;
  /** True when the tool has reason to believe the account exists on the board. */
  const known = () => created || (!!account && (account.mode === "existing_only" || !!account.createdAt || !!state().knownSince));
  const mayRegister = () => !known() && (account ? account.mode === "create_if_missing" : rule?.mode === "create_if_missing");
  const terms = account ?? rule;
  const stop = (status: AuthStop["status"], waitingFor: WaitingFor | null, reason: string): AuthStop => ({ ok: false, status, waitingFor, reason, steps });
  if (!file.enabled) return stop("login_required", "login", "sign-ins are switched off. To switch them on again: /accounts on");
  if (account?.mode === "off") return stop("login_required", "login", `you told the tool to leave ${ctx.tenant.tenant} alone`);
  if (!terms) return stop("login_required", "login", `no account is set up for ${ctx.tenant.tenant}. To set one up: /accounts`);
  if (account && !account.allowedOrigins.includes(ctx.tenant.origin)) return stop("login_required", "login", `the account for ${ctx.tenant.tenant} is not allowed on ${ctx.tenant.origin}`);
  const allowed = account?.allowedOrigins ?? [ctx.tenant.origin];
  const email = terms.email;
  if (!email) return stop("login_required", "login", "no address is set for your job-board accounts. To set one up: /accounts");
  const own = itemFor(id);
  /** The password for this employer: its own, or the one the person stored for accounts they already had. Null when there is none: then only a session the person started is used. */
  const stored = (): Secret | null => ctx.secrets.get(own) ?? secretOf(ctx.secrets, terms.secret);
  /** True when this pass put a new password in the store for an account it is about to make. */
  let madePassword = false;
  const pausedStop = () => stop("awaiting_user_action", "login", `${state().pausedWhy ?? "the account is paused"}. Nothing is tried again until you sign in yourself in the tool's window, or store the right password (/accounts password ${ctx.tenant.tenant}) and lift the pause (/accounts clear)`);

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
  const setState = (patch: Partial<ReturnType<typeof state>>) =>
    mutateState((s) => {
      s.accounts[id] = { ...stateOf(s, id), ...patch };
    }, ctx.files?.state);
  /** A sign-in that was refused, or did not go through, is never tried again by the tool: only the person lifts this. */
  const pause = (why: string) => setState({ pausedUntil: PAUSED, pausedWhy: why });

  let triedLogin = false;
  let triedRegister = false;
  let verified = false;
  /** True once the board itself showed that the account this pass made exists: it asked for the address to be proven, or opened the application. */
  let confirmed = false;
  let unknown = 0;
  /** When the board was last asked for something that makes it send mail. */
  let askedAt: Date | null = null;
  /** What this pass wrote down before it clicked Create Account, so it can be taken back if the board did not make the account. */
  let sign: { before: Account | null; day: string; at: Date } | null = null;
  const counted = (day: string, by: number) =>
    mutateState((st) => {
      st.created[day] = Math.max(0, (st.created[day] ?? 0) + by);
    }, ctx.files?.state);
  /** The board did not make the account: the entry goes back to what the person had, and the day's count with it. */
  const notMade = () => {
    if (!sign) return;
    const was = sign.before;
    counted(sign.day, -1);
    mutateAccounts((f) => {
      f.accounts = [...f.accounts.filter((a) => a.id !== id), ...(was ? [was] : [])];
    }, ctx.files?.accounts);
    setState({ pendingSince: null });
    // The password made for an account that does not exist is of no use to anyone.
    if (madePassword) ctx.secrets.delete(own);
    madePassword = false;
    account = was;
    created = false;
    sign = null;
  };
  /** The board showed the account exists: it is written down as made. */
  const made = () => {
    if (!sign || confirmed) return;
    account = saveAccount({ createdAt: sign.at.toISOString() });
    setState({ pendingSince: null });
    confirmed = true;
  };

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
      // A paused account is touched only to use a session the person started themselves.
      if (view !== "signed_in" && state().pausedUntil) return pausedStop();

      if (view === "signed_in") {
        const who = adapter.identity(s);
        if (who && who !== email.toLowerCase()) return stop("awaiting_user_action", "login", "the tool's window is signed in to this employer with another address. Sign out there, then: /resume");
        made();
        account = saveAccount({});
        const at = now().toISOString();
        setState({ knownSince: state().knownSince ?? at, lastLoginAt: at, pausedUntil: null, pausedWhy: null, pendingSince: null });
        return { ok: true, account, created, steps };
      }

      if (view === "challenge") {
        notMade();
        return stop("awaiting_user_action", "robot_check", "the sign-in page asks you to confirm you are not a robot. The page is open in the tool's window");
      }
      if (view === "elsewhere") return stop("awaiting_user_action", "sso", "this employer signs people in another way (single sign-on, a passkey or a phone code). Sign in yourself in the tool's window");

      if (view === "method") {
        await click(adapter.controls.withEmail, "Sign in with email");
        continue;
      }

      if (view === "sign_in") {
        if (!known()) {
          if (!mayRegister()) return stop("login_required", "login", `no account is set up for ${ctx.tenant.tenant}. To allow one: npx jev accounts add`);
          await click(adapter.controls.toRegister, "Create Account");
          continue;
        }
        if (triedLogin) {
          // The click was made and the board neither let the tool in nor said why. That is not tried again.
          pause("a sign-in did not go through and the page did not say why");
          return stop("awaiting_user_action", "login", "the sign-in did not go through and the page does not say why. Nothing was retried. Sign in yourself in the tool's window");
        }
        const today = dayOf(now());
        const tries = state().attempts;
        if (tries.day === today && tries.count >= ACCOUNTS.maxLoginAttempts) return stop("awaiting_user_action", "login", `the tool tried to sign in ${tries.count} times today and leaves the account alone until tomorrow. Sign in yourself in the tool's window`);
        const password = stored();
        if (!password) return stop("awaiting_user_action", "login", `no password is stored for ${ctx.tenant.tenant}, so the tool only uses a session you started. Sign in yourself in the tool's window, or store this employer's password: /accounts password ${ctx.tenant.tenant}`);
        triedLogin = true;
        await enter(page, adapter.controls.email, email, allowed, "text");
        await enter(page, adapter.controls.password, password, allowed, "password");
        steps.push("typed the address and the password");
        setState({ attempts: { day: today, count: tries.day === today ? tries.count + 1 : 1 } });
        askedAt = now();
        await click(adapter.controls.signIn, "Sign In");
        const result = adapter.afterSignIn(await settled("sign_in"));
        steps.push(`sign-in: ${result}`);
        if (result === "wrong_password") {
          pause("the board refused the stored password");
          return stop("awaiting_user_action", "login", `the board refused the stored password. Nothing was retried. Sign in yourself in the tool's window, or store this employer's password (/accounts password ${ctx.tenant.tenant}), then: /resume`);
        }
        if (result === "locked") {
          pause("the board says the account is locked");
          return stop("awaiting_user_action", "login", "the board says the account is locked. The tool leaves it alone until you have signed in yourself");
        }
        if (result === "unclear") {
          pause("the board refused a sign-in with a message the tool does not know");
          return stop("awaiting_user_action", "login", "the board refused the sign-in with a message the tool does not know. Nothing was retried. Look at it in the tool's window");
        }
        if (result === "challenge") return stop("awaiting_user_action", "robot_check", "the sign-in page asks you to confirm you are not a robot. The page is open in the tool's window");
        continue;
      }

      if (view === "register") {
        if (triedRegister && created && !confirmed) {
          // Create Account was clicked and the form is still there with nothing said: the account was not made, as far as anyone can tell.
          notMade();
          return stop("awaiting_user_action", "login", "the sign-up did not go through and the page does not say why. Nothing was retried. Look at it in the tool's window");
        }
        if (known()) {
          await click(adapter.controls.toSignIn, "Sign In");
          continue;
        }
        if (!mayRegister()) return stop("login_required", "login", `no account is set up for ${ctx.tenant.tenant}. To set one up: /accounts`);
        if (triedRegister) return stop("awaiting_user_action", "login", "the sign-up did not go through. Look at it in the tool's window");
        if (ctx.rehearsal) return stop("queued", null, `a rehearsal makes no account. ${ctx.tenant.tenant} has none for you yet: to make it first, run /accounts setup ${ctx.tenant.tenant}`);
        const today = dayOf(now());
        const limit = rule?.maxNewAccountsPerDay ?? ACCOUNTS.maxNewAccountsPerDay;
        if ((loadState(ctx.files?.state).created[today] ?? 0) >= limit) return stop("queued", null, `today's limit of ${limit} new accounts is reached. This job waits for another day`);
        if (s.present.terms && !terms.agreements.includes("account_terms")) return stop("awaiting_user_action", "agreement", "the sign-up asks you to accept the account terms, which you have not approved for the tool. Accept them yourself in the tool's window, then: /resume");
        // Every new account gets a password of its own, made here and kept in the Keychain before anything is typed.
        // A run that died after its click left one behind: the account may have been made with it, so it is the one used.
        const kept = leftBehind ? ctx.secrets.get(own) : null;
        const password = kept ?? generatePassword();
        if (!kept) {
          ctx.secrets.set(own, password);
          madePassword = true;
        }
        triedRegister = true;
        await enter(page, adapter.controls.email, email, allowed, "text");
        await enter(page, adapter.controls.password, password, allowed, "password");
        if (s.present.passwordAgain) await enter(page, adapter.controls.passwordAgain, password, allowed, "password");
        if (s.present.terms) {
          if (!(await page.holds(adapter.controls.terms))?.checked) await page.click(adapter.controls.terms);
          if (!(await page.holds(adapter.controls.terms))?.checked) throw new Halt("awaiting_user_action", "agreement", "the account terms box would not take a tick. Tick it yourself in the tool's window");
        }
        steps.push("filled the sign-up form");
        // From this click on the account may exist. That is written down first, as not yet known, so a run that dies
        // here leaves a note and not a claim: the next run signs up again and the board says if the account is there.
        sign = { before: account, day: today, at: now() };
        account = saveAccount({ mode: "create_if_missing", secret: { keychain: own } });
        counted(today, 1);
        setState({ pendingSince: sign.at.toISOString() });
        created = true;
        askedAt = sign.at;
        await click(adapter.controls.register, "Create Account");
        const result = adapter.afterRegister(await settled("register"));
        steps.push(`sign-up: ${result}`);
        if (result === "exists") {
          // The board already has an account for this address. It is signed in to, once, like any other.
          counted(today, -1);
          setState({ pendingSince: null });
          // The password made a moment ago is not that account's. One kept from an earlier run may be.
          if (madePassword) ctx.secrets.delete(own);
          madePassword = false;
          sign = null;
          created = false;
          account = saveAccount({ mode: "existing_only", createdAt: null, secret: terms.secret });
          continue;
        }
        if (result === "challenge") {
          notMade();
          return stop("awaiting_user_action", "robot_check", "the sign-up page asks you to confirm you are not a robot. The page is open in the tool's window");
        }
        if (result === "password_refused") {
          notMade();
          return stop("awaiting_user_action", "login", "the board refused the password the tool made for a new account: this employer's rules differ. Make the account yourself in the tool's window, then: /resume");
        }
        if (result === "unclear") {
          notMade();
          return stop("awaiting_user_action", "login", "the board refused the sign-up with a message the tool does not know. Nothing was retried. Look at it in the tool's window");
        }
        continue;
      }

      if (view === "verify_email") {
        // The board asks for the address to be proven, so the account is there.
        made();
        if (verified) return stop("awaiting_email_verification", "email_link", "the verification email was used and the board still asks for it. Look at the tool's window");
        if (ctx.rehearsal) return stop("queued", null, `${ctx.tenant.tenant} wants your address proven first, and a rehearsal asks for no email. To do it: /accounts setup ${ctx.tenant.tenant}`);
        if (!terms.emailVerification) return stop("awaiting_email_verification", "email_link", "the board mailed you a link to prove the address is yours, and you have not let the tool read that mail. Click the link yourself, then: /resume");
        if (!ctx.verifier) return stop("awaiting_email_verification", "email_link", "the board mailed you a link to prove the address is yours, and no mailbox is connected. Click the link yourself, then: /resume");
        // A sign-up from this pass, or from a run that died minutes ago, is when the email was asked for.
        const earlier = account?.createdAt ?? leftBehind;
        const recent = earlier && now().getTime() - Date.parse(earlier) < GMAIL.requestTtlMs ? new Date(earlier) : null;
        const request = () => ({ accountId: id, recipient: email, allowedOrigins: allowed, since: recent ?? askedAt ?? now(), shape: adapter.mail });
        let found = await ctx.verifier.find(request());
        for (let resent = 0; !found.ok && resent < ACCOUNTS.maxResends; resent++) {
          if (!(await page.clickByText(adapter.words.panel, adapter.resend))) break;
          steps.push("asked the board to send the email again");
          askedAt = now();
          await page.wait(ACCOUNTS.stepMs);
          found = await ctx.verifier.find({ ...request(), since: askedAt });
        }
        if (!found.ok) return stop("awaiting_email_verification", "email_link", `${found.why}. Click the link in the board's email yourself, then: /resume`);
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
          return stop("awaiting_email_verification", "email_link", "the board's email held nothing the tool can use. Follow it yourself, then: /resume");
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
