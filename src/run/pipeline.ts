/**
 * The apply loop. Each job moves on its own through fill, resolve, the next
 * page if the form has one, and submit. Nothing waits for the batch: a form is
 * sent the moment it is ready, and its result is printed and recorded then.
 * Fills run side by side and paced per site, the writer takes a few forms at
 * a time, and submissions go one at a time with a pause per site.
 */
import { PATHS, RUN } from "../config.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearBrowsingData, ensureBrowser } from "../browser/cdp.js";
import { fillJob, nextPage, resolveJob, shouldAdvance } from "../browser/formRunner.js";
import { blockedReport, loadReport, type FillReport } from "../browser/report.js";
import { closeJobTab, loadSession } from "../browser/session.js";
import { submitJob } from "../browser/submit.js";
import { logNotes } from "../answers/resolve.js";
import { JevClient } from "../jev/client.js";
import { applyUrlFor, hostIs, type Job } from "../jobs/normalize.js";
import { loadQueue, mutateQueue, sortEntries, updateEntry, type QueueEntry } from "../jobs/queue.js";
import { withStore } from "../util/store.js";
import { rememberWalledHost } from "../jobs/walled.js";
import { learn, loadKnowledge } from "../knowledge/sites.js";
import { loadRows, saveRows, takeHomeCell, upsertEntry } from "../log/csv.js";
import { loadProfile, type Profile } from "../profile/schema.js";
import { limiter, paced, spacer } from "../util/pace.js";
import { outcomeOf } from "./outcome.js";
import { documentPolicy, tailorJob } from "../documents/tailor.js";
import { printFill } from "./print.js";

export type RunOptions = { submit: boolean; dry: boolean; fresh: boolean; quiet: boolean; fillOnly?: boolean };

const asJob = (e: QueueEntry) => e.job as unknown as Job;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * The jobs a run works on: the given ids, or the best queued ones. A real run marks them in
 * progress; a rehearsal leaves the queue alone. A job that was sent, or whose Submit was clicked
 * with no confirmation seen, is refused: `resubmit` lets a sent one through on purpose, and nothing
 * lets an unconfirmed one through until it is settled.
 */
export function takeJobs(ids: string[], o: { count: number; dry: boolean; resubmit?: boolean }): QueueEntry[] {
  if (o.dry) return pickJobs(loadQueue().entries, ids, o).picked;
  return mutateQueue((q) => {
    const { picked, refused } = pickJobs(q.entries, ids, o);
    for (const r of refused) console.log(`${r.id}  not taken: ${r.why}`);
    for (const e of picked) updateEntry(q, e.job.id, { status: "in_progress", statusReason: null, waitingFor: null, attempts: e.attempts + 1 });
    return picked;
  });
}

/** Which of the queue's jobs a run may take, and which named ids it must refuse, with the reason. A rehearsal sends nothing, so it may take any. */
export function pickJobs(entries: QueueEntry[], ids: string[], o: { count: number; dry: boolean; resubmit?: boolean }): { picked: QueueEntry[]; refused: { id: string; why: string }[] } {
  if (!ids.length) return { picked: sortEntries(entries.filter((e) => e.status === "queued")).slice(0, o.count), refused: [] };
  const picked: QueueEntry[] = [];
  const refused: { id: string; why: string }[] = [];
  for (const id of ids) {
    const e = entries.find((x) => x.job.id === id);
    if (!e) throw new Error(`No queue entry ${id}`);
    if (o.dry) picked.push(e);
    else if (e.status === "submission_unknown") refused.push({ id, why: `Submit was clicked on this form before and no confirmation was seen. Settle it first: npx jev reconcile ${id}` });
    else if (e.status === "applied" && !o.resubmit) refused.push({ id, why: `already applied on ${e.appliedAt?.slice(0, 10) ?? "an earlier day"}. To send it again on purpose, add --resubmit` });
    else picked.push(e);
  }
  return { picked, refused };
}

type RowExtra = Partial<Record<"What They Do" | "Why You're a Fit" | "Notes" | "Take-home", string>>;

/** Records an outcome in the queue and in the record files, as one step under the store lock. */
export function record(id: string, status: QueueEntry["status"], reason: string | null, extra: RowExtra = {}, waitingFor: QueueEntry["waitingFor"] = null): QueueEntry {
  return withStore(() => {
    const e = mutateQueue((q) => updateEntry(q, id, { status, statusReason: reason, waitingFor, ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}) }));
    saveRows(upsertEntry(loadRows(), e, extra));
    return e;
  });
}

/** Records an application as sent. A take-home the form asked for goes into the record too, so takehome.csv lists it for the person. */
export function recordApplied(id: string): QueueEntry {
  let takeHome: { text: string; url: string } | undefined;
  try {
    takeHome = loadReport(id).takeHome?.[0];
  } catch {
    takeHome = undefined;
  }
  if (takeHome) console.log(`  take-home to do: ${takeHome.url}`);
  const e = record(id, "applied", null, takeHome ? { "Take-home": takeHomeCell(takeHome.url, takeHome.text) } : {});
  noteSent();
  return e;
}

/** How many applications have gone out since the browsing data was last cleared. Kept in a file, so it counts across runs. */
const sentSinceClear = (): number => {
  try {
    return existsSync(PATHS.browsing) ? Number((JSON.parse(readFileSync(PATHS.browsing, "utf8")) as { sent?: number }).sent ?? 0) : 0;
  } catch {
    return 0;
  }
};
const noteSent = () => {
  mkdirSync(path.dirname(PATHS.browsing), { recursive: true });
  writeFileSync(PATHS.browsing, JSON.stringify({ sent: sentSinceClear() + 1 }));
};

/**
 * Clears the runner's cookies, cache and site data once enough applications have gone out, and only
 * while no form is open: a form mid-fill would lose its session. Call it before and after a run.
 */
export async function clearBrowsingWhenDue(): Promise<void> {
  if (sentSinceClear() < RUN.clearBrowsingEvery || Object.keys(loadSession()).length) return;
  try {
    await clearBrowsingData();
    writeFileSync(PATHS.browsing, JSON.stringify({ sent: 0 }));
    console.log("Cleared the runner's cookies, cache and site data.");
  } catch (err) {
    console.log(`Could not clear browsing data: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Set when a fill was abandoned. Its page connection may still be open, so a command ends the process itself when it is done. */
let abandoned = false;
export const endIfAbandoned = () => {
  if (abandoned) process.exit(process.exitCode ?? 0);
};

/** One go at a form, within RUN.fillTimeoutMs. A form that cannot be opened, or never settles, comes back as blocked. */
async function fillOnce(jev: JevClient, profile: Profile, e: QueueEntry): Promise<FillReport> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the form did not finish loading and filling in ${RUN.fillTimeoutMs / 1000}s`)), RUN.fillTimeoutMs);
    });
    const filling = fillJob(jev, profile, asJob(e));
    // If the time runs out, the fill is abandoned: its tab is closed below, and whatever it does afterwards is ignored.
    filling.catch(() => undefined);
    return await Promise.race([filling, tooLong]);
  } catch (err) {
    if (err instanceof Error && /did not finish loading/.test(err.message)) {
      abandoned = true;
      await closeJobTab(e.job.id).catch(() => undefined);
    }
    return blockedReport(e.job, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** A form whose values did not land on its first page is worth one more go: a page that loaded badly is often fine the second time. */
const worthAnotherGo = (r: FillReport) => r.state === "filled" && r.page === 1 && !r.stuck && r.failed.length > 0;

/** Settles what JEV left open on the page a job's tab shows: from the answer memory, or by Claude. A writer error leaves the form as it was. */
export async function resolvePage(jev: JevClient, profile: Profile, entry: QueueEntry | null, r: FillReport, fresh: boolean): Promise<FillReport> {
  try {
    return await resolveJob(profile, entry, r.jobId, { jev, fresh });
  } catch (err) {
    return { ...r, ready: false, reason: `writer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const CODE_PREFIX = "the board emailed you a code";
const CODE_REASON = `${CODE_PREFIX} to confirm a person is applying. Apply by hand, or run apply <id> --submit again later: boards stop asking after a while`;
export const HUMAN_PREFIX = "the site asks you to confirm you are not a robot";
const HUMAN_REASON = `${HUMAN_PREFIX} after Submit. Apply by hand`;
/** True for a job that stopped at a human check: a code a board emailed, or a robot check. */
export const waitsForYou = (reason: string | null | undefined) => !!reason && (reason.startsWith(CODE_PREFIX) || reason.startsWith(HUMAN_PREFIX));

/**
 * Submissions to one site are spaced out, and only one form is being sent at any moment. A burst
 * from one person reads as a robot. A site known to answer bursts with an emailed code gets a longer pause.
 */
const perSite = spacer((site) => (Object.entries(loadKnowledge().sites).some(([host, s]) => s.emailsCode && host.endsWith(site)) ? RUN.submitGapAfterCodeMs : RUN.submitGapMs));
const oneAtATime = limiter(1);
const siteOf = (id: string) => {
  try {
    return hostOf(loadReport(id).url).split(".").slice(-2).join(".");
  } catch {
    return id;
  }
};

/** Sends one ready form and records what the page became. True when the application went through. */
export function submitAndRecord(jev: JevClient, id: string, force: boolean, keepOpen = false): Promise<boolean> {
  return perSite(siteOf(id), () =>
    oneAtATime(async () => {
      try {
        const r = await submitJob(jev, id, force);
        console.log(`${id}  ${r.needsCode ? "needs your code" : r.humanCheck ? "needs you to pass a robot check" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
        if (r.state === "submitted") {
          recordApplied(id);
          if (!keepOpen) await closeJobTab(id);
          return true;
        }
        if (r.needsCode) {
          // Only the person can pass a human check. The tab is closed and the job is listed for them; the run moves on.
          record(id, "needs_review", CODE_REASON);
          learn(r.url, { emailsCode: true });
          if (!keepOpen) await closeJobTab(id);
          return false;
        }
        if (r.refused) {
          // The company takes one application per person for now. Nothing to hold: the job is skipped with the board's own words.
          record(id, "skipped", "the board refused a second application: you recently applied to this company");
          console.log("  the board refused a second application to this company");
          if (!keepOpen) await closeJobTab(id);
          return false;
        }
        if (r.humanCheck) {
          // A robot check is the person's to pass. The tab is closed and the job is listed for them; the run moves on.
          record(id, "needs_review", HUMAN_REASON);
          if (!keepOpen) await closeJobTab(id);
          return false;
        }
        if (r.errors.length) console.log(`  errors: ${r.errors.join(" | ")}`);
        console.log(`  page: ${r.excerpt}`);
        record(id, r.state === "captcha" || r.state === "login_required" ? "blocked" : "needs_review", `after submit the page was: ${r.state}${r.errors.length ? ` (${r.errors.slice(0, 3).join("; ").slice(0, 160)})` : ""}`);
        if (!keepOpen) await closeJobTab(id);
      } catch (err) {
        console.log(`${id}  not submitted: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }),
  );
}

/**
 * Fills the two sheet cells a person would otherwise write by hand, for every job just applied to.
 * A form Claude resolved already carries its note. The rest are written in one writer call.
 */
export async function noteApplied(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const entries = loadQueue().entries.filter((e) => ids.includes(e.job.id));
  const notes = new Map<string, { whatTheyDo: string; whyFit: string }>();
  for (const e of entries) {
    try {
      const n = loadReport(e.job.id).resolution?.note;
      if (n && (n.what_they_do || n.why_fit)) notes.set(e.job.id, { whatTheyDo: n.what_they_do, whyFit: n.why_fit });
    } catch {
      /* no report: the batch call below covers it */
    }
  }
  for (const [id, n] of await logNotes(loadProfile(), entries.filter((e) => !notes.has(e.job.id)))) notes.set(id, n);
  // The writer took a while: the rows are written from the queue as it is now, not as it was before the call.
  withStore(() => {
    const now = new Map(loadQueue().entries.map((e) => [e.job.id, e]));
    let rows = loadRows();
    for (const id of ids) {
      const e = now.get(id);
      const n = notes.get(id);
      if (e && n && (n.whatTheyDo || n.whyFit)) rows = upsertEntry(rows, e, { "What They Do": n.whatTheyDo, "Why You're a Fit": n.whyFit });
    }
    saveRows(rows);
  });
}

/** Takes a form from its filled first page to its last: each page resolved, then the form's own Next. */
async function walk(jev: JevClient, profile: Profile, e: QueueEntry, first: FillReport, o: RunOptions): Promise<FillReport> {
  let r = first;
  for (;;) {
    // A form that could not be opened has nothing to resolve.
    if (r.state !== "filled") return r;
    r = await resolvePage(jev, profile, e, r, o.fresh);
    if (!shouldAdvance(r)) return r;
    r = await nextPage(jev, profile, asJob(e), { dry: o.dry });
  }
}

/** Records what became of one job, and sends its form when it is ready and sending was asked for. True when the application went through. */
async function settle(jev: JevClient, r: FillReport, o: RunOptions): Promise<boolean> {
  const outcome = outcomeOf(r, RUN.maxPages);
  // What this form taught about its site: how many pages it has, and whether it ended ready. A rehearsal teaches the same.
  if (r.state === "filled" && !o.fillOnly) learn(r.url, { pages: r.page, form: { ready: outcome.action === "send" } });
  if (o.dry) {
    await closeJobTab(r.jobId);
    return false;
  }
  if (o.fillOnly) return false;
  if (outcome.action === "send") return o.submit ? submitAndRecord(jev, r.jobId, false) : false;
  const rec = record(r.jobId, outcome.action, outcome.reason);
  if (outcome.rememberSite) rememberWalledHost(rec.job.url);
  // A form the tool cannot finish is closed in a sending run: it is on the by-hand list with its link.
  if (outcome.action !== "needs_review" || o.submit) await closeJobTab(r.jobId);
  return outcome.action === "applied";
}

export async function pipeline(entries: QueueEntry[], o: RunOptions): Promise<{ reports: FillReport[]; sent: string[] }> {
  const profile = loadProfile();
  const jev = new JevClient();
  await ensureBrowser();
  await clearBrowsingWhenDue();
  const writer = limiter(RUN.writerConcurrency);
  const reports = new Array<FillReport>(entries.length);
  const sent: string[] = [];
  const after: Promise<void>[] = [];
  /** Jobs to fill once more when the rest are done, each with the window to itself. */
  const again: QueueEntry[] = [];
  const finish = async (e: QueueEntry, r: FillReport) => {
    reports[entries.indexOf(e)] = r;
    if (!o.quiet) printFill(r);
    if (await settle(jev, r, o)) sent.push(r.jobId);
  };
  // The documents for the next job are written while this one is being filled, so one job at a time stays quick.
  const prefetch = (i: number) => {
    const next = entries[i + 1];
    const policy = documentPolicy();
    if (!next || !policy.resume || o.dry) return;
    tailorJob(profile, next, { cover: policy.cover }).catch(() => undefined);
  };
  await paced(entries, (e) => hostOf(applyUrlFor(asJob(e))), async (e) => {
    prefetch(entries.indexOf(e));
    const first = await fillOnce(jev, profile, e);
    reports[entries.indexOf(e)] = first;
    const rest = (async () => {
      const r = o.fillOnly ? first : await writer(() => walk(jev, profile, e, first, o));
      if (RUN.fillAttempts > 1 && worthAnotherGo(r)) again.push(e);
      else await finish(e, r);
    })().catch((err) => console.log(`${e.job.id}  ${err instanceof Error ? err.message : String(err)}`));
    // One job at a time (RUN.fillConcurrency 1) means each job goes from fill to submit before the next opens. With more
    // tabs, a site that saves every field to its server (Ashby) still gets that, since it drops saves from several forms at
    // once; elsewhere the rest of a job's path does not hold a fill slot and the next form starts filling now.
    if (RUN.fillConcurrency === 1 || RUN.gentleHosts.some((h) => hostIs(hostOf(applyUrlFor(asJob(e))), h))) await rest;
    else after.push(rest);
    return first;
  });
  await Promise.all(after);
  // Some boxes only take a value while their tab keeps the window: a phone box on a page that is still loading its own
  // checker, for one. With five forms side by side no tab keeps it for long. These forms are filled again, one at a time.
  for (const e of again) {
    try {
      const first = await fillOnce(jev, profile, e);
      await finish(e, o.fillOnly ? first : await walk(jev, profile, e, first, o));
    } catch (err) {
      console.log(`${e.job.id}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await clearBrowsingWhenDue();
  return { reports, sent };
}
