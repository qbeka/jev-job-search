/**
 * Dropdowns. A component that keeps its options on its own props (react-select,
 * Ashby's search boxes) is read and set through them, which is instant. Anything
 * else is opened with a real click, searched by typing, and picked by clicking.
 */
import { BROWSER, FORM } from "../config.js";
import type { DumpedField } from "../forms/fields.js";
import { sleep, type Page } from "./cdp.js";
import { inFront, norm, shownValues, trace, type Point } from "./session.js";
import { CHOICE_PATH, showsValue } from "../util/dates.js";

/** Polls an open dropdown until its options settle, or until `enough` says the wanted one has arrived. */
async function waitOptions(page: Page, selector: string, typed: boolean, enough?: (opts: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + (typed ? BROWSER.optionsMs : BROWSER.optionsMs / 4);
  const clean = (opts: string[]) => opts.filter((o) => !/^(loading|searching|no options|no results|type to search)/i.test(o));
  let last = "";
  let stable = 0;
  let opts: string[] = [];
  while (Date.now() < deadline) {
    await sleep(BROWSER.pollMs);
    opts = clean(await page.awj<string[]>("options", selector));
    if (enough) {
      if (enough(opts)) break;
      continue;
    }
    const sig = opts.join("|");
    stable = opts.length > 0 && sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= 1) break;
  }
  return opts;
}

/**
 * Picks the option that matches the wanted value. Among several matches, the one that names the
 * candidate's own city, region or country wins. A location like "Edmonton, Alberta, Canada" also
 * matches "Edmonton, AB, Canada": same first part, and at least one of the candidate's places named.
 * Returns null rather than something merely similar.
 */
export function pickOption(options: string[], value: string, hints: string[]): string | null {
  const want = norm(value);
  if (!want) return null;
  const word = (h: string) => new RegExp(`(^|[^a-z0-9])${norm(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  const score = (o: string) => hints.filter((h) => h && word(h).test(norm(o))).length;
  const best = (pool: string[]) => [...pool].sort((a, b) => score(b) - score(a) || a.length - b.length)[0] ?? null;
  const exact = options.filter((o) => norm(o) === want);
  const starts = options.filter((o) => norm(o).startsWith(want));
  const includes = options.filter((o) => norm(o).includes(want));
  const pool = exact.length ? exact : starts.length ? starts : includes;
  // A short value ("+1") sits inside many options. With nothing of the candidate's to tell them apart, none of them is picked.
  if (!exact.length && !starts.length && want.length <= FORM.shortAnswerChars && includes.length > 1 && score(best(includes) ?? "") === 0) return null;
  if (pool.length) return best(pool);
  const head = norm(value.split(",")[0] ?? "");
  if (!head || head === want) return null;
  // The city alone proves nothing (there is an Edmonton in Kentucky): a region or country of the candidate's must be named too.
  const beyondHead = hints.filter((h) => h && norm(h) !== head);
  const sameHead = options.filter((o) => norm(o.split(",")[0] ?? "") === head && beyondHead.some((h) => word(h).test(norm(o))));
  return best(sameHead);
}

async function openDropdown(page: Page, selector: string): Promise<boolean> {
  const p = await page.awj<Point>("point", selector);
  if (!p.ok) return false;
  await page.click(p.x, p.y);
  return true;
}

/**
 * Where an option is, once it has stopped moving: a long list scrolls to the option, and a list drawn
 * beside its box follows the box a moment later. A click on a point read too early lands on another row.
 */
async function steadyPoint(page: Page, selector: string, label: string): Promise<Point> {
  let last = await page.awj<Point>("optionPoint", selector, label);
  for (let read = 0; read < FORM.steadyReads; read++) {
    // The pointer goes there first. A list that follows the pointer (Workday's) moves under it, and the click waits for that.
    if (last.ok) await page.hover(last.x, last.y);
    await sleep(BROWSER.pollMs);
    const now = await page.awj<Point>("optionPoint", selector, label);
    if (now.ok && last.ok && Math.abs(now.x - last.x) < 1 && Math.abs(now.y - last.y) < 1) return now;
    last = now;
  }
  return { ...last, ok: false };
}

/** A control a form has put out of sight while it saves (Workday hides the page for a moment) is waited for, a little. */
async function whenOn(page: Page, selector: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const state = await page.awj<string>("state", selector).catch(() => "missing");
    if (state === "on" || Date.now() - started > (state === "off" ? BROWSER.optionsMs : BROWSER.optionsMs / 4)) return;
    await sleep(BROWSER.pollMs);
  }
}

/** The rest of a list that only draws the rows in view: it is moved down a screen at a time until `enough`, or its end. */
async function restOfList(page: Page, selector: string, seen: string[], enough: (opts: string[]) => boolean): Promise<string[]> {
  const all = [...seen];
  for (let screen = 0; screen < FORM.maxListScreens && !enough(all); screen++) {
    if (!(await page.awj<boolean>("scrollOptions", selector))) break;
    await sleep(BROWSER.pollMs);
    for (const o of await page.awj<string[]>("options", selector)) if (!all.includes(o)) all.push(o);
  }
  return all;
}

/** With the trace on, the shape of a control whose list did not give the wanted value, taken while the list is still open. */
async function sketch(page: Page, selector: string): Promise<void> {
  if (process.env.AWJ_TRACE) trace(`  ${selector}: ${await page.awj<string>("sketch", selector).catch(() => "no sketch")}`);
}

async function closeDropdown(page: Page): Promise<void> {
  await page.key("Escape");
  await page.evaluate("window.__awj.blur()");
}

/** Reads the options of one dropdown that only renders them once opened. */
export async function readOptions(page: Page, selector: string): Promise<string[]> {
  const react = () => page.awj<string[] | null>("reactOptions", selector);
  const opts = await react();
  if (opts?.length) return opts;
  if (opts !== null) {
    // A react-select with a lazy list: ask its own loader, or open it through its handler and watch.
    const viaLoader = await page.awj<string[] | null>("reactLoad", selector, "").catch(() => null);
    if (viaLoader?.length) return viaLoader;
    if (!(await page.awj<boolean>("reactMenu", selector, true))) return [];
    const deadline = Date.now() + BROWSER.optionsMs / 2;
    let loaded: string[] = [];
    while (!loaded.length && Date.now() < deadline) {
      await sleep(BROWSER.pollMs);
      loaded = (await react()) ?? [];
    }
    await page.awj("reactMenu", selector, false);
    return loaded;
  }
  return inFront(page, async () => {
    if (!(await openDropdown(page, selector))) return [];
    const seen = await waitOptions(page, selector, false);
    await closeDropdown(page);
    return seen;
  });
}

/** Gives every dropdown its real options, so JEV chooses among them. Long lists (countries, schools) are searched by typing instead. */
export async function readDropdownOptions(page: Page, fields: DumpedField[]): Promise<void> {
  await Promise.all(
    fields
      .filter((f) => f.kind === "combobox" && f.options.length === 0)
      .map(async (f) => {
        const opts = await readOptions(page, f.selector);
        if (opts.length > 0 && opts.length <= FORM.maxOptionsForJev) f.options = opts.map((o) => ({ value: o, label: o }));
      }),
  );
}

/** Sets a react-select through its own handler: no clicks, no waiting on menus. Null when it cannot. */
async function fillDropdownDirect(page: Page, selector: string, value: string, hints: string[], out?: Picked): Promise<boolean | null> {
  const read = () => page.awj<string[] | null>("reactOptions", selector);
  let opts = await read();
  if (opts === null) return null;
  let choice = pickOption(opts, value, hints);
  if (!choice) {
    // A paginated list answers a search through its own loader in one round trip.
    const found = await page.awj<string[] | null>("reactLoad", selector, value).catch(() => null);
    choice = found ? pickOption(found, value, hints) : null;
  }
  if (!choice) {
    // A search-as-you-type list only loads while its menu counts as open, and it has to see that before the search text arrives.
    await page.awj("reactMenu", selector, true);
    await sleep(BROWSER.pollMs);
  }
  // A place is searched by its city first; anything else by the full value.
  const head = value.split(",")[0]?.trim() ?? "";
  for (const typed of choice ? [] : [...new Set(head && head !== value ? [head, value] : [value])]) {
    if (!(await page.awj<boolean>("reactSearch", selector, typed))) break;
    const begun = Date.now();
    let asked = 1;
    while (!choice && Date.now() - begun < BROWSER.optionsMs) {
      await sleep(BROWSER.pollMs);
      opts = (await read()) ?? [];
      choice = pickOption(opts, value, hints);
      // A search sent while the component was still mounting is dropped, so ask once more halfway through.
      if (!choice && !opts.length && asked === 1 && Date.now() - begun > BROWSER.optionsMs / 2) {
        asked = 2;
        await page.awj("reactSearch", selector, typed);
      }
    }
    if (choice) break;
    // Leave the search box empty again, so a fallback that types starts clean.
    await page.awj("reactSearch", selector, "");
  }
  if (!choice) await page.awj("reactMenu", selector, false);
  if (!choice) return false;
  const set = await page.awj<boolean>("reactSelect", selector, choice);
  if (set && out) out.picked = choice;
  return set;
}

/**
 * Sets a dropdown: through the component's own handlers when it has them, by clicking otherwise.
 * `byClicking` skips the first way, for a site where it is already known not to work.
 * Returns why it failed, or null, and which way set it.
 */
export async function fillDropdown(page: Page, selector: string, value: string, hints: string[], byClicking = false, out?: Picked): Promise<{ why: string | null; method: "script" | "clicked" }> {
  await whenOn(page, selector);
  if (!byClicking) {
    const direct = await fillDropdownDirect(page, selector, value, hints, out);
    if (direct) return { why: null, method: "script" };
    // The component itself said it has no such option, so typing the same text into it would only be slower.
    if (direct === false) return { why: `no option matches "${value}"`, method: "script" };
  }
  return { why: await fillDropdownByClicking(page, selector, value, hints, out), method: "clicked" };
}

/** Where a dropdown fill says which option it took for the value. */
export type Picked = { picked?: string | undefined };

export function fillDropdownByClicking(page: Page, selector: string, value: string, hints: string[], out?: Picked): Promise<string | null> {
  return inFront(page, () => clickAndPick(page, selector, value, hints, out));
}

async function clickAndPick(page: Page, selector: string, whole: string, hints: string[], out?: Picked): Promise<string | null> {
  // "Heading > Choice" names a choice in the list a heading opens. The first step is picked here, the rest under it.
  const [value = whole, ...deeper] = whole.split(CHOICE_PATH);
  if (!(await openDropdown(page, selector))) return "control not found";
  let opts = await waitOptions(page, selector, false);
  if (!opts.length) {
    // The first click may only have closed the list before it; a second one opens this list.
    await openDropdown(page, selector);
    opts = await waitOptions(page, selector, false);
  }
  let choice = pickOption(opts, value, hints);
  if (!choice) {
    // Search-as-you-type lists. A place is searched by its city; anything else by the full value, then its first word.
    const head = value.split(",")[0]?.trim() ?? "";
    const attempts = head && head !== value ? [head, value] : [value, value.split(/\s+/)[0] ?? ""];
    for (const typed of [...new Set(attempts)]) {
      if (!typed) continue;
      // Keys go wherever the focus is. A click that did not put it in this box (the window was still coming to the front) is made good here.
      if (!(await page.awj<boolean>("hasFocus", selector)) && !(await page.awj<boolean>("focus", selector))) break;
      await page.type(typed);
      if (await page.awj<boolean>("searchesOnEnter", selector)) await page.key("Enter");
      // The first word only widens the search. The pick still has to match the whole value.
      opts = await waitOptions(page, selector, true, (seen) => pickOption(seen, value, hints) !== null);
      choice = pickOption(opts, value, hints);
      if (choice) break;
      for (let i = 0; i < typed.length; i++) await page.key("Backspace");
    }
  }
  if (!choice) {
    await sketch(page, selector);
    await closeDropdown(page);
    return `no option matches "${value}"${opts.length ? ` among: ${opts.slice(0, 12).join(" | ")}` : ""}`;
  }
  // Finding the option scrolls it into view, and a list drawn beside its box moves with the box a moment later.
  // The point is read again once the page has settled, so the click lands on this row and not the one below.
  let shown = "";
  // One kind of list is pressed on the option itself (see pressOption). If that took, there is nothing to click.
  if (await page.awj<boolean>("pressOption", selector, choice).catch(() => false)) {
    // The box takes a moment to show the pick.
    for (const deadline = Date.now() + BROWSER.optionsMs / 4; Date.now() < deadline && !showsValue(choice, shown); ) {
      await sleep(BROWSER.pollMs);
      shown = (await shownValues(page, [selector]))[0] ?? "";
    }
  }
  if (!shown || !showsValue(choice, shown)) {
    const p = await steadyPoint(page, selector, choice);
    if (!p.ok) {
      await closeDropdown(page);
      return `option "${choice}" could not be clicked`;
    }
    await page.click(p.x, p.y);
    await sleep(BROWSER.pollMs);
    shown = (await shownValues(page, [selector]))[0] ?? "";
  }
  // A choice that is a heading opens the list under it (Workday's "How did you hear about us?"). The pick is made
  // there when the wanted value, or the one thing on offer, is in it. Anything else is left for the person, with what was offered.
  for (let level = 0; !shown && level < FORM.maxListLevels; level++) {
    let under = await waitOptions(page, selector, false);
    if (!under.length || under.join("|") === opts.join("|")) break;
    const named = deeper[level];
    // A long list draws only the rows in view. It is gone through until the wanted choice shows, or to its end.
    if (under.length > 1) under = await restOfList(page, selector, under, (seen) => pickOption(seen, named ?? value, hints) !== null);
    const next = named ? pickOption(under, named, hints) : (pickOption(under, value, hints) ?? (under.length === 1 ? (under[0] ?? null) : null));
    if (!next) {
      await sketch(page, selector);
      await closeDropdown(page);
      return `"${choice}" opens a list of its own${named ? `, and "${named}" is not in it` : ""}. The answer is one of these, written as "${choice} > the one": ${under.slice(0, FORM.maxListed).join(" | ")}`;
    }
    const at = await steadyPoint(page, selector, next);
    if (!at.ok) break;
    await page.click(at.x, at.y);
    await sleep(BROWSER.pollMs);
    opts = under;
    choice = next;
    shown = (await shownValues(page, [selector]))[0] ?? "";
  }
  if (await page.awj<boolean>("searchesOnEnter", selector)) await closeDropdown(page);
  if (shown && !showsValue(choice, shown)) return `the list shows "${shown.slice(0, 40)}" after "${choice}" was clicked`;
  if (out) out.picked = choice;
  return null;
}

/** The options most like the wanted value, by shared word stems, so a list of hundreds fits in one JEV question. */
export function closestOptions(options: string[], wanted: string, limit: number): string[] {
  if (options.length <= limit) return options;
  const stems = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 5));
  const want = new Set(stems(wanted));
  const scored = options.map((o) => ({ o, score: stems(o).filter((w) => want.has(w)).length + (norm(o).includes(norm(wanted)) ? 2 : 0) }));
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.o.length - b.o.length);
  return (hits.length ? hits : scored).slice(0, limit).map((x) => x.o);
}

/** Every option a search-as-you-type list offers for the wanted value: its starting list plus a search per word stem. */
export async function candidateOptions(page: Page, selector: string, wanted: string): Promise<string[]> {
  const found = new Set(await readOptions(page, selector));
  for (const word of norm(wanted).split(/[^a-z0-9]+/).filter((w) => w.length >= 4)) {
    const more = await page.awj<string[] | null>("reactLoad", selector, word.slice(0, 6)).catch(() => null);
    for (const o of more ?? []) found.add(o);
  }
  return [...found];
}
