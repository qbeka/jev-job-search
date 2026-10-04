/**
 * Fills one job's application form in the runner's Chrome window, a page at
 * a time: read every field, read each dropdown's options, one JEV call to map
 * them, write every value, read every value back. A form that runs over
 * several pages is walked with its own Next button once a page is clean.
 * Nothing here sends an application: that is submit.ts.
 */
import path from "node:path";
import { BROWSER, FORM, MEMORY, RUN } from "../config.js";
import { isApplicationForm, type DumpedField, type FieldsDump, type FillPlan } from "../forms/fields.js";
import { gateAnswer, hasChoosableOptions, mapForm } from "../forms/mapForm.js";
import { decidePageState } from "../forms/pageState.js";
import type { JevClient } from "../jev/client.js";
import { applyUrlFor, greenhouseFallbackUrl, type Job } from "../jobs/normalize.js";
import type { Profile } from "../profile/schema.js";
import { loadMemory, recallExact, recallForm, recallSameFields, recallSimilar, remember, saveMemory, type Recalled } from "../answers/memory.js";
import { contextFingerprint, resolveOpenFields, type OpenField, type Resolution } from "../answers/resolve.js";
import type { QueueEntry } from "../jobs/queue.js";
import { closeTab, ensureBrowser, newTab, Page, sleep } from "./cdp.js";
import { candidateOptions, closestOptions, readDropdownOptions } from "./dropdowns.js";
import { applyFills, TYPED_KINDS, uploadFile, type FillGuide } from "./fill.js";
import { learn, notesFor, signatureOf, type Method } from "../knowledge/sites.js";
import { blockedReport, comparePages, fieldsBlamed, notOnScreen, showsAnother, showsPlanned, emptyRequired, emptyRequiredFields, isClean, isReady, loadPlan, loadReport, pickNext, savePlan, saveReport, SIGN_IN_REASON, splitFailures, type Failure, type FieldReport, type Fill, type FillReport } from "./report.js";
import { signInFor } from "../accounts/gate.js";
import { controlStates, dump, goto, inFront, inTurn, install, loadSession, mutateSession, pageFor, settle, shownValues, trace, type Point } from "./session.js";

/** The text of a button that leads from a posting to its form. */
const APPLY_BUTTON = "^\\s*(apply|apply now|apply for this job|apply to this job|apply for this position|start application|i'm interested)\\s*[»›→>]*\\s*$";

/** Lands on the page that holds the form: the URL itself, an embedded ATS frame, or behind an Apply button. */
async function openForm(page: Page, job: Job): Promise<FieldsDump> {
  await goto(page, applyUrlFor(job));
  let d = await dump(page);
  for (let hop = 0; hop < 3 && !isApplicationForm(d); hop++) {
    const frame = d.frames[0];
    if (frame) {
      await goto(page, frame);
    } else {
      const p = await page.awj<Point>("clickByText", APPLY_BUTTON);
      if (!p.ok) break;
      if (p.href) {
        // A link is followed in this tab. Clicking one that opens a new tab would leave the runner looking at the old page.
        await goto(page, p.href);
      } else {
        await page.click(p.x, p.y);
        await settle(page);
        await install(page);
      }
    }
    d = await dump(page);
  }
  // A careers page that shows the job without the form: go to the board's own form for the same posting.
  const fallback = !isApplicationForm(d) && !d.hasPassword ? greenhouseFallbackUrl(job) : null;
  if (fallback) {
    await goto(page, fallback);
    d = await dump(page);
  }
  return d;
}

/**
 * Opens a job's form in a tab of its own and fills its first page. A sign-in page, a page with no
 * form, or a posting that has closed comes back as blocked with the reason.
 */
export async function fillJob(jev: JevClient, profile: Profile, job: Job, opts: { signal?: AbortSignal; dry?: boolean } = {}): Promise<FillReport> {
  const started = Date.now();
  const signal = opts.signal;
  await ensureBrowser();
  const old = loadSession()[job.id];
  // Opening a tab puts it in front, so it waits its turn behind any typing in another tab.
  const target = await inTurn(async () => {
    if (old) await closeTab(old.targetId);
    return newTab("about:blank");
  });
  const page = await Page.attach(target);
  const seconds = () => (Date.now() - started) / 1000;
  try {
    let d = await openForm(page, job);
    trace(`${job.company}: form open ${Date.now() - started}ms, ${d.fields.length} fields`);
    signal?.throwIfAborted();
    // Read and written in one synchronous step, so jobs filled side by side do not overwrite each other.
    mutateSession((s) => {
      s[job.id] = { targetId: target.id, url: d.url, state: "filling", since: new Date().toISOString() };
    });
    // A board the tool can sign in to: the person's account is used, or made where they allowed it. Anything the
    // sign-in cannot finish with certainty comes back as what the job now waits for.
    const auth = await signInFor(page, applyUrlFor(job), { rehearsal: !!opts.dry });
    // An attempt that ran out of time was replaced by another: it must not write over that one's report.
    signal?.throwIfAborted();
    if (auth && !auth.ok) return saveReport({ ...blockedReport(job, auth.reason, d.url, seconds()), auth: { status: auth.status, waitingFor: auth.waitingFor } });
    if (auth) {
      trace(`${job.company}: signed in (${auth.steps.join(", ")}) ${Date.now() - started}ms`);
      signal?.throwIfAborted();
      await settle(page);
      await install(page);
      d = await dump(page);
    }
    // Behind a sign-in the page is the application by construction, whatever its first page asks for.
    const isForm = (x: FieldsDump) => isApplicationForm(x) || (!!auth && !x.hasPassword && x.fields.length > 0);
    if (!isForm(d) && !d.hasPassword) {
      // Job boards answer bursts with an error page. One unhurried second try settles most of them.
      const first = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url, job.id);
      if (first.state === "error" || first.state === "other") {
        trace(`${job.company}: page looked like ${first.state}, retrying in ${BROWSER.retryAfterMs}ms`);
        await sleep(BROWSER.retryAfterMs);
        d = await openForm(page, job);
      }
    }
    // A password box means a sign-in or account page. Nothing is typed into it. The job is left for the person.
    if (d.hasPassword) return saveReport(blockedReport(job, SIGN_IN_REASON, d.url, seconds()));
    if (!isForm(d)) {
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url, job.id);
      return saveReport(blockedReport(job, `no form found, page looks like: ${state.state}`, d.url, seconds()));
    }
    return await fillPage(page, jev, profile, job, d, { page: 1, earlier: [], started, ...(signal ? { signal } : {}) });
  } finally {
    page.close();
  }
}

/** What a list says when the answer it was given is not one of its choices. */
export const UNFIT = /opens a list of its own|no option matches/;

/** Fills the page the tab shows, from its dump, and reports what the page holds afterwards. */
async function fillPage(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, at: { page: number; earlier: FieldReport[]; started: number; jevCostUsd?: number; signal?: AbortSignal }): Promise<FillReport> {
  await readDropdownOptions(page, d.fields);
  // A page that was still drawing itself when it was read has more on it now (Workday brings its sections in one by one).
  // It is read again, so the plan is made from the whole page and not from its first half.
  for (let read = 0; read < FORM.rereads; read++) {
    const now = await dump(page);
    const { fresh } = comparePages(d, now);
    if (!fresh.length) break;
    trace(`${job.company}: the page grew by ${fresh.length} field(s) while it was read, reading it again`);
    for (const f of now.fields) f.options = f.options.length ? f.options : (d.fields.find((x) => x.selector === f.selector)?.options ?? []);
    d = now;
    await readDropdownOptions(page, d.fields);
  }
  trace(`${job.company}: options read ${Date.now() - at.started}ms`);
  const plan = await mapForm(jev, profile, job, d);
  trace(`${job.company}: mapped ${Date.now() - at.started}ms`);
  // The resume goes in first: some boards (Lever) read it and write what they find into the form,
  // and the profile's values have to be the ones that stay.
  const uploaded = new Set<string>();
  const uploadFailures: Failure[] = [];
  for (const u of plan.uploads) {
    const why = (await uploadFile(page, u.selector, u.path)) ?? null;
    if (!why) uploaded.add(u.selector);
    else uploadFailures.push({ selector: u.selector, why });
    trace(`${job.company}: upload ${why ?? "ok"}`);
  }
  const guide = guideFor(d);
  // A form that draws itself again after its lists were read is not written to halfway: the boxes have to be back first.
  for (const deadline = Date.now() + BROWSER.optionsMs * 2; Date.now() < deadline; await sleep(BROWSER.pollMs)) {
    const states = await controlStates(page, plan.fields.map((f) => f.selector));
    if (!notOnScreen(plan.fields, states).length) break;
  }
  let failedRaw = await applyFills(page, plan.fills, profile, guide);
  trace(`${job.company}: filled ${Date.now() - at.started}ms`);
  // A page that finishes starting up after the fill can wipe what was typed, and a phone box throws a number away
  // until its own checker has loaded. Such values are put back after a short wait, then once more after a longer one.
  for (const [round, wait] of BROWSER.putBackAfterMs.entries()) {
    const wiped = plan.fills
      .filter((f) => TYPED_KINDS.has(f.kind) && failedRaw.some((x) => x.selector === f.selector))
      // A phone box that refused the bare number is given it with the country code: some only accept a number they can place in a country.
      .map((f) => (round > 0 && f.kind === "tel" && f.value === profile.phone.national ? { ...f, value: `${profile.phone.countryCode}${profile.phone.national}` } : f));
    if (!wiped.length) break;
    await sleep(wait);
    const still = await applyFills(page, wiped, profile, guide);
    failedRaw = [...failedRaw.filter((x) => !wiped.some((f) => f.selector === x.selector)), ...still];
    trace(`${job.company}: put back ${wiped.length - still.length} of ${wiped.length} wiped value(s) after ${wait}ms`);
  }
  failedRaw = [...(await secondLook(page, jev, profile, job, d, plan, failedRaw)), ...uploadFailures];
  failedRaw = await followUp(page, jev, profile, job, d, plan, failedRaw);
  // An attempt that ran out of time was replaced by another: it must not write over that one's plan or report.
  at.signal?.throwIfAborted();
  savePlan(job.id, d, plan);
  const read = await readBack(page, d, plan, failedRaw, uploaded);
  guide.learn([...read.failed, ...read.leftBlank]);
  const partial = { jobId: job.id, company: job.company, title: job.title, ats: job.ats, ...read, takeHome: d.takeHome, page: at.page, earlier: at.earlier, hasNext: !!pickNext(plan.submitSelectors), seconds: (Date.now() - at.started) / 1000, jevCostUsd: (at.jevCostUsd ?? 0) + plan.jevCostUsd };
  return saveReport({ ...partial, ready: isReady(partial) });
}

/**
 * Some questions only appear once another is answered ("Are you willing to relocate?" after "No, I do
 * not live near the office"). After a fill the page is read again. Controls that moved get their new
 * selector, and controls that are new are mapped and filled like the rest. The dump and the plan are
 * updated in place, so every later step sees the page as it is.
 */
async function followUp(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, plan: FillPlan, failed: Failure[]): Promise<Failure[]> {
  let out = failed;
  for (let round = 0; round < FORM.followUpRounds; round++) {
    const now = await dump(page);
    const { moved, fresh } = comparePages(d, now);
    if (moved.size) {
      const to = (selector: string) => moved.get(selector) ?? selector;
      for (const list of [d.fields, plan.fields, plan.fills, plan.drafts, plan.reviews, plan.uploads, out]) for (const f of list) f.selector = to(f.selector);
    }
    d.submitSelectors = now.submitSelectors;
    plan.submitSelectors = now.submitSelectors;
    if (!fresh.length) break;
    trace(`${job.company}: ${fresh.length} new field(s) appeared: ${fresh.map((f) => f.label.slice(0, 30)).join(" | ")}`);
    // Ids are per read of the page, so the new fields get ids of their own.
    const added = fresh.map((f) => ({ ...f, id: `r${round}${f.id}` }));
    await readDropdownOptions(page, added);
    const more = await mapForm(jev, profile, job, { ...now, fields: added });
    out = [...out, ...(await applyFills(page, more.fills, profile, guideFor({ ...now, fields: added })))];
    d.fields.push(...added);
    plan.fields.push(...more.fields);
    plan.fills.push(...more.fills);
    plan.drafts.push(...more.drafts);
    plan.reviews.push(...more.reviews);
    plan.jevCostUsd += more.jevCostUsd;
  }
  return out;
}

/**
 * What is known about this site's controls, for the fill step to use, and the notebook it writes
 * what it finds into. Kinds of controls are told apart by their signature, never by their label.
 */
function guideFor(d: FieldsDump): FillGuide & { learn: (unset: Failure[]) => void } {
  const notes = notesFor(d.url);
  const signature = new Map(d.fields.map((f) => [f.selector, signatureOf(f)]));
  const landed: Record<string, Method> = {};
  return {
    prefer: (selector) => notes.controls[signature.get(selector) ?? ""]?.method,
    landed: (selector, method) => {
      const s = signature.get(selector);
      if (s) landed[s] = method;
    },
    learn: (unset) => {
      const trouble: Record<string, string> = {};
      for (const f of unset) {
        const s = signature.get(f.selector);
        if (s && !(s in landed)) trouble[s] = f.why;
      }
      if (Object.keys(landed).length || Object.keys(trouble).length) learn(d.url, { landed, trouble });
    },
  };
}

/**
 * The controls a page holds, as one text: used to tell whether a click moved the form to another
 * page. Labels are left out, since a page that refuses to move on rewrites them with its complaints.
 */
const pageSignature = (d: FieldsDump) => `${d.url.split("#")[0]}\n${d.fields.map((f) => f.selector).join("\n")}\n${d.submitSelectors.map((s) => s.split("  /*")[0]).join("\n")}`;

/**
 * Moves a form whose current page is clean to its next page and fills that one. The page's own
 * Next button is clicked, once. If the form does not move, what the page says is reported and the
 * form is held. If the click turns out to have sent the application, the report says so.
 *
 * In a rehearsal the button is clicked only when JEV agrees that the form goes on, so that a
 * rehearsal does not send a form whose last button happens to be called Continue.
 */
export async function nextPage(jev: JevClient, profile: Profile, job: Job, opts: { dry: boolean }): Promise<FillReport> {
  const r = loadReport(job.id);
  const { dump: before, plan } = loadPlan(job.id);
  const next = pickNext(plan.submitSelectors);
  if (!next || !isClean(r)) return r;
  const started = Date.now();
  const hold = (reason: string): FillReport => saveReport({ ...r, ready: false, reason, stuck: reason, failed: [...r.failed, { selector: next.selector, label: next.text, why: reason }] });
  const page = await pageFor(job.id);
  try {
    if (opts.dry) {
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), r.url, job.id);
      if (state.hasMorePages < 0.5) return hold(`could not tell that "${next.text}" leads to another page and does not send the form, so the rehearsal stopped here`);
    }
    await page.writesSettled(BROWSER.saveMs);
    const was = pageSignature(before);
    await inFront(page, async () => {
      const p = await page.awj<Point>("point", next.selector);
      if (!p.ok) throw new Error(`The "${next.text}" button is not on the page.`);
      await page.click(p.x, p.y);
    });
    // Wait for another page: other fields, or other buttons.
    const deadline = Date.now() + BROWSER.submitMs;
    let d = before;
    let moved = false;
    while (Date.now() < deadline && !moved) {
      await sleep(BROWSER.pollMs * 3);
      try {
        await install(page);
        d = await dump(page);
      } catch {
        continue; // mid-navigation
      }
      moved = pageSignature(d) !== was;
    }
    if (!moved) {
      const errors = await page.evaluate<string[]>("window.__awj.errors()");
      const refusals = (r.refusals ?? 0) + 1;
      if (refusals <= RUN.nextRetries) {
        // The form says which boxes it objects to: those go back to the writer and the page is tried again. A form
        // that says nothing was slow, or took the click as a first validation: its Next is pressed once more.
        const blamed = fieldsBlamed(plan.fields, errors).filter((x) => !r.failed.some((y) => y.selector === x.selector));
        trace(`${job.company}: "${next.text}" did not move the form (${refusals}), ${blamed.length ? `the page blames ${blamed.map((x) => x.label.slice(0, 30)).join(" | ")}` : errors.length ? "its errors name no box the tool knows" : "the page says nothing"}`);
        if (blamed.length || !errors.length) return saveReport({ ...r, ready: false, refusals, failed: [...r.failed, ...blamed] });
      }
      return hold(`the form did not move on after "${next.text}"${errors.length ? `: ${errors.slice(0, 3).join("; ").slice(0, 200)}` : ""}`);
    }
    await settle(page);
    await install(page);
    d = await dump(page);
    // A next page that is still coming in shows nothing yet. It is given a little longer before anything is concluded from it.
    for (let look = 0; look < FORM.rereads && !d.fields.length && !d.submitSelectors.length && !d.hasPassword; look++) {
      await sleep(BROWSER.retryAfterMs / 2);
      await settle(page);
      d = await dump(page);
    }
    const earlier = [...r.earlier, ...r.fields];
    const cost = r.jevCostUsd;
    if (d.hasPassword) return saveReport({ ...blockedReport(job, SIGN_IN_REASON, d.url), earlier, page: r.page + 1 });
    if (!d.fields.length && !d.submitSelectors.length) {
      // No form any more. Either the application went through, or the site showed something else.
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url, job.id);
      if (state.state === "submitted") return saveReport({ ...r, earlier, fields: [], page: r.page + 1, hasNext: false, ready: false, sent: true, reason: `"${next.text}" sent the application` });
      return saveReport({ ...blockedReport(job, `after "${next.text}" the page was: ${state.state}`, d.url), earlier, page: r.page + 1 });
    }
    trace(`${job.company}: page ${r.page + 1}, ${d.fields.length} fields`);
    return await fillPage(page, jev, profile, job, d, { page: r.page + 1, earlier, started, jevCostUsd: cost });
  } finally {
    page.close();
  }
}

/** True while a form should be taken to its next page: this page is clean, it has a Next, and the form has not run past the limit. */
export const shouldAdvance = (r: FillReport) => r.state === "filled" && !r.stuck && r.hasNext && isClean(r) && (r.resolution?.verdict ?? "ready") === "ready" && !r.sent && r.page < RUN.maxPages;

/**
 * Two retries before anything is handed to Claude.
 * A dropdown that refused the value JEV named gets its real options gathered, cut to the closest few, and JEV picks among those.
 * A search box whose starter suggestions held nothing for the candidate is asked again as a value to type.
 */
async function secondLook(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, plan: FillPlan, failed: { selector: string; why: string }[]): Promise<{ selector: string; why: string }[]> {
  const again: DumpedField[] = [];
  for (const f of d.fields) {
    if (f.kind !== "combobox" && f.kind !== "select") continue;
    const planned = plan.fields.find((p) => p.selector === f.selector);
    if (!hasChoosableOptions(f) && failed.some((x) => x.selector === f.selector)) {
      const wanted = planned?.value ?? "";
      const pool = f.kind === "select" ? f.options : (await candidateOptions(page, f.selector, wanted)).map((o) => ({ value: o, label: o }));
      const keep = new Set(closestOptions(pool.map((o) => o.label), wanted, FORM.maxOptionsForJev));
      const options = pool.filter((o) => keep.has(o.label));
      if (options.length) again.push({ ...f, options });
    } else if (f.kind === "combobox" && hasChoosableOptions(f) && planned && planned.action !== "fill" && /no option fits|left unselected/.test(planned.note ?? "")) {
      again.push({ ...f, options: [] });
    }
  }
  if (!again.length) return failed;
  const second = await mapForm(jev, profile, job, { ...d, fields: again });
  const stillFailed = await applyFills(page, second.fills, profile, guideFor(d));
  for (const p of second.fields) {
    const i = plan.fields.findIndex((x) => x.selector === p.selector);
    const first = plan.fields[i];
    // A second answer replaces the first only when it produced a value.
    if (first && (p.action === "fill" || first.action === "fill")) plan.fields[i] = { ...p, id: first.id, note: p.note ?? "settled on a second look" };
  }
  const settled = new Set(second.fills.map((f) => f.selector));
  plan.reviews = [...plan.reviews.filter((r) => !settled.has(r.selector)), ...second.reviews.filter((r) => !plan.reviews.some((x) => x.selector === r.selector))];
  plan.jevCostUsd += second.jevCostUsd;
  trace(`${job.company}: second look at ${again.length} dropdown(s), ${second.fills.length - stillFailed.length} settled`);
  // A dropdown the second look could not settle either goes to Claude with its closest options attached.
  for (const f of again) {
    if (settled.has(f.selector) && !stillFailed.some((x) => x.selector === f.selector)) continue;
    if (!plan.reviews.some((r) => r.selector === f.selector)) plan.reviews.push({ id: f.id, selector: f.selector, kind: f.kind, label: f.label, options: f.options.map((o) => o.label), why: "no option matched the profile value" });
  }
  return [...failed.filter((f) => !settled.has(f.selector)), ...stillFailed];
}

/** Reads the page back against the plan: what each field shows, what did not land, what is still empty. */
async function readBack(page: Page, d: FieldsDump, plan: FillPlan, failedRaw: Failure[], uploaded = new Set<string>()): Promise<Pick<FillReport, "url" | "state" | "reason" | "fields" | "drafts" | "reviews" | "failed" | "leftBlank" | "missingRequired">> {
  const shown = await shownValues(page, plan.fields.map((f) => f.selector));
  const fields = plan.fields.map((f, i) => ({ label: f.label, required: f.required, action: f.action, shown: uploaded.has(f.selector) ? path.basename(f.value ?? "") : shown[i] ?? "", note: f.note }));
  const labelOf = (selector: string) => plan.fields.find((f) => f.selector === selector)?.label ?? selector;
  // The last line of defence: a value the plan wanted that the page does not show is a failure, whatever happened on the way.
  const states = await controlStates(page, plan.fields.map((f) => f.selector));
  const failed = [...failedRaw, ...notOnScreen(plan.fields, states)];
  plan.fields.forEach((f, i) => {
    if (states[i] === "off" || failed.some((x) => x.selector === f.selector)) return;
    const shownNow = fields[i]?.shown ?? "";
    if ((f.action === "fill" || f.action === "upload") && !shownNow) {
      failed.push({ selector: f.selector, why: states[i] === "missing" ? "the control is no longer on the page" : "the value is not confirmed on the page" });
    } else if (f.action === "fill" && f.value && !showsPlanned(f, shownNow)) {
      failed.push({ selector: f.selector, why: `the page shows "${shownNow.slice(0, 40)}" instead of "${(f.optionLabel ?? f.value).slice(0, 40)}"` });
    }
  });
  const { holds, leftBlank } = splitFailures(plan, failed, fields.map((f) => f.shown));
  return {
    url: plan.url,
    state: "filled",
    reason: null,
    fields,
    drafts: plan.drafts,
    reviews: plan.reviews,
    failed: holds.map((f) => ({ ...f, label: labelOf(f.selector) })),
    leftBlank: leftBlank.map((f) => ({ ...f, label: labelOf(f.selector) })),
    missingRequired: emptyRequired(d, plan, fields.map((f) => f.shown), states),
  };
}

/**
 * Hands every field still open on a filled form to Claude, writes its answers into the page,
 * reads them back, and records whether the form is now ready to submit.
 */
export async function resolveJob(profile: Profile, entry: QueueEntry | null, jobId: string, opts: { jev?: JevClient; fresh?: boolean } = {}): Promise<FillReport> {
  const r = loadReport(jobId);
  if (r.state !== "filled" || r.stuck || isClean(r)) return r;
  const { dump: d, plan } = loadPlan(jobId);
  // Each page of a form has its own place in the answer memory.
  const memoryKey = r.page > 1 ? `${jobId}#p${r.page}` : jobId;
  const page = await pageFor(jobId);
  try {
    const dumped = (selector: string) => d.fields.find((f) => f.selector === selector);
    const open = new Map<string, OpenField>();
    const add = (selector: string, why: string) => {
      const f = dumped(selector);
      if (f && !open.has(selector)) open.set(selector, { selector, kind: f.kind, label: f.label, question: f.kind === "checkbox" || f.kind === "radio" ? f.section : "", hint: f.hint || f.placeholder, required: f.required, maxLength: f.maxLength, options: f.options.map((o) => o.label), why });
    };
    for (const x of plan.drafts) add(x.selector, `needs writing (${x.intent})`);
    for (const x of plan.reviews) {
      add(x.selector, x.why);
      // A review can carry options gathered after the dump, on the second look.
      const o = open.get(x.selector);
      if (o && !o.options.length && x.options.length) o.options = x.options;
    }
    // A file that did not upload is not something Claude can answer; it stays a failure.
    for (const x of [...r.failed, ...(r.leftBlank ?? [])]) if (dumped(x.selector)?.kind !== "file") add(x.selector, x.why);
    const before = await shownValues(page, plan.fields.map((f) => f.selector));
    const statesBefore = await controlStates(page, plan.fields.map((f) => f.selector));
    for (const f of emptyRequiredFields(d, plan, before, statesBefore)) add(f.selector, "required and still empty");
    // An option is shown with its question, so Claude can see which choice a group already holds.
    const withQuestion = (selector: string, label: string) => {
      const f = dumped(selector);
      return f && (f.kind === "checkbox" || f.kind === "radio") && f.section && f.section !== label ? `${f.section} / ${label}` : label;
    };
    const filled = plan.fields.map((f, i) => ({ label: withQuestion(f.selector, f.label), value: before[i] ?? "" })).filter((f) => f.value && f.label);
    const openFields = [...open.values()];
    const company = entry?.job.company ?? r.company;
    const fingerprint = contextFingerprint(profile);
    const useMemory = MEMORY.enabled && !opts.fresh;
    const mem = useMemory ? loadMemory() : null;
    // The same form with the same open fields was resolved before: what was read then is what goes in now.
    // A list that turned an answer down has shown that the remembered answer does not fit it. That question goes to the
    // writer again, with what the list offers, and the form is not taken as the same one resolved before.
    const turnedDown = new Set(openFields.filter((f) => UNFIT.test(f.why)).map((f) => f.selector));
    const askMemory = openFields.filter((f) => !turnedDown.has(f.selector));
    const sameForm = mem && !turnedDown.size ? recallForm(mem, memoryKey, fingerprint, openFields) : null;
    let recalled = new Map<string, Recalled>();
    let resolution: Resolution;
    if (sameForm) {
      resolution = sameForm;
      recalled = new Map(sameForm.answers.map((a) => [a.selector, { value: a.value, reusable: a.reusable, source: "same form", from: company }]));
    } else {
      if (mem) {
        recalled = recallSameFields(mem, memoryKey, fingerprint, askMemory);
        for (const [selector, hit] of recallExact(mem, fingerprint, company, askMemory.filter((f) => !recalled.has(f.selector)))) recalled.set(selector, hit);
        const rest = askMemory.filter((f) => !recalled.has(f.selector));
        if (opts.jev && rest.length) {
          // A question worded another way: JEV says whether it is the same question. If it cannot be asked, Claude answers as before.
          const similar = await recallSimilar(opts.jev, mem, fingerprint, company, rest, `same-question:${jobId}`).catch(() => new Map<string, Recalled>());
          for (const [selector, hit] of similar) recalled.set(selector, hit);
        }
      }
      const rest = openFields.filter((f) => !recalled.has(f.selector));
      const settled = openFields.filter((f) => recalled.has(f.selector) && f.kind !== "checkbox").map((f) => ({ label: withQuestion(f.selector, f.label), value: recalled.get(f.selector)?.value ?? "" }));
      const fresh = await resolveOpenFields(profile, entry, [...filled, ...settled], rest);
      resolution = { ...fresh, answers: [...[...recalled].map(([selector, hit]) => ({ selector, value: hit.value, reusable: hit.reusable })), ...fresh.answers] };
      // The sheet note written for this posting last time is kept when Claude is not asked again.
      const prior = mem?.forms[memoryKey];
      if (!resolution.note && prior?.fingerprint === fingerprint && prior.resolution.note) resolution.note = prior.resolution.note;
    }
    // An answer about the right to work is held to the profile whoever gave it: the writer, or the memory.
    if (entry) {
      const refused = resolution.answers.flatMap((a) => {
        const field = dumped(a.selector);
        const why = field ? gateAnswer(field, a.value, profile, entry.job as unknown as Job) : null;
        return why ? [{ selector: a.selector, why: `${field?.label.slice(0, 60) ?? a.selector}: ${why}` }] : [];
      });
      if (refused.length) {
        const dropped = new Set(refused.map((x) => x.selector));
        resolution = { ...resolution, verdict: "needs_review", reason: [resolution.reason, ...refused.map((x) => x.why)].filter(Boolean).join(" "), answers: resolution.answers.filter((a) => !dropped.has(a.selector)) };
      }
    }
    const fills = resolution.answers
      .map((a) => ({ selector: a.selector, kind: open.get(a.selector)?.kind ?? "text", value: a.value }))
      .filter((f) => !(f.kind === "checkbox" && !/^(true|yes|1|on|checked)$/i.test(f.value)));
    let failedRaw: Failure[] = [...(await applyFills(page, fills, profile, guideFor(d))), ...r.failed.filter((x) => dumped(x.selector)?.kind === "file").map(({ selector, why }) => ({ selector, why }))];
    // An answer Claude gave may have brought up a further question. JEV fills what it can of those; what it cannot is open on the next look.
    if (opts.jev && entry) {
      const fieldsBefore = plan.fields.length;
      failedRaw = await followUp(page, opts.jev, profile, entry.job as unknown as Job, d, plan, failedRaw);
      if (plan.fields.length > fieldsBefore) savePlan(jobId, d, plan);
    }
    const after = await shownValues(page, plan.fields.map((f) => f.selector));
    const states = await controlStates(page, plan.fields.map((f) => f.selector));
    const answered = new Set(resolution.answers.map((a) => a.selector));
    const stillRequired = new Set(emptyRequiredFields(d, plan, after, states).map((f) => f.selector));
    const labelOf = (selector: string) => plan.fields.find((f) => f.selector === selector)?.label ?? selector;
    const fields = plan.fields.map((f, i) => {
      const was = r.fields[i];
      const shown = was?.action === "upload" && was.shown ? was.shown : after[i] ?? "";
      return { label: f.label, required: f.required, action: recalled.has(f.selector) ? "memory" : answered.has(f.selector) ? "claude" : f.action, shown, note: f.note };
    });
    if (mem && !sameForm) {
      const landed = (selector: string) => !!after[plan.fields.findIndex((f) => f.selector === selector)];
      saveMemory(remember(loadMemory(), { jobId: memoryKey, company, fingerprint, open: openFields, resolution, landed, recalled: new Set(recalled.keys()) }));
    }
    const { holds, leftBlank } = splitFailures(
      plan,
      [
        ...failedRaw,
        // Anything the plan or Claude wanted in the form that the page does not show.
        ...plan.fields.filter((f, i) => (f.action === "fill" || f.action === "upload" || fills.some((x) => x.selector === f.selector)) && !fields[i]?.shown && states[i] !== "off" && !failedRaw.some((x) => x.selector === f.selector)).map((f) => ({ selector: f.selector, why: "the value is not confirmed on the page" })),
        // And anything that shows some other value than the one it was given, whatever happened on the way.
        ...showsAnother(plan.fields, fills, fields.map((f) => f.shown), states).filter((x) => !failedRaw.some((y) => y.selector === x.selector)),
        ...notOnScreen(plan.fields, states),
      ],
      fields.map((f) => f.shown),
    );
    const next: Omit<FillReport, "ready"> = {
      ...r,
      fields,
      // An open question Claude chose to leave blank is settled too, unless it is required and still empty.
      drafts: plan.drafts.filter((x) => stillRequired.has(x.selector)),
      // An open field Claude chose to leave blank is settled, unless it is still a required field with nothing in it.
      reviews: plan.reviews.filter((x) => stillRequired.has(x.selector)),
      failed: holds.map((f) => ({ ...f, label: labelOf(f.selector) })),
      leftBlank: leftBlank.map((f) => ({ ...f, label: labelOf(f.selector) })),
      missingRequired: emptyRequired(d, plan, fields.map((f) => f.shown), states),
      resolution,
      recalled: recalled.size,
      writerCalled: !sameForm && openFields.some((f) => !recalled.has(f.selector)),
    };
    // A verdict other than ready holds the page whatever it shows: it is recorded as a review the person has to settle.
    const held = resolution.verdict === "ready" ? next : { ...next, reason: resolution.reason || next.reason };
    return saveReport({ ...held, ready: resolution.verdict === "ready" && isReady(held) });
  } finally {
    page.close();
  }
}

/** Writes extra values (Claude's drafts and review decisions) into a form that fill already opened. */
export async function setValues(profile: Profile, jobId: string, fills: Fill[]): Promise<{ failed: { selector: string; why: string }[]; shown: Record<string, string> }> {
  const page = await pageFor(jobId);
  try {
    const failed = await applyFills(page, fills, profile);
    const values = await shownValues(page, fills.map((f) => f.selector));
    return { failed, shown: Object.fromEntries(fills.map((f, i) => [f.selector, values[i] ?? ""])) };
  } finally {
    page.close();
  }
}

/** Reads the current state of an already-filled form: every planned field with what the page shows now. */
export async function inspect(jobId: string): Promise<{ fields: FieldReport[]; errors: string[] }> {
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = loadPlan(jobId);
    const r = await readBack(page, d, plan, []);
    return { fields: r.fields, errors: await page.evaluate<string[]>("window.__awj.errors()") };
  } finally {
    page.close();
  }
}
