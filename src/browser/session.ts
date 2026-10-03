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
  if (process.env.AWJ_TRACE) console.error(`[fill] ${line}`);
};

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export async function install(page: Page): Promise<void> {
  await page.evaluate(script("pageHelpers.js"));
}

/** Waits until the document is loaded and its form controls stop changing. A page with no controls yet gets longer: single-page forms render late. */
export async function settle(page: Page): Promise<void> {
  const started = Date.now();
  let last = -2;
  let stable = 0;
  while (Date.now() - started < BROWSER.settleMs) {
    await sleep(BROWSER.pollMs);
    let n = -1;
    try {
      // "interactive" is enough: a tracker or a font that never finishes loading must not hold the form up.
      n = await page.evaluate<number>("document.readyState !== 'loading' ? document.querySelectorAll('input, select, textarea').length : -1");
    } catch {
      n = -1; // mid-navigation
    }
    stable = n >= 0 && n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 3 && (n >= 3 || Date.now() - started > BROWSER.emptyPageMs)) break;
  }
  trace(`settled in ${Date.now() - started}ms with ${last} controls`);
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
