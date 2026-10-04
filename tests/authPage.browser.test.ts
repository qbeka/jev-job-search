/**
 * The sign-in, driven through a real Chrome against a mock Workday on this machine. It proves the
 * part the scripted tests cannot: real clicks land on the button under Workday's overlay, a real
 * password box takes the password and gives nothing back, and a verification link that hops to
 * another site is stopped at the hop. Skipped where Chrome is not installed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSignedIn, type AuthContext } from "../src/accounts/auth.js";
import { cdpAuthPage } from "../src/accounts/authPage.js";
import { setRule } from "../src/accounts/commands.js";
import { loadAccounts } from "../src/accounts/config.js";
import type { Adapter, AuthPage, Verifier } from "../src/accounts/provider.js";
import { itemFor, MemoryStore } from "../src/accounts/secrets.js";
import { workday } from "../src/accounts/workday.js";
import { Page, sleep, type Target } from "../src/browser/cdp.js";
import { dump, goto, install } from "../src/browser/session.js";
import { ACCOUNTS, BROWSER, childEnv } from "../src/config.js";
import { startMockBoard, type MockBoard } from "./helpers/workdayMock.js";

// Made up for the test, and sent only to a server on this machine.
const EMAIL = "candidate@example.com";
const PASSWORD = "Fake-Pass-123!";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!existsSync(BROWSER.chromePath))("the sign-in in a real browser", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";
  const boards: MockBoard[] = [];

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-chrome-"));
    chrome = spawn(BROWSER.chromePath, ["--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore", env: childEnv() });
    for (let i = 0; i < 80; i++) {
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) return;
      await sleep(250);
    }
    throw new Error("headless Chrome did not start");
  }, 30_000);

  afterAll(async () => {
    chrome?.kill();
    await Promise.all(boards.map((b) => b.close()));
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });

  /** A fresh, private tab on a fresh mock board, with the adapter pointed at that board. */
  async function open(opts: { verifies?: boolean } = {}) {
    const board = await startMockBoard(opts);
    boards.push(board);
    const context = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(context);
    await page.send("Network.clearBrowserCookies");
    const dir = mkdtempSync(path.join(tmpdir(), "jev-auth-"));
    const files = { accounts: path.join(dir, "accounts.json"), state: path.join(dir, "state.json") };
    setRule("workday", { email: EMAIL, create: true, terms: true, verifyEmail: true }, files);
    const store = new MemoryStore();
    store.values.set(ACCOUNTS.passwordItem, PASSWORD);
    const adapter: Adapter = { ...workday, tenantOf: (url) => (url.startsWith(board.origin) ? { tenant: "acme", origin: board.origin } : null) };
    // The real page, with its pauses shortened: the mock answers at once.
    const auth: AuthPage = { ...cdpAuthPage(page), wait: () => sleep(120) };
    const ctx = (verifier: Verifier | null = null): AuthContext => ({ adapter, tenant: { tenant: "acme", origin: board.origin }, applicationUrl: board.applyUrl, secrets: store, verifier, files });
    await goto(page, board.applyUrl);
    return { board, page, auth, ctx, files, store };
  }

  it("makes an account with real clicks and keys, and lands in the application", async () => {
    const opened = await open();
    const { board, page, auth, ctx, files } = opened;
    const r = await ensureSignedIn(auth, ctx());
    expect(r.ok && r.created).toBe(true);
    // The board holds exactly what was typed, the terms were ticked, and the news box was left alone.
    const own = opened.store.values.get(itemFor("workday:acme")) ?? "";
    expect(own).toHaveLength(ACCOUNTS.generatedLength);
    expect(board.accounts.get(EMAIL)).toEqual({ password: own, verified: true });
    expect(loadAccounts(files.accounts).accounts[0]).toMatchObject({ id: "workday:acme", allowedOrigins: [board.origin] });
    // The application's fields are read by Workday's own names, and a one-time-code box is never read.
    const d = await dump(page);
    expect(d.fields.map((f) => f.label)).toEqual(["First Name", "Last Name"]);
    expect(d.fields.map((f) => f.selector).join(" ")).not.toMatch(/otp/);
    expect(d.hasPassword).toBe(false);
    page.close();
  }, 60_000);

  it("puts its helpers back when the page loads again under it", async () => {
    const { page } = await open();
    await install(page);
    expect(await page.awj<string>("pageText")).toMatch(/Create Account/);
    // The site loads its page a second time, as Workday does once it knows who is signed in.
    await page.evaluate("location.reload()");
    for (let i = 0; i < 40 && (await page.evaluate<string>("document.readyState").catch(() => "")) !== "complete"; i++) await sleep(100);
    expect(await page.awj<string>("pageText")).toMatch(/Create Account/);
    expect((await dump(page)).hasPassword).toBe(true);
    page.close();
  }, 60_000);

  it("signs in to the same account from a clean window, and a password box gives nothing back", async () => {
    const { board, page, auth, ctx } = await open();
    board.accounts.set(EMAIL, { password: PASSWORD, verified: true });
    const first = await auth.read(workday.controls, workday.words);
    expect(workday.view(first)).toBe("register");
    await auth.focus(workday.controls.password);
    await auth.type("visible-while-typed");
    expect(await auth.holds(workday.controls.password)).toEqual({ value: null, length: 19, checked: false, password: true });
    const r = await ensureSignedIn(auth, ctx());
    // The sign-up said the account exists, so it was signed in to, once.
    expect(r.ok && !r.created).toBe(true);
    expect(workday.identity(await auth.read(workday.controls, workday.words))).toBe(EMAIL);
    page.close();
  }, 60_000);

  it("refuses a wrong password once and does nothing more", async () => {
    const { board, page, auth, ctx } = await open();
    board.accounts.set(EMAIL, { password: "Another-Pass-9!", verified: true });
    const r = await ensureSignedIn(auth, ctx());
    expect(r).toMatchObject({ ok: false, status: "awaiting_user_action", waitingFor: "login" });
    expect(board.accounts.get(EMAIL)?.password).toBe("Another-Pass-9!");
    page.close();
  }, 60_000);

  it("follows the board's own verification link, and stops one that hops to another site", async () => {
    const { board, page, auth, ctx } = await open({ verifies: true });
    const token = Buffer.from(EMAIL).toString("hex");
    const used: string[] = [];
    const verifier: Verifier = { find: async () => ({ ok: true, messageId: "m1", link: `${board.origin}/Careers/activate/${token}`, code: null }), consume: (id) => void used.push(id) };
    const r = await ensureSignedIn(auth, ctx(verifier));
    expect(r.ok && r.created).toBe(true);
    expect(board.accounts.get(EMAIL)?.verified).toBe(true);
    expect(used).toEqual(["m1"]);

    const hop = await auth.follow(`${board.origin}/Careers/activate/hop`, [board.origin]);
    expect(await auth.follow(`${board.elsewhere}/Careers/activate/x`, [board.origin])).toMatchObject({ ok: false });
    expect(hop.ok).toBe(false);
    expect(hop.why).toMatch(/localhost/);
    expect(board.strayed).toEqual([]);
    page.close();
  }, 60_000);
});
