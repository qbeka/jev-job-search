/**
 * The runner's tabs. One tab per job, remembered in data/runs/browser-session.json
 * so a later command (resolve, submit, check) finds the form that fill opened.
 * Also the few page helpers every step needs: install the in-page helpers, wait
 * for a page to settle, read the form, read values back, and take turns at the
 * front of the window.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BROWSER, PATHS } from "../config.js";
import { FieldsDump } from "../forms/fields.js";
import { closeTab, listTargets, Page, sleep } from "./cdp.js";
import { withStore, writeAtomic } from "../util/store.js";
import { scrub } from "../util/redact.js";

export const script = (name: string) => readFileSync(path.join(PATHS.browserScripts, name), "utf8");
const SESSION = path.join(PATHS.runs, "browser-session.json");

/** One open tab per job. `state` and `since` say why a tab is kept after a run: it waits for the person, or for a confirmation. */
export type SessionTab = { targetId: string; url: string; state?: "filling" | "awaiting_user_action" | "submission_unknown"; since?: string };
type Session = Record<string, SessionTab>;
export type Point = { x: number; y: number; ok: boolean; href?: string };
export type ControlState = "on" | "off" | "missing";

export const loadSession = (): Session => {
  try {
    return existsSync(SESSION) ? (JSON.parse(readFileSync(SESSION, "utf8")) as Session) : {};
  } catch {
    // A session file that cannot be read means no tab is known: forms are opened again.
    return {};
  }
};
export const saveSession = (s: Session) => writeAtomic(SESSION, JSON.stringify(s, null, 2));
/** Changes the session file: a fresh read, the change, a whole-file write, under the store lock. */
export const mutateSession = (fn: (s: Session) => void): void =>
  withStore(() => {
    const s = loadSession();
    fn(s);
    saveSession(s);
  });

/** Step timings on stderr when AWJ_TRACE is set. */
export const trace = (line: string) => {
  if (process.env.AWJ_TRACE) console.error(`[fill] ${scrub(line)}`);
};

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export async function install(page: Page): Promise<void> {
  await page.evaluate(script("pageHelpers.js"));
}

/**
 * What a page's form looks like at a glance: how many controls it has, and a short sum of the words
 * on its labels and options. Two reads that agree mean the form has stopped changing.
 * "interactive" is enough: a tracker or a font that never finishes loading must not hold the form up.
 */
export const SETTLE_EXPR = `(() => {
  if (document.readyState === "loading") return "-1";
  const n = document.querySelectorAll("input, select, textarea, [role=combobox]").length;
  let h = 0;
  for (const el of document.querySelectorAll("label, legend, option, [role=option]")) {
    const t = el.textContent || "";
    for (let i = 0; i < t.length && i < 80; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  }
  return n + ":" + h;
})()`;

/** The next step of the wait, from the last two reads. Pure, so it is tested without a browser. */
export function settleStep(prev: { sig: string; stable: number; countStable: number }, sig: string): { sig: string; stable: number; countStable: number } {
  const count = (s: string) => s.split(":")[0];
  const ok = sig !== "-1";
  return { sig, stable: ok && sig === prev.sig ? prev.stable + 1 : 0, countStable: ok && count(sig) === count(prev.sig) ? prev.countStable + 1 : 0 };
}

/**
 * Waits until the document is loaded and its form stops changing: the same controls, the same
 * labels and options, three reads in a row. A page with no controls yet gets longer, since
 * single-page forms render late. A page whose words keep ticking (a clock, a counter) is taken as
 * settled once its controls have held still for a while.
 */
export async function settle(page: Page): Promise<void> {
  const started = Date.now();
  let state = { sig: "", stable: 0, countStable: 0 };
  while (Date.now() - started < BROWSER.settleMs) {
    await sleep(BROWSER.pollMs);
    let sig = "-1";
    try {
      sig = await page.evaluate<string>(SETTLE_EXPR);
    } catch {
      sig = "-1"; // mid-navigation
    }
    state = settleStep(state, sig);
    const n = Number(sig.split(":")[0]);
    const enough = n >= 3 || Date.now() - started > BROWSER.emptyPageMs;
    if (state.stable >= 3 && enough) break;
    if (state.countStable >= BROWSER.settleCountPolls && enough) break;
  }
  trace(`settled in ${Date.now() - started}ms at ${state.sig}`);
}

export async function dump(page: Page): Promise<FieldsDump> {
  return FieldsDump.parse(JSON.parse(await page.evaluate<string>(script("dumpFields.js"))));
}

export async function goto(page: Page, url: string): Promise<void> {
  await page.navigate(url);
  await settle(page);
  await install(page);
}

/** Clicks and typing need the tab in front, so tabs filled side by side take turns for them. */
let turn: Promise<unknown> = Promise.resolve();
export function inFront<T>(page: Page, work: () => Promise<T>): Promise<T> {
  return inTurn(async () => {
    await page.bringToFront();
    return work();
  });
}

/**
 * Anything that changes which tab is in front takes the same turns: opening a tab, closing one.
 * A tab that opens while another is being typed into takes the window from it, and a box that
 * loses the window in the middle of typing can throw the text away.
 */
export function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work);
  turn = run.catch(() => undefined);
  return run;
}

export function controlStates(page: Page, selectors: string[]): Promise<ControlState[]> {
  return page.call<ControlState[]>("(selectors) => selectors.map((s) => window.__awj.state(s))", selectors);
}

export function shownValues(page: Page, selectors: string[]): Promise<string[]> {
  return page.call<string[]>('(selectors) => selectors.map((s) => { try { return window.__awj.shown(s); } catch { return ""; } })', selectors);
}

export async function pageFor(jobId: string): Promise<Page> {
  const s = loadSession()[jobId];
  const targets = (await listTargets()) ?? [];
  const t = s ? targets.find((x) => x.id === s.targetId) : undefined;
  if (!t) throw new Error(`No open tab for job ${jobId}. Run fill first.`);
  const page = await Page.attach(t);
  await install(page);
  return page;
}

/** True when the job still has a tab open in the runner's window. */
export async function hasOpenTab(jobId: string): Promise<boolean> {
  const s = loadSession()[jobId];
  return !!s && ((await listTargets()) ?? []).some((t) => t.id === s.targetId);
}

export async function closeJobTab(jobId: string): Promise<void> {
  const s = loadSession()[jobId];
  if (s) await inTurn(() => closeTab(s.targetId));
  mutateSession((session) => {
    delete session[jobId];
  });
}
