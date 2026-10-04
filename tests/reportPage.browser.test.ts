/**
 * The dashboard page in a real Chrome, against a stand-in server with made-up records. It proves
 * the page draws its four screens, sends an answer with the token it was given, and offers
 * "remember" only for a question that may be kept. Skipped where Chrome is not installed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, sleep, type Target } from "../src/browser/cdp.js";
import { BROWSER, childEnv, DAILY } from "../src/config.js";
import { buildReport } from "../src/report/data.js";
import type { Needs } from "../src/report/needs.js";
import { reportPage } from "../src/report/page.js";
import { Policy } from "../src/run/policy.js";

const TOKEN = "made-up-token-for-the-test";
const needs: Needs = {
  waiting: [{ id: "w1", company: "Globex", title: "Software Intern", todo: "type the code the board emailed you, then click Submit", reason: "the board emailed you a code", mail: "https://mail.google.com/mail/u/0/#search/greenhouse", open: true }],
  questions: [
    {
      id: "q1",
      company: "Acme",
      title: "Backend Intern",
      link: "https://jobs.example.com/acme/1",
      reason: "empty: Which team interests you most?",
      items: [
        { question: "Which team interests you most?", kind: "ask", options: ["Payments", "Platform"], canRemember: true, note: "" },
        { question: "Are you legally authorized to work in the United States?", kind: "profile", options: [], canRemember: false, note: "Your profile does not say this for the job's country." },
      ],
    },
  ],
  unconfirmed: [{ id: "u1", company: "Initech", title: "New Grad Engineer", link: "https://jobs.example.com/initech/2" }],
  mail: [{ id: "m1", from: "Hooli Careers", subject: "An update on your application", on: "2026-10-03", kind: null, why: "the tool could not tell what it says", jobs: [{ id: "h1", company: "Hooli", title: "SWE Intern" }] }],
};
const automation = { policy: null, policyError: "", defaults: Policy.parse({}), limits: { maxTarget: DAILY.maxTarget, perBoard: DAILY.perBoard, perEmployerPerDay: DAILY.perEmployerPerDay, gapMinutes: [3, 6], maxMinutes: DAILY.maxMinutes }, schedule: { on: false, at: "09:00", next: null }, timezone: "America/Vancouver", today: [] };

describe.skipIf(!existsSync(BROWSER.chromePath))("the dashboard page in a real browser", () => {
  let chrome: ChildProcess;
  let server: Server;
  let origin = "";
  let port = 0;
  let profile = "";
  const posts: { path: string; token: string; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (body: string, type = "application/json") => res.writeHead(200, { "content-type": type }).end(body);
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          posts.push({ path: req.url ?? "", token: String(req.headers["x-jev-token"] ?? ""), body: JSON.parse(raw) });
          send(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.url === "/") return send(reportPage(null, TOKEN), "text/html; charset=utf-8");
      if (req.url === "/api/data") return send(JSON.stringify({ ...buildReport([]), run: null }));
      if (req.url === "/api/needs") return send(JSON.stringify(needs));
      if (req.url === "/api/automation") return send(JSON.stringify(automation));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    port = await new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
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
    await new Promise<void>((r) => server.close(() => r()));
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });

  it("draws its screens, and sends an answer with the token and only what was typed", async () => {
    const tab = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(tab);
    const errors: string[] = [];
    page.on("Runtime.exceptionThrown", (p) => void errors.push(JSON.stringify(p).slice(0, 300)));
    await page.navigate(origin);
    for (let i = 0; i < 40 && !(await page.evaluate<boolean>("!!document.querySelector('#nav button')").catch(() => false)); i++) await sleep(150);
    expect(errors).toEqual([]);
    const nav = await page.evaluate<string[]>("[...document.querySelectorAll('#nav button')].map((b) => b.textContent)");
    expect(nav).toEqual(["Today", "Needs you (4)", "Applications", "Automation"]);

    await page.evaluate("document.querySelector('[data-screen=needs]').click()");
    const text = await page.evaluate<string>("document.querySelector('#s-needs').innerText");
    expect(text).toMatch(/Acme needs 2 answers/);
    expect(text).toMatch(/Globex: type the code the board emailed you/);
    expect(text).toMatch(/Initech/);
    expect(text).toMatch(/An update on your application/);
    // The work-authorization question has no answer box and no "remember": it is the profile's.
    expect(await page.evaluate<number>("document.querySelectorAll('[data-job=q1] [data-q]').length")).toBe(1);
    expect(await page.evaluate<number>("document.querySelectorAll('[data-job=q1] [data-keep]').length")).toBe(1);

    await page.evaluate("(() => { const s = document.querySelector('[data-job=q1] select[data-q]'); s.value = 'Platform'; document.querySelector('[data-job=q1] [data-keep]').checked = true; document.querySelector('[data-answer=q1]').click(); })()");
    for (let i = 0; i < 30 && !posts.length; i++) await sleep(100);
    expect(posts[0]).toEqual({ path: "/api/answer", token: TOKEN, body: { id: "q1", answers: [{ question: "Which team interests you most?", answer: "Platform", remember: true }] } });

    await page.evaluate("document.querySelector('[data-screen=auto]').click()");
    const auto = await page.evaluate<string>("document.querySelector('#s-auto').innerText");
    expect(auto).toMatch(/Apply automatically/);
    expect(auto).toMatch(/Save your daily rules below first/);
    expect(auto).toMatch(/Your Mac has to be on/);
    // The switch cannot be turned on before there are rules.
    expect(await page.evaluate<boolean>("document.querySelector('#autoOn').disabled")).toBe(true);
    await page.evaluate("(() => { document.querySelector('#pTarget').value = '7'; document.querySelector('#pExclude').value = 'Acme, Globex'; document.querySelector('#pSave').click(); })()");
    for (let i = 0; i < 30 && posts.length < 2; i++) await sleep(100);
    expect(posts[1]).toMatchObject({ path: "/api/policy", token: TOKEN, body: { target: 7, excludeEmployers: ["Acme", "Globex"], where: [], documents: { tailor: false, cover: false } } });
    expect(Policy.safeParse(posts[1]?.body).success).toBe(true);
    expect(errors).toEqual([]);
    page.close();
  }, 60_000);
});
