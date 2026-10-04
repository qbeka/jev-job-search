/**
 * A small web server that behaves like one Workday employer's apply page, for driving the real
 * sign-in code through a real browser on this machine. The page uses the control names the live
 * pages use. Accounts live in memory and every credential is made up.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockBoard = {
  origin: string;
  applyUrl: string;
  /** A second origin on the same server (localhost against 127.0.0.1), to prove a hop off-site is stopped. */
  elsewhere: string;
  accounts: Map<string, { password: string; verified: boolean }>;
  verifies: boolean;
  /** Requests the other origin received. */
  strayed: string[];
  close: () => Promise<void>;
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title>
<style>body{font:14px sans-serif;margin:24px} .btn{position:relative;display:inline-block} [data-automation-id=click_filter]{position:absolute;inset:0;cursor:pointer} label{display:block;margin-top:8px}</style></head>
<body>
<div data-automation-id="header"><div data-automation-id="utilityButtonBar" id="bar"></div></div>
<div data-automation-id="applyFlowPage"><ol data-automation-id="progressBar"><li>step 1 of 3</li><li>step 2 of 3</li><li>step 3 of 3</li></ol><div id="main"></div></div>
<script>
const $ = (s) => document.querySelector(s);
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const button = (id, words) => '<span class="btn"><div data-automation-id="click_filter" role="button" aria-label="' + words + '" id="go"></div><button data-automation-id="' + id + '" type="submit" tabindex="-2" aria-hidden="true">' + words + '</button></span>';
const fail = (words) => { $("#err").innerHTML = '<div data-automation-id="errorMessage" role="alert">' + words + '</div>'; };
function register() {
  document.title = "Create Account";
  $("#bar").innerHTML = '<button data-automation-id="utilityButtonSignIn">Sign In</button>';
  $("#main").innerHTML = '<div data-automation-id="signInContent"><h2>Create Account</h2><div id="err"></div><form data-automation-id="signInFormo" onsubmit="return false">'
    + '<label for="input-4">Email Address*</label><input data-automation-id="email" id="input-4" type="text" autocomplete="email">'
    + '<label for="input-5">Password*</label><input data-automation-id="password" id="input-5" type="password" autocomplete="new-password">'
    + '<label for="input-6">Verify New Password*</label><input data-automation-id="verifyPassword" id="input-6" type="password" autocomplete="new-password">'
    + '<label for="input-9"><input data-automation-id="createAccountCheckbox" id="input-9" type="checkbox"> Yes, I have read and consent to the terms and conditions</label>'
    + '<label for="news"><input id="news" type="checkbox"> Send me news about jobs</label>'
    + button("createAccountSubmitButton", "Create Account") + '</form>'
    + '<p>Already have an account? <button data-automation-id="signInLink">Sign In</button></p></div>';
  $("[data-automation-id=signInLink]").onclick = signIn;
  $("#go").onclick = async () => {
    const r = await post("/api/register", { email: $("#input-4").value, password: $("#input-5").value, again: $("#input-6").value, terms: $("#input-9").checked, news: $("#news").checked });
    if (r.error) return fail(r.error);
    if (r.verify) return notice();
    application(r.email);
  };
}
function signIn() {
  document.title = "Sign In";
  $("#bar").innerHTML = '<button data-automation-id="utilityButtonSignIn">Sign In</button>';
  $("#main").innerHTML = '<div data-automation-id="signInContent"><h2>Sign In</h2><div id="err"></div><form data-automation-id="signInFormo" onsubmit="return false">'
    + '<label for="input-14">Email Address*</label><input data-automation-id="email" id="input-14" type="text" autocomplete="email">'
    + '<label for="input-15">Password*</label><input data-automation-id="password" id="input-15" type="password" autocomplete="current-password">'
    + button("signInSubmitButton", "Sign In") + '</form>'
    + '<p>Don\\'t have an account yet? <button data-automation-id="createAccountLink">Create Account</button></p></div>';
  $("[data-automation-id=createAccountLink]").onclick = register;
  $("#go").onclick = async () => {
    const r = await post("/api/signin", { email: $("#input-14").value, password: $("#input-15").value });
    if (r.error) return fail(r.error);
    application(r.email);
  };
}
function notice() {
  $("#main").innerHTML = '<div data-automation-id="signInContent"><h2>Verify your account</h2><p>An email was sent to you. Click the link in it to activate your account.</p><button data-automation-id="signInLink">Sign In</button></div>';
  $("[data-automation-id=signInLink]").onclick = signIn;
}
function application(email) {
  document.title = "My Information";
  $("#bar").innerHTML = '<button data-automation-id="accountMenu">' + email + '</button>';
  $("#main").innerHTML = '<h2>My Information</h2><form onsubmit="return false">'
    + '<div data-automation-id="formField-legalNameSection_firstName"><label for="input-21">First Name*</label><input data-automation-id="legalNameSection_firstName" id="input-21" type="text" required></div>'
    + '<div data-automation-id="formField-legalNameSection_lastName"><label for="input-22">Last Name*</label><input data-automation-id="legalNameSection_lastName" id="input-22" type="text" required></div>'
    + '<div data-automation-id="formField-code"><label for="otp">Security code</label><input id="otp" type="text" autocomplete="one-time-code"></div>'
    + '<button data-automation-id="pageFooterNextButton">Save and Continue</button></form>';
}
fetch("/api/me").then((r) => r.json()).then((me) => (me.email ? application(me.email) : register()));
</script></body></html>`;

export async function startMockBoard(opts: { verifies?: boolean } = {}): Promise<MockBoard> {
  const accounts: MockBoard["accounts"] = new Map();
  const strayed: string[] = [];
  let server: Server;
  const board: MockBoard = { origin: "", applyUrl: "", elsewhere: "", accounts, verifies: !!opts.verifies, strayed, close: () => new Promise<void>((r) => server.close(() => r())) };
  const sessions = new Map<string, string>();
  server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const json = (body: unknown, headers: Record<string, string> = {}) => res.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    if (host.startsWith("localhost")) {
      strayed.push(url.pathname);
      return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Somewhere else</h1>");
    }
    const sid = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    if (req.method === "GET" && url.pathname === "/api/me") return json({ email: sessions.get(sid) ?? null });
    if (req.method === "GET" && url.pathname.startsWith("/Careers/activate/")) {
      const token = url.pathname.split("/").pop() ?? "";
      if (token === "hop") return res.writeHead(302, { location: `${board.elsewhere}/landed` }).end();
      for (const [email, a] of accounts) if (token === Buffer.from(email).toString("hex")) a.verified = true;
      return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Your account is verified</h1>");
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const b = JSON.parse(raw || "{}") as { email?: string; password?: string; again?: string; terms?: boolean; news?: boolean };
        const email = b.email ?? "";
        const signedIn = () => {
          const id = Math.random().toString(36).slice(2);
          sessions.set(id, email);
          return { "set-cookie": `sid=${id}; Path=/; HttpOnly` };
        };
        if (url.pathname === "/api/register") {
          if (accounts.has(email)) return json({ error: "An account already exists for this email address." });
          if (b.password !== b.again) return json({ error: "The passwords do not match." });
          if (!b.terms) return json({ error: "You must agree to the terms and conditions." });
          if (b.news) return json({ error: "The test expects the news box to stay unticked." });
          accounts.set(email, { password: b.password ?? "", verified: !board.verifies });
          return board.verifies ? json({ verify: true }) : json({ email }, signedIn());
        }
        const a = accounts.get(email);
        if (!a || a.password !== b.password) return json({ error: "ERROR: Invalid Username/Password" });
        if (!a.verified) return json({ error: "Your account has not been verified. Check your email for the verification link." });
        return json({ email }, signedIn());
      });
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/apply/applyManually")) return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  board.origin = `http://127.0.0.1:${port}`;
  board.elsewhere = `http://localhost:${port}`;
  board.applyUrl = `${board.origin}/Careers/job/Toronto/Software-Intern_R1/apply/applyManually`;
  return board;
}
