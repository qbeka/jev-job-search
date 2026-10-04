/**
 * The sign-in's view of a real tab. Every read and every click is a fixed function with the
 * adapter's selectors as arguments: nothing from a page becomes code, and a password's value never
 * comes back out of the page.
 */
import type { Page } from "../browser/cdp.js";
import { sleep } from "../browser/cdp.js";
import { goto, inFront, type Point } from "../browser/session.js";
import type { Secret } from "../util/redact.js";
import type { AuthPage, AuthSnapshot } from "./provider.js";

const READ = `function (controls, words) {
  const vis = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const said = (el) => (el ? (el.innerText || "").replace(/\\s+/g, " ").trim() : "");
  const all = (s) => { try { return s ? [...document.querySelectorAll(s)] : []; } catch { return []; } };
  const present = {};
  for (const [name, s] of Object.entries(controls)) present[name] = all(s).some(vis);
  const panel = all(words.panel).find(vis);
  return {
    present,
    text: said(panel || document.body).slice(0, 2000),
    errors: all(words.errors).filter(vis).map(said).filter(Boolean).map((t) => t.slice(0, 300)).filter((t, i, a) => a.indexOf(t) === i).slice(0, 8),
    header: said(all(words.header).find(vis)).slice(0, 300),
  };
}`;

const POINT = `function (selector) {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  let el = null;
  try { el = [...document.querySelectorAll(selector)].find(vis) || null; } catch { el = null; }
  if (!el) return { x: 0, y: 0, ok: false };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: true };
}`;

const POINT_BY_TEXT = `function (scope, pattern) {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const re = new RegExp(pattern, "i");
  let root = null;
  try { root = scope ? [...document.querySelectorAll(scope)].find(vis) : null; } catch { root = null; }
  const hits = [...(root || document).querySelectorAll("button, a, [role=button]")].filter((b) => vis(b) && re.test((b.innerText || b.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim()));
  if (hits.length !== 1) return { x: 0, y: 0, ok: false };
  hits[0].scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = hits[0].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: true };
}`;

const FOCUS = `function (selector) {
  let el = null;
  try { el = document.querySelector(selector); } catch { el = null; }
  if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return { ok: false, filled: false };
  el.focus();
  if (typeof el.select === "function") el.select();
  return { ok: document.activeElement === el, filled: el.value.length > 0 };
}`;

const HOLDS = `function (selector) {
  let el = null;
  try { el = document.querySelector(selector); } catch { el = null; }
  if (!el) return null;
  const password = el.type === "password";
  const value = typeof el.value === "string" ? el.value : "";
  return { value: password ? null : value, length: value.length, checked: !!el.checked, password };
}`;

const AUTOFILLED = `function (selector) {
  let el = null;
  try { el = document.querySelector(selector); } catch { el = null; }
  if (!el) return false;
  for (const mark of [":autofill", ":-webkit-autofill"]) { try { if (el.matches(mark)) return true; } catch { /* a browser that does not know the mark */ } }
  return false;
}`;

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

export function cdpAuthPage(page: Page): AuthPage {
  const clickAt = async (p: Point): Promise<boolean> => {
    if (!p.ok) return false;
    await inFront(page, () => page.click(p.x, p.y));
    return true;
  };
  return {
    url: async () => (await page.mainFrame()).url,
    read: async (controls, words) => ({ url: (await page.mainFrame()).url, ...(await page.call<Omit<AuthSnapshot, "url">>(READ, controls, words)) }),
    click: async (selector) => clickAt(await page.call<Point>(POINT, selector)),
    clickByText: async (scope, pattern) => clickAt(await page.call<Point>(POINT_BY_TEXT, scope, pattern)),
    focus: (selector) =>
      inFront(page, async () => {
        const p = await page.call<Point>(POINT, selector);
        if (p.ok) await page.click(p.x, p.y);
        const f = await page.call<{ ok: boolean; filled: boolean }>(FOCUS, selector);
        // What the box held is selected, so one key empties it the way a person would.
        if (f.ok && f.filled) await page.key("Backspace");
        return f.ok;
      }),
    type: (text) => inFront(page, () => page.type(text)),
    typeSecret: (secret: Secret) => inFront(page, () => page.type(secret.reveal())),
    holds: (selector) => page.call(HOLDS, selector),
    autofilled: (selector) => page.call<boolean>(AUTOFILLED, selector),
    navigate: (url) => goto(page, url),
    wait: (ms) => sleep(ms),
    async follow(url, allowedOrigins) {
      if (!allowedOrigins.includes(originOf(url))) return { ok: false, why: "it is not on the employer's own site" };
      const main = await page.mainFrame();
      let refused = "";
      // Every load of the tab's own page is held to the allowed origins: a link that hops elsewhere is stopped at the hop.
      const off = page.on("Fetch.requestPaused", (p) => {
        const requestId = String(p.requestId);
        const to = String((p.request as { url?: string } | undefined)?.url ?? "");
        const ok = p.frameId !== main.id || allowedOrigins.includes(originOf(to));
        if (!ok) refused = originOf(to) || "another site";
        void page.send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      });
      try {
        await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document" }] });
        await goto(page, url).catch(() => undefined);
      } finally {
        off();
        await page.send("Fetch.disable").catch(() => undefined);
      }
      if (refused) return { ok: false, why: `it led to ${refused}` };
      return allowedOrigins.includes(originOf((await page.mainFrame()).url)) ? { ok: true } : { ok: false, why: "it ended on another site" };
    },
  };
}
