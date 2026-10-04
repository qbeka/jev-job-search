import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSignedIn, type AuthContext } from "../src/accounts/auth.js";
import { askPassword } from "../src/accounts/ask.js";
import { accountGate, adapterFor, capabilityFor } from "../src/accounts/capability.js";
import { accountsNamed, addEmployer, clearPauses, describeAccounts, describeConsent, forgetAccounts, leaveAlone, setEnabled, setRule } from "../src/accounts/commands.js";
import { AccountsFile, dayOf, loadAccounts, loadState, mutateState, stateOf } from "../src/accounts/config.js";
import type { AuthSnapshot, VerificationFound, VerificationRequest, Verifier } from "../src/accounts/provider.js";
import { EnvStore, envNameOf, generatePassword, itemFor, KeychainStore, MemoryStore, passwordProblems } from "../src/accounts/secrets.js";
import { workday } from "../src/accounts/workday.js";
import { ACCOUNTS } from "../src/config.js";
import { pickJobs } from "../src/run/pipeline.js";
import { Secret } from "../src/util/redact.js";
import { APPLY, FakeWorkday, ORIGIN, type Server } from "./helpers/fakeWorkday.js";

// Every credential here is made up for the test. No real account is touched.
const EMAIL = "candidate@example.com";
const PASSWORD = "Fake-Pass-123!";
const NOW = new Date("2026-10-03T15:00:00Z");

let files: { accounts: string; state: string };
let store: MemoryStore;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-accounts-"));
  files = { accounts: path.join(dir, "accounts.json"), state: path.join(dir, "state.json") };
  store = new MemoryStore();
  store.values.set(ACCOUNTS.passwordItem, PASSWORD);
});

const OWN = itemFor("workday:acme");
/** Forgets everything set up so far, and puts back the password the person uses on accounts they already had. */
const startOver = () => {
  forgetAccounts("all", store, files);
  store.values.set(ACCOUNTS.passwordItem, PASSWORD);
};
const allowAll = (over: Partial<Parameters<typeof setRule>[1]> = {}) => setRule("workday", { email: EMAIL, create: true, terms: true, verifyEmail: true, ...over }, files);
const server = (over: Partial<Server> = {}): Server => ({ account: null, verifies: false, token: "tok123", ...over });
const ctx = (verifier: Verifier | null = null): AuthContext => ({ adapter: workday, tenant: { tenant: "acme", origin: ORIGIN }, applicationUrl: APPLY, secrets: store, verifier, files, now: () => NOW });

function scriptedVerifier(answers: VerificationFound[]): Verifier & { asked: VerificationRequest[]; used: string[] } {
  const asked: VerificationRequest[] = [];
  const used: string[] = [];
  return {
    asked,
    used,
    find: async (req) => {
      asked.push(req);
      return answers.shift() ?? { ok: false, why: "no verification email arrived" };
    },
    consume: (id) => void used.push(id),
  };
}

/** A password must only ever be typed into a password box, on the employer's own origin. */
const passwordStayedHome = (page: FakeWorkday) => page.typed.filter((t) => t.secret).every((t) => (t.box === "password" || t.box === "passwordAgain") && t.origin === ORIGIN);

describe("the Workday adapter", () => {
  const live = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "workday-auth.json"), "utf8")) as { register: AuthSnapshot; signIn: AuthSnapshot };

  it("finds the employer and the one origin its account is used on", () => {
    expect(workday.tenantOf("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Intern_R1")).toEqual({ tenant: "acme", origin: "https://acme.wd5.myworkdayjobs.com" });
    expect(workday.tenantOf("https://wd5.myworkdaysite.com/recruiting/acme/Careers/job/x")).toEqual({ tenant: "acme", origin: "https://wd5.myworkdaysite.com" });
    expect(workday.tenantOf("http://acme.wd5.myworkdayjobs.com/x")).toBeNull();
    expect(workday.tenantOf("https://acme.wd5.myworkdayjobs.com.evil.example/x")).toBeNull();
    expect(workday.tenantOf("https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
  });

  it("builds the address that opens the application", () => {
    expect(workday.applicationUrl("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Intern_R1?source=x")).toBe("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Intern_R1/apply/applyManually");
    expect(workday.applicationUrl("https://acme.wd5.myworkdayjobs.com/Careers/job/Toronto/Intern_R1/apply")).toBe("https://acme.wd5.myworkdayjobs.com/Careers/job/Toronto/Intern_R1/apply/applyManually");
  });

  it("tells the live sign-up and sign-in pages apart", () => {
    expect(workday.view(live.register)).toBe("register");
    expect(workday.view(live.signIn)).toBe("sign_in");
  });

  it("does not read the sign-up form's own words as an error", () => {
    // "Already have an account? Sign In" and "Verify New Password" are on every sign-up page.
    expect(workday.afterRegister(live.register)).toBe("moved_on");
    expect(workday.view({ ...live.register, errors: ["Verify New Password is required"] })).toBe("register");
  });

  it("reads what the board says after a click", () => {
    const said = (errors: string[]) => ({ ...live.signIn, errors });
    expect(workday.afterSignIn(said(["ERROR: Invalid Username/Password"]))).toBe("wrong_password");
    expect(workday.afterSignIn(said(["Your account has been locked."]))).toBe("locked");
    expect(workday.afterSignIn(said(["Your account has not been verified. Check your email."]))).toBe("verify_email");
    expect(workday.afterSignIn(said(["Something went wrong"]))).toBe("unclear");
    // A hiccup is not a lockout, and a message about the password is a refusal however it is worded.
    expect(workday.afterSignIn(said(["Something went wrong. Please try again later."]))).toBe("unclear");
    expect(workday.afterSignIn(said(["We couldn't verify your email address or password."]))).toBe("wrong_password");
    expect(workday.view(said(["We couldn't verify your email address or password."]))).toBe("sign_in");
    expect(workday.afterSignIn(said(["Too many failed attempts."]))).toBe("locked");
    expect(workday.afterRegister({ ...live.register, errors: ["An account already exists for this email address."] })).toBe("exists");
    expect(workday.afterRegister({ ...live.register, errors: ["Password must contain a special character."] })).toBe("password_refused");
  });

  it("never names the box that is there to catch robots", () => {
    expect(Object.values(workday.controls).join(" ")).not.toMatch(/beecatcher/);
  });
});

describe("signing in", () => {
  it("makes an account where the person allowed it, ticks the terms, and ends in the application", async () => {
    allowAll();
    const page = new FakeWorkday(server());
    const r = await ensureSignedIn(page, ctx());
    expect(r.ok && r.created).toBe(true);
    expect(page.view).toBe("application");
    expect(page.terms).toBe(true);
    // The account has a password of its own, made by the tool and kept in the store. It is not the one the person uses elsewhere.
    const own = store.values.get(OWN) ?? "";
    expect(page.server.account).toEqual({ email: EMAIL, password: own, verified: true });
    expect(own).not.toBe(PASSWORD);
    expect(passwordProblems(new Secret(own))).toEqual([]);
    expect(passwordStayedHome(page)).toBe(true);
    const saved = loadAccounts(files.accounts).accounts[0];
    expect(saved).toMatchObject({ id: "workday:acme", tenant: "acme", allowedOrigins: [ORIGIN], email: EMAIL, mode: "create_if_missing" });
    expect(saved?.createdAt).toBe(NOW.toISOString());
    expect(loadState(files.state).created[dayOf(NOW)]).toBe(1);
    // Nothing secret reaches a file.
    expect(readFileSync(files.accounts, "utf8") + readFileSync(files.state, "utf8")).not.toContain(own);
    expect(JSON.stringify(r)).not.toContain(own);
  });

  it("waits for a page that is still drawing itself, and declines the cookie notice", async () => {
    allowAll();
    const page = new FakeWorkday(server());
    page.blankReads = 2;
    page.cookieNotice = true;
    const r = await ensureSignedIn(page, ctx());
    expect(r.ok).toBe(true);
    expect(r.steps).toContain("declined the cookie notice");
  });

  it("signs in to an account the person already has", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true } }));
    const r = await ensureSignedIn(page, ctx());
    expect(r.ok && !r.created).toBe(true);
    expect(page.registerClicks).toBe(0);
    expect(page.signInClicks).toBe(1);
    expect(passwordStayedHome(page)).toBe(true);
    expect(stateOf(loadState(files.state), "workday:acme").lastLoginAt).toBe(NOW.toISOString());
  });

  it("uses a session that is already signed in, and types nothing", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const page = new FakeWorkday(server(), "application");
    page.header = EMAIL;
    const r = await ensureSignedIn(page, ctx());
    expect(r.ok).toBe(true);
    expect(page.typed).toEqual([]);
  });

  it("stops when the window is signed in as someone else", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const page = new FakeWorkday(server(), "application");
    page.header = "someone.else@example.com";
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
    expect(!r.ok && r.reason).not.toContain("someone.else@example.com");
  });

  it("never retries a wrong password, never makes a new account after one, and leaves the account alone afterwards", async () => {
    allowAll();
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: "Another-Pass-9!", verified: true } }));
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
    expect(page.signInClicks).toBe(1);
    expect(page.registerClicks).toBe(0);
    // The next run does not touch the page at all.
    const again = new FakeWorkday(page.server);
    const second = await ensureSignedIn(again, ctx());
    expect(second.ok).toBe(false);
    expect(again.clicks).toEqual([]);
    expect(again.typed).toEqual([]);
    expect(capabilityFor(APPLY, files, NOW)?.verdict).toBe("wait");
    expect(clearPauses(files)).toBe(1);
    expect(capabilityFor(APPLY, files, NOW)?.verdict).toBe("can");
  });

  it("does not try a refused password again on a later day", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: "Another-Pass-9!", verified: true } }));
    await ensureSignedIn(page, ctx());
    const later = new Date(NOW.getTime() + 40 * 24 * 3_600_000);
    const again = new FakeWorkday(page.server);
    const r = await ensureSignedIn(again, { ...ctx(), now: () => later });
    expect(r.ok).toBe(false);
    expect(again.typed).toEqual([]);
    expect(capabilityFor(APPLY, files, later)?.verdict).toBe("wait");
  });

  it("does not retry a sign-in the board refused in words it does not know, or without a word", async () => {
    for (const says of ["We could not complete your request.", ""]) {
      startOver();
      addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
      const page = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true }, signInSays: says }));
      const r = await ensureSignedIn(page, ctx());
      expect(r, says).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
      expect(page.signInClicks).toBe(1);
      // The next job for this employer, in the same run or the next, types nothing.
      const next = new FakeWorkday(page.server);
      expect((await ensureSignedIn(next, ctx())).ok).toBe(false);
      expect(next.typed).toEqual([]);
    }
  });

  it("leaves a locked account alone", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true, locked: true } }));
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
    expect(page.signInClicks).toBe(1);
    expect(stateOf(loadState(files.state), "workday:acme").pausedWhy).toMatch(/locked/);
  });

  it("stops after the day's sign-in tries are used up, before typing", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    mutateState((s) => {
      s.accounts["workday:acme"] = { ...stateOf(s, "workday:acme"), attempts: { day: dayOf(NOW), count: ACCOUNTS.maxLoginAttempts } };
    }, files.state);
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true } }));
    const r = await ensureSignedIn(page, ctx());
    expect(r.ok).toBe(false);
    expect(page.typed).toEqual([]);
  });

  it("signs in once when the sign-up says the account already exists", async () => {
    allowAll();
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true } }));
    const r = await ensureSignedIn(page, ctx());
    expect(r.ok && !r.created).toBe(true);
    expect(page.registerClicks).toBe(1);
    expect(page.signInClicks).toBe(1);
    expect(loadState(files.state).created[dayOf(NOW)]).toBe(0);
    expect(loadAccounts(files.accounts).accounts[0]).toMatchObject({ mode: "existing_only", createdAt: null });
  });

  it("hands over when the account exists with another password", async () => {
    allowAll();
    const page = new FakeWorkday(server({ account: { email: EMAIL, password: "Another-Pass-9!", verified: true } }));
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
    expect(page.registerClicks).toBe(1);
    expect(page.signInClicks).toBe(1);
  });

  it("leaves a robot check to the person and forgets the account that was not made", async () => {
    allowAll();
    const page = new FakeWorkday(server({ robotOnRegister: true }));
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "robot_check" });
    expect(loadAccounts(files.accounts).accounts).toEqual([]);
    expect(loadState(files.state).created[dayOf(NOW)]).toBe(0);
    // The password made for an account that was not made is gone too.
    expect(store.values.has(OWN)).toBe(false);
  });

  it("does not write down an account the board did not make", async () => {
    for (const says of ["Something went wrong.", ""]) {
      startOver();
      allowAll();
      const page = new FakeWorkday(server({ signUpSays: says }));
      const r = await ensureSignedIn(page, ctx());
      expect(r, says).toMatchObject({ ok: false, status: "awaiting_user_action" });
      expect(page.registerClicks).toBe(1);
      // No sign-in was tried for an account that is not there, and nothing is left that says it is.
      expect(page.signInClicks).toBe(0);
      expect(loadAccounts(files.accounts).accounts).toEqual([]);
      expect(loadState(files.state).created[dayOf(NOW)]).toBe(0);
      expect(stateOf(loadState(files.state), "workday:acme")).toMatchObject({ pausedUntil: null, pendingSince: null });
      expect(capabilityFor(APPLY, files, NOW)).toMatchObject({ verdict: "can", creates: true });
    }
  });

  it("keeps the person's own entry when a sign-up does not go through", async () => {
    const mine = addEmployer(APPLY, { email: EMAIL, create: true, terms: true, verifyEmail: false }, files);
    const r = await ensureSignedIn(new FakeWorkday(server({ robotOnRegister: true })), ctx());
    expect(r).toMatchObject({ ok: false, waitingFor: "robot_check" });
    expect(loadAccounts(files.accounts).accounts).toEqual([mine]);
    expect(capabilityFor(APPLY, files, NOW)).toMatchObject({ verdict: "can", creates: true });
  });

  it("does not accept account terms the person has not approved", async () => {
    allowAll({ terms: false });
    const page = new FakeWorkday(server());
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "agreement" });
    expect(page.typed).toEqual([]);
    expect(page.registerClicks).toBe(0);
  });

  it("holds the day's limit of new accounts", async () => {
    allowAll({ maxNew: 1 });
    mutateState((s) => {
      s.created[dayOf(NOW)] = 1;
    }, files.state);
    const page = new FakeWorkday(server());
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "queued" });
    expect(page.typed).toEqual([]);
  });

  it("does nothing where the person allowed nothing", async () => {
    const page = new FakeWorkday(server());
    expect(await ensureSignedIn(page, ctx())).toMatchObject({ ok: false, status: "login_required" });
    setRule("workday", { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    expect(await ensureSignedIn(page, ctx())).toMatchObject({ ok: false, status: "login_required" });
    expect(page.clicks).toEqual([]);
    expect(page.typed).toEqual([]);
  });

  it("needs no password from the person to make an account, and gives every employer its own", async () => {
    allowAll();
    store.values.clear();
    const r = await ensureSignedIn(new FakeWorkday(server()), ctx());
    expect(r.ok && r.created).toBe(true);
    const a = generatePassword().reveal();
    const b = generatePassword().reveal();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(ACCOUNTS.generatedLength);
    expect(passwordProblems(new Secret(a))).toEqual([]);
  });

  it("uses only a session the person started when no password is stored for an employer", async () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    store.values.clear();
    // Signed in by the person: used as it is.
    const open = new FakeWorkday(server(), "application");
    open.header = EMAIL;
    expect((await ensureSignedIn(open, ctx())).ok).toBe(true);
    // The session has ended: nothing is typed, and the person is asked to sign in again or store that employer's password.
    const ended = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true } }));
    const r = await ensureSignedIn(ended, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
    expect(!r.ok && r.reason).toMatch(/accounts password acme/);
    expect(ended.typed).toEqual([]);
    expect(ended.signInClicks).toBe(0);
    // Once that employer's own password is stored, it is the one used.
    store.values.set(OWN, PASSWORD);
    expect((await ensureSignedIn(new FakeWorkday(ended.server), ctx())).ok).toBe(true);
  });

  it("makes no account and asks for no email in a rehearsal, and still signs in to an account the person has", async () => {
    allowAll();
    const fresh = new FakeWorkday(server());
    const r = await ensureSignedIn(fresh, { ...ctx(), rehearsal: true });
    expect(r).toMatchObject({ ok: false, status: "queued" });
    expect(!r.ok && r.reason).toMatch(/rehearsal makes no account.*accounts setup acme/);
    expect(fresh.registerClicks).toBe(0);
    expect(fresh.typed).toEqual([]);
    expect(store.values.has(OWN)).toBe(false);
    expect(loadAccounts(files.accounts).accounts).toEqual([]);
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    const mine = new FakeWorkday(server({ account: { email: EMAIL, password: PASSWORD, verified: true } }));
    expect((await ensureSignedIn(mine, { ...ctx(), rehearsal: true })).ok).toBe(true);
    // An account that still has to prove its address is not chased in a rehearsal either.
    startOver();
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: true }, files);
    const v = scriptedVerifier([{ ok: true, messageId: "m", link: `${ORIGIN}/Careers/activate/tok123`, code: null }]);
    const unproven = new FakeWorkday(server({ verifies: true, account: { email: EMAIL, password: PASSWORD, verified: false } }));
    const waits = await ensureSignedIn(unproven, { ...ctx(v), rehearsal: true });
    expect(waits).toMatchObject({ ok: false, status: "queued" });
    expect(v.asked).toEqual([]);
  });

  it("does nothing while sign-ins are switched off, or for an employer the person said to leave alone", async () => {
    allowAll();
    setEnabled(false, files);
    const page = new FakeWorkday(server());
    expect(await ensureSignedIn(page, ctx())).toMatchObject({ ok: false, status: "login_required" });
    expect(capabilityFor(APPLY, files, NOW)?.verdict).toBe("no");
    setEnabled(true, files);
    expect(capabilityFor(APPLY, files, NOW)?.verdict).toBe("can");
    leaveAlone(APPLY, EMAIL, files);
    expect(capabilityFor(APPLY, files, NOW)).toMatchObject({ verdict: "no" });
    expect(await ensureSignedIn(page, ctx())).toMatchObject({ ok: false, status: "login_required" });
    // The rule still stands for every other employer.
    expect(capabilityFor("https://globex.wd1.myworkdayjobs.com/Careers/job/x/Intern_R2", files, NOW)?.verdict).toBe("can");
    expect(page.clicks).toEqual([]);
  });

  it("types nothing on a page that is not the employer's own site", async () => {
    allowAll();
    const page = new FakeWorkday(server());
    page.address = "https://acme.wd5.myworkdayjobs.com.evil.example/apply";
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "sso" });
    expect(page.typed).toEqual([]);
    expect(page.clicks).toEqual([]);
  });

  it("leaves single sign-on to the person", async () => {
    allowAll();
    const r = await ensureSignedIn(new FakeWorkday(server(), "sso"), ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "sso" });
  });

  it("gives up on a page it does not know after a few reads", async () => {
    allowAll();
    const page = new FakeWorkday(server(), "blank");
    const r = await ensureSignedIn(page, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "unknown" });
    expect(r.steps.length).toBeLessThanOrEqual(ACCOUNTS.maxSteps + 2);
  });
});

describe("proving the address by email", () => {
  const link = `${ORIGIN}/Careers/activate/tok123`;

  it("opens the board's link, then signs in", async () => {
    allowAll();
    const page = new FakeWorkday(server({ verifies: true }));
    const v = scriptedVerifier([{ ok: true, messageId: "m1", link, code: null }]);
    const r = await ensureSignedIn(page, ctx(v));
    expect(r.ok && r.created).toBe(true);
    expect(page.followed).toEqual([link]);
    expect(v.used).toEqual(["m1"]);
    expect(v.asked[0]).toMatchObject({ accountId: "workday:acme", recipient: EMAIL, allowedOrigins: [ORIGIN] });
    expect(page.registerClicks).toBe(1);
    expect(page.signInClicks).toBe(1);
    expect(page.view).toBe("application");
  });

  it("waits for the person when no mailbox is connected, or reading mail was not allowed", async () => {
    allowAll();
    const first = await ensureSignedIn(new FakeWorkday(server({ verifies: true })), ctx(null));
    expect(first).toMatchObject({ ok: false, status: "awaiting_email_verification" });
    startOver();
    allowAll({ verifyEmail: false });
    const v = scriptedVerifier([{ ok: true, messageId: "m1", link, code: null }]);
    const second = await ensureSignedIn(new FakeWorkday(server({ verifies: true })), ctx(v));
    expect(second).toMatchObject({ ok: false, status: "awaiting_email_verification" });
    expect(v.asked).toEqual([]);
  });

  it("stops when the mail cannot be trusted or told apart", async () => {
    allowAll();
    const v = scriptedVerifier([{ ok: false, why: "more than one verification email arrived and the tool will not guess between them" }]);
    const page = new FakeWorkday(server({ verifies: true }));
    const r = await ensureSignedIn(page, ctx(v));
    expect(r).toMatchObject({ ok: false, status: "awaiting_email_verification" });
    expect(!r.ok && r.reason).toMatch(/more than one/);
    expect(page.followed).toEqual([]);
  });

  it("asks the board to send it again, once", async () => {
    allowAll();
    const page = new FakeWorkday(server({ verifies: true, canResend: true }));
    const v = scriptedVerifier([{ ok: false, why: "no verification email arrived" }, { ok: true, messageId: "m2", link, code: null }]);
    const r = await ensureSignedIn(page, ctx(v));
    expect(r.ok).toBe(true);
    expect(page.resent).toBe(1);
    expect(v.asked).toHaveLength(2);
  });

  it("does not go on after a link that leaves the employer's site", async () => {
    allowAll();
    const page = new FakeWorkday(server({ verifies: true }));
    const v = scriptedVerifier([{ ok: true, messageId: "m3", link: `${link}?then=elsewhere`, code: null }]);
    const r = await ensureSignedIn(page, ctx(v));
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action" });
    expect(page.signInClicks).toBe(0);
    // The message was used all the same: it is never tried again.
    expect(v.used).toEqual(["m3"]);
  });

  it("picks up after a run that stopped between the sign-up and the verification", async () => {
    allowAll();
    // An earlier run clicked Create Account five minutes ago and then died.
    const made = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    writeFileSync(files.accounts, JSON.stringify({ ...loadAccounts(files.accounts), accounts: [{ id: "workday:acme", provider: "workday", tenant: "acme", allowedOrigins: [ORIGIN], email: EMAIL, mode: "create_if_missing", emailVerification: true, agreements: ["account_terms"], createdAt: made }] }));
    const page = new FakeWorkday(server({ verifies: true, account: { email: EMAIL, password: PASSWORD, verified: false } }));
    const v = scriptedVerifier([{ ok: true, messageId: "m4", link, code: null }]);
    const r = await ensureSignedIn(page, ctx(v));
    expect(r.ok && !r.created).toBe(true);
    expect(page.registerClicks).toBe(0);
    expect(page.signInClicks).toBe(2);
    // The email asked for is the one from the sign-up, not only one newer than this run.
    expect(v.asked[0]?.since.toISOString()).toBe(made);
  });

  it("picks up after a run that died right after the click on Create Account", async () => {
    allowAll();
    // What such a run leaves: an entry that claims nothing, and a note of when it clicked.
    const clicked = new Date(NOW.getTime() - 3 * 60_000).toISOString();
    writeFileSync(files.accounts, JSON.stringify({ ...loadAccounts(files.accounts), accounts: [{ id: "workday:acme", provider: "workday", tenant: "acme", allowedOrigins: [ORIGIN], email: EMAIL, mode: "create_if_missing", emailVerification: true, agreements: ["account_terms"], createdAt: null }] }));
    mutateState((s) => {
      s.accounts["workday:acme"] = { ...stateOf(s, "workday:acme"), pendingSince: clicked };
      s.created[dayOf(NOW)] = 1;
    }, files.state);
    // That run made a password for the account before it clicked. The account was made with it.
    store.values.set(OWN, "Earlier-Made-Pass-1!");
    const page = new FakeWorkday(server({ verifies: true, account: { email: EMAIL, password: "Earlier-Made-Pass-1!", verified: false } }));
    const v = scriptedVerifier([{ ok: true, messageId: "m5", link, code: null }]);
    const r = await ensureSignedIn(page, ctx(v));
    // The board says the account is there, so it is signed in to and its address proven. It is not counted twice.
    expect(r.ok && !r.created).toBe(true);
    expect(page.registerClicks).toBe(1);
    expect(page.signInClicks).toBe(2);
    expect(v.asked[0]?.since.toISOString()).toBe(clicked);
    expect(loadState(files.state).created[dayOf(NOW)]).toBe(1);
    expect(stateOf(loadState(files.state), "workday:acme").pendingSince).toBeNull();
    expect(store.values.get(OWN)).toBe("Earlier-Made-Pass-1!");
  });

  it("writes the account down as made once the board asks for the address to be proven", async () => {
    allowAll();
    const page = new FakeWorkday(server({ verifies: true }));
    const r = await ensureSignedIn(page, ctx(null));
    expect(r).toMatchObject({ ok: false, status: "awaiting_email_verification", waitingFor: "email_link" });
    expect(loadAccounts(files.accounts).accounts[0]?.createdAt).toBe(NOW.toISOString());
    expect(loadState(files.state).created[dayOf(NOW)]).toBe(1);
  });
});

describe("what the tool may apply to", () => {
  const other = "https://globex.wd1.myworkdayjobs.com/Careers/job/x/Intern_R2";
  const third = "https://initech.wd3.myworkdayjobs.com/Careers/job/x/Intern_R3";

  it("says no until the person allows it, and nothing at all about other boards", () => {
    expect(capabilityFor("https://boards.greenhouse.io/acme/jobs/1", files, NOW)).toBeNull();
    expect(adapterFor("https://jobs.lever.co/acme/123")).toBeNull();
    expect(capabilityFor(APPLY, files, NOW)).toMatchObject({ verdict: "no", reason: "workday (needs an account per company)" });
    allowAll();
    expect(capabilityFor(APPLY, files, NOW)).toMatchObject({ verdict: "can", creates: true });
  });

  it("knows an account the person added, and one the tool signed in to", () => {
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    expect(capabilityFor(APPLY, files, NOW)).toMatchObject({ verdict: "can", creates: false });
    expect(capabilityFor(other, files, NOW)?.verdict).toBe("no");
  });

  it("plans no more new accounts than the day allows, and one job per new employer", () => {
    allowAll({ maxNew: 2 });
    const gate = accountGate(files, NOW);
    expect(gate("https://jobs.lever.co/acme/123")).toBeNull();
    expect(gate(APPLY)).toBeNull();
    expect(gate(APPLY.replace("Software-Intern_R1", "Data-Intern_R9"))).toMatch(/another job in this run/);
    expect(gate(other)).toBeNull();
    expect(gate(third)).toMatch(/limit of 2/);
  });

  it("leaves a job that must wait in the queue and takes the next one", () => {
    allowAll({ maxNew: 1 });
    const entry = (id: string, url: string, score: number) => ({ job: { id, url, company: id, title: "Intern", ats: "workday", locations: [], postedAt: null }, status: "queued", fit: { score }, attempts: 0 }) as never;
    const entries = [entry("a", APPLY, 0.9), entry("b", other, 0.8), entry("c", "https://jobs.lever.co/acme/123", 0.7)];
    const { picked } = pickJobs(entries, [], { count: 3, dry: false }, accountGate(files, NOW));
    expect(picked.map((e) => e.job.id)).toEqual(["a", "c"]);
    const named = pickJobs(entries, ["b"], { count: 1, dry: false }, (url) => (url === other ? "today's limit of 1 new accounts is reached" : null));
    expect(named.picked).toEqual([]);
    expect(named.refused[0]?.why).toMatch(/limit/);
  });
});

describe("the accounts file and the secret store", () => {
  it("ships an example that is valid and holds no secret", () => {
    const text = readFileSync(path.join(__dirname, "..", "data", "accounts.example.json"), "utf8");
    const parsed = AccountsFile.parse(JSON.parse(text));
    expect(parsed.providers.workday?.mode).toBe("create_if_missing");
    expect(text).not.toMatch(/"password"\s*:|token|secret"\s*:\s*"[^{]/i);
  });

  it("stops, and does not start over, when the file that holds the pauses cannot be read", () => {
    writeFileSync(files.state, "{ not json");
    expect(() => loadState(files.state)).toThrow(/cannot be read/);
    expect(() => capabilityFor(APPLY, files, NOW)).toThrow(/cannot be read/);
  });

  it("refuses a file that is not valid, and says where", () => {
    writeFileSync(files.accounts, JSON.stringify({ accounts: [{ id: "x", provider: "workday", tenant: "acme", allowedOrigins: ["not a url"], email: "nope", mode: "existing_only" }] }));
    expect(() => loadAccounts(files.accounts)).toThrow(/allowedOrigins|email/);
    // An origin a credential may be typed on is HTTPS and nothing but an origin.
    const withOrigin = (origin: string) => JSON.stringify({ accounts: [{ id: "x", provider: "workday", tenant: "acme", allowedOrigins: [origin], email: EMAIL, mode: "existing_only" }] });
    for (const bad of ["http://acme.wd5.myworkdayjobs.com", "https://acme.wd5.myworkdayjobs.com/path", "https://user@acme.wd5.myworkdayjobs.com"]) {
      writeFileSync(files.accounts, withOrigin(bad));
      expect(() => loadAccounts(files.accounts), bad).toThrow(/https origin/);
    }
    writeFileSync(files.accounts, withOrigin(ORIGIN));
    expect(loadAccounts(files.accounts).accounts).toHaveLength(1);
  });

  it("describes what is set up without any secret", () => {
    allowAll();
    addEmployer(APPLY, { email: EMAIL, create: false, terms: false, verifyEmail: false }, files);
    store.values.set(OWN, "Own-Made-Up-Pass-7!");
    const text = describeAccounts(store, files, NOW).join("\n");
    expect(text).toMatch(/A password for accounts you already had is stored/);
    expect(text).toMatch(/workday:acme.*its own password is stored/);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("Own-Made-Up-Pass-7!");
    expect(accountsNamed("acme", files).map((a) => a.id)).toEqual(["workday:acme"]);
    expect(accountsNamed(APPLY, files)).toHaveLength(1);
    // Forgetting one employer removes its entry, its password and what was remembered. The rule and the other password stay.
    expect(forgetAccounts("acme", store, files).map((a) => a.id)).toEqual(["workday:acme"]);
    expect(store.values.has(OWN)).toBe(false);
    expect(store.values.has(ACCOUNTS.passwordItem)).toBe(true);
    expect(loadAccounts(files.accounts).providers.workday).toBeDefined();
    forgetAccounts("all", store, files);
    expect(store.values.size).toBe(0);
    expect(loadAccounts(files.accounts)).toMatchObject({ providers: {}, accounts: [] });
  });

  it("says in plain words what a rule allows before it is saved", () => {
    const all = describeConsent({ email: EMAIL, create: true, terms: true, verifyEmail: true, maxNew: 2 }, "every employer on Workday").join("\n");
    expect(all).toMatch(/EXPERIMENTAL\. Where you have no account, the tool makes one/);
    expect(all).toMatch(/At most 2 new accounts a day/);
    expect(all).toMatch(/agreeing to each employer's terms/);
    expect(all).toMatch(/never passes a robot check/);
    const least = describeConsent({ email: EMAIL, create: false, terms: false, verifyEmail: false }, "acme").join("\n");
    expect(least).toMatch(/nothing is made/);
    expect(least).not.toMatch(/EXPERIMENTAL/);
  });

  it("checks a password against the board's rules without showing it", () => {
    expect(passwordProblems(new Secret(PASSWORD))).toEqual([]);
    expect(passwordProblems(new Secret("short"))).toEqual(["at least 8 characters", "a digit", "an upper-case letter", "a special character"]);
    // The Keychain would hand these back in another form, which would then be typed as the password.
    expect(passwordProblems(new Secret("Fake-Pass-123! é"))[0]).toMatch(/plain keyboard/);
  });

  it("reads the same item from the environment on a machine with no Keychain", () => {
    expect(envNameOf(ACCOUNTS.passwordItem)).toBe("JEV_ACCOUNTS_PASSWORD");
    process.env.JEV_TEST_ITEM = "made-up-value";
    expect(new EnvStore().get("test-item")?.reveal()).toBe("made-up-value");
    delete process.env.JEV_TEST_ITEM;
    expect(new EnvStore().get("test-item")).toBeNull();
  });

  it("asks for the password in a window, twice, and stores nothing that misses a rule", () => {
    const script = (answers: (string | null)[]) => {
      const shown: string[] = [];
      return { shown, dialog: (message: string) => (shown.push(message), answers.shift() ?? null) };
    };
    const good = script([PASSWORD, PASSWORD]);
    const ok = askPassword(good.dialog);
    expect(ok.ok && ok.password.reveal()).toBe(PASSWORD);
    expect(JSON.stringify(ok)).not.toContain(PASSWORD);
    // No window ever shows what was typed.
    expect(good.shown.join(" ")).not.toContain(PASSWORD);
    expect(askPassword(script([null]).dialog)).toEqual({ ok: false, why: "cancelled" });
    expect(askPassword(script([PASSWORD, null]).dialog)).toEqual({ ok: false, why: "cancelled" });
    // A weak one is asked for again with the rule named, then a good one is taken.
    const retry = script(["weakpass", PASSWORD, PASSWORD]);
    expect(askPassword(retry.dialog).ok).toBe(true);
    expect(retry.shown[1]).toMatch(/That one needs a digit, an upper-case letter, a special character/);
    expect(askPassword(script(["weakpass", "weakpass", "weakpass"]).dialog)).toMatchObject({ ok: false, why: "rules" });
    const typo = script([PASSWORD, "Fake-Pass-124!", PASSWORD, "Fake-Pass-125!", PASSWORD, "x"]);
    expect(askPassword(typo.dialog)).toEqual({ ok: false, why: "mismatch" });
    expect(typo.shown[2]).toMatch(/did not match/);
  });

  it("gives the Keychain a value on standard input, never as an argument", () => {
    const calls: { args: string[]; input?: string }[] = [];
    let held = "";
    let takes = true;
    const kc = new KeychainStore((args, opts) => {
      calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
      // The stand-in keeps what the command line says, unquoted the way `security` reads it.
      if (args[0] === "-i" && takes) held = (/ -w "(.*)"\n$/s.exec(opts.input ?? "")?.[1] ?? "").replace(/\\(["\\])/g, "$1");
      return { status: 0, stdout: args[0] === "find-generic-password" ? `${held}\n` : "" };
    }, "jev-test");
    const made = 'tok"en\\1';
    kc.set("gmail-refresh-token", new Secret(made));
    expect(calls[0]?.args).toEqual(["-i"]);
    // No argument of any call holds the value, or a part of it.
    expect(calls.map((c) => c.args.join(" ")).join(" ")).not.toMatch(/tok"|en\\1/);
    expect(calls[0]?.input).toBe('add-generic-password -U -s "jev-test" -a "gmail-refresh-token" -w "tok\\"en\\\\1"\n');
    expect(kc.get("gmail-refresh-token")?.reveal()).toBe(made);
    expect(String(kc.get("gmail-refresh-token"))).toBe("[redacted]");
    // A value that would end the command line and start another is refused before anything runs.
    const before = calls.length;
    expect(() => kc.set("x", new Secret("line one\ndelete-keychain"))).toThrow(/cannot take/);
    expect(calls.length).toBe(before);
    // A store that says yes and keeps nothing is found out by reading the item back.
    takes = false;
    expect(() => kc.set("y", new Secret("another-made-up-value"))).toThrow(/did not take/);
  });
});
