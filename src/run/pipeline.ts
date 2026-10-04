/**
 * The apply loop. Each job moves on its own through fill, resolve, the next
 * page if the form has one, and submit. Nothing waits for the batch: a form is
 * sent the moment it is ready, and its result is printed and recorded then.
 * Fills run side by side and paced per site, the writer takes a few forms at
 * a time, and submissions go one at a time with a pause per site.
 */
import { ACCOUNTS, RUN } from "../config.js";
import { accountGate, adapterFor, capabilityFor } from "../accounts/capability.js";
import { signedInNow } from "../accounts/gate.js";
import { ensureBrowser, sleep } from "../browser/cdp.js";
import { fillJob, nextPage, resolveJob, shouldAdvance } from "../browser/formRunner.js";
import { blockedReport, loadReport, saveReport, type FillReport } from "../browser/report.js";
import { closeJobTab, hasOpenTab, loadSession, mutateSession, pageFor } from "../browser/session.js";
import { checkJob, submitJob, watchForConfirmation } from "../browser/submit.js";
import { assist, waitingWords } from "./assist.js";
import { logNotes } from "../answers/resolve.js";
import { JevClient } from "../jev/client.js";
import { applyUrlFor, hostIs, type Job } from "../jobs/normalize.js";
import { loadQueue, mutateQueue, RUN_OWNED, sortEntries, updateEntry, type QueueEntry } from "../jobs/queue.js";
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
/** The profile as this one job sees it: with the answers the person gave for this job's own questions. */
const forJob = (profile: Profile, e: QueueEntry | null): Profile => (e?.answers?.length ? { ...profile, answers: [...profile.answers, ...e.answers] } : profile);
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
  if (o.dry) {
    const { picked, refused } = pickJobs(loadQueue().entries, ids, o, accountGate());
    for (const r of refused) console.log(`${r.id}  not taken: ${r.why}`);
    return picked;
  }
  return mutateQueue((q) => {
    const { picked, refused } = pickJobs(q.entries, ids, o, accountGate());
    for (const r of refused) console.log(`${r.id}  not taken: ${r.why}`);
    for (const e of picked) updateEntry(q, e.job.id, { status: "in_progress", statusReason: null, waitingFor: null, attempts: e.attempts + 1 });
    return picked;
  });
}

/**
 * Which of the queue's jobs a run may take, and which named ids it must refuse, with the reason. A
 * rehearsal sends nothing, so it may take any. `gate` speaks for the boards that want an account:
 * a job there is taken only when the tool may sign in today, and never more new accounts than the day allows.
 */
export function pickJobs(entries: QueueEntry[], ids: string[], o: { count: number; dry: boolean; resubmit?: boolean }, gate: (url: string) => string | null = () => null): { picked: QueueEntry[]; refused: { id: string; why: string }[] } {
  if (!ids.length) {
    const picked: QueueEntry[] = [];
    for (const e of sortEntries(entries.filter((x) => x.status === "queued"))) {
      if (picked.length >= o.count) break;
      // A job that must wait for another day stays in the queue, untouched.
      if (!gate(e.job.url)) picked.push(e);
    }
    return { picked, refused: [] };
  }
  const picked: QueueEntry[] = [];
  const refused: { id: string; why: string }[] = [];
  for (const id of ids) {
    const e = entries.find((x) => x.job.id === id);
    if (!e) throw new Error(`No queue entry ${id}`);
    const held = gate(e.job.url);
    if (held) refused.push({ id, why: held });
    else if (o.dry) picked.push(e);
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
  return record(id, "applied", null, takeHome ? { "Take-home": takeHomeCell(takeHome.url, takeHome.text) } : {});
}

/** Set when a fill was abandoned. Its page connection may still be open, so a command ends the process itself when it is done. */
let abandoned = false;
export const endIfAbandoned = () => {
  if (abandoned) process.exit(process.exitCode ?? 0);
};

/**
 * One go at a form, within RUN.fillTimeoutMs. A form that cannot be opened, or never settles, comes
 * back as blocked. A fill that runs out of time is stopped: its tab is closed, which fails every
 * call it was waiting on, and its signal keeps it from writing a plan or a report over the next attempt.
 */
async function fillOnce(jev: JevClient, profile: Profile, e: QueueEntry, dry = false): Promise<FillReport> {
  const attempt = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const filling = fillJob(jev, forJob(profile, e), asJob(e), { signal: attempt.signal, dry });
  filling.catch(() => undefined);
  try {
    // A form behind a sign-in gets longer: the sign-in and its verification email take their own time.
    const limit = RUN.fillTimeoutMs + (adapterFor(applyUrlFor(asJob(e))) ? ACCOUNTS.signInBudgetMs : 0);
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the form did not finish loading and filling in ${limit / 1000}s`)), limit);
    });
    return await Promise.race([filling, tooLong]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/did not finish loading/.test(message)) {
      attempt.abort(new Error("abandoned"));
      abandoned = true;
      await closeJobTab(e.job.id).catch(() => undefined);
      // The abandoned fill is given a moment to stop, so nothing of it is still running when the form is tried again.
      await Promise.race([filling.catch(() => undefined), sleep(RUN.abortGraceMs)]);
    }
    return saveReport(blockedReport(e.job, message));
  } finally {
    clearTimeout(timer);
  }
}

/** A form whose values did not land on its first page is worth one more go: a page that loaded badly is often fine the second time. */
const worthAnotherGo = (r: FillReport) => r.state === "filled" && r.page === 1 && !r.stuck && r.failed.length > 0;

/** Settles what JEV left open on the page a job's tab shows: from the answer memory, or by Claude. A writer error leaves the form as it was. */
export async function resolvePage(jev: JevClient, profile: Profile, entry: QueueEntry | null, r: FillReport, fresh: boolean): Promise<FillReport> {
  try {
    return await resolveJob(forJob(profile, entry), entry, r.jobId, { jev, fresh });
  } catch (err) {
    return { ...r, ready: false, reason: `writer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** True when a job waits at a sign-in and not at a filled form: its last report says so. */
function waitsAtSignIn(id: string): boolean {
  try {
    return !!loadReport(id).auth;
  } catch {
    return false;
  }
}

const CODE_REASON = "the board emailed you a code to confirm a person is applying. The filled form is open in the tool's window";
const ROBOT_REASON = "the site asks you to confirm you are not a robot. The filled form is open in the tool's window";
const UNKNOWN_REASON = "Submit was clicked and no confirmation was seen";

/** Keeps a job's tab for later, with why: it waits for the person, or for a confirmation. */
const keepTab = (id: string, state: "awaiting_user_action" | "awaiting_email_verification" | "submission_unknown") =>
  mutateSession((s) => {
    const tab = s[id];
    if (tab) s[id] = { ...tab, state, since: new Date().toISOString() };
  });

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

/**
 * Sends one ready form and records what the page became. True when the application went through.
 *
 * From the moment of the click the application may be with the employer, so the job is recorded as
 * unconfirmed first, and only then settled: sent, waiting on the person, refused, or positively not
 * sent. If anything fails after the click, it stays unconfirmed with its tab open, and it is never
 * filled or sent again until `reconcile` or the person settles it.
 */
export function submitAndRecord(jev: JevClient, id: string, force: boolean, keepOpen = false): Promise<boolean> {
  return perSite(siteOf(id), () =>
    oneAtATime(async () => {
      let clicked = false;
      const close = async () => {
        if (!keepOpen) await closeJobTab(id);
      };
      try {
        const r = await submitJob(jev, id, {
          force,
          onClick: () => {
            clicked = true;
            record(id, "submission_unknown", UNKNOWN_REASON);
            keepTab(id, "submission_unknown");
          },
        });
        console.log(`${id}  ${r.needsCode ? "needs your code" : r.humanCheck ? "needs you to pass a robot check" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
        if (r.state === "submitted") {
          recordApplied(id);
          await close();
          return true;
        }
        if (r.needsCode || r.humanCheck) {
          // Only the person can pass a human check. The form stays open for them, they are told, and the run moves on.
          const waitingFor = r.needsCode ? "human_code" : "robot_check";
          const e = record(id, "awaiting_user_action", r.needsCode ? CODE_REASON : ROBOT_REASON, {}, waitingFor);
          keepTab(id, "awaiting_user_action");
          if (r.needsCode) learn(r.url, { emailsCode: true });
          assist(e.job, waitingFor, r.url);
          console.log(`  left open for you: ${waitingWords(waitingFor)}. Then run: npx jev resume`);
          return false;
        }
        if (r.refused) {
          // The company takes one application per person for now. Nothing to hold: the job is skipped with the board's own words.
          record(id, "skipped", "the board refused a second application: you recently applied to this company");
          console.log("  the board refused a second application to this company");
          await close();
          return false;
        }
        if (r.errors.length) console.log(`  errors: ${r.errors.join(" | ")}`);
        console.log(`  page: ${r.excerpt}`);
        if (r.state === "application_form" && (r.errors.length > 0 || r.formStillOpen)) {
          // The form is still there with its Submit control: the click did not send it.
          record(id, "needs_review", `not sent: the form is still open after Submit${r.errors.length ? ` (${r.errors.slice(0, 3).join("; ").slice(0, 160)})` : ""}`);
          await close();
          return false;
        }
        // Neither a confirmation nor the form: the application may or may not be with the employer.
        record(id, "submission_unknown", `${UNKNOWN_REASON}: the page became ${r.state}`);
        console.log(`  not confirmed. The tab stays open. To settle it: npx jev reconcile ${id}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (clicked) {
          console.log(`${id}  not confirmed: ${message}. The tab stays open. To settle it: npx jev reconcile ${id}`);
        } else {
          // Nothing was clicked: the form was not ready, or its tab is gone. It is listed for the person with the reason.
          console.log(`${id}  not sent: ${message}`);
          try {
            record(id, "needs_review", `not sent: ${message.slice(0, 200)}`);
          } catch {
            /* a job that is not in the queue has nothing to record */
          }
          await close().catch(() => undefined);
        }
      }
      return false;
    }),
  );
}

/**
 * Settles a job whose Submit was clicked with no confirmation seen, by reading what its tab shows
 * now. A confirmation records the application. The form itself, still open, means it was not sent.
 * Anything else, or no tab, proves nothing, and the job stays unconfirmed for the person to settle.
 */
export async function reconcile(jev: JevClient, id: string): Promise<"applied" | "not_sent" | "unknown"> {
  if (!(await hasOpenTab(id))) return "unknown";
  const r = await checkJob(jev, id);
  if (r.state === "submitted") {
    recordApplied(id);
    await closeJobTab(id);
    return "applied";
  }
  if (r.state === "application_form" && r.formStillOpen) {
    record(id, "needs_review", "not sent: the form is still open after Submit");
    await closeJobTab(id);
    return "not_sent";
  }
  return "unknown";
}

/**
 * Watches a form that waits on the person while they finish it, and records the application when
 * the confirmation shows. Nothing is typed or clicked. A form whose tab is gone goes to the by-hand list.
 */
export async function resume(jev: JevClient, id: string, opts: { stop?: () => boolean } = {}): Promise<"applied" | "still_waiting" | "gone" | "signed_in" | "retry"> {
  if (!(await hasOpenTab(id))) {
    record(id, "needs_review", "the form that was left open for you is closed. Apply by hand, or run: npx jev apply " + id + " --submit");
    return "gone";
  }
  if (waitsAtSignIn(id)) {
    // The job waits at a sign-in. Once the tab shows the application, the job goes back to the queue to be filled.
    const entry = loadQueue().entries.find((e) => e.job.id === id) as QueueEntry;
    const url = applyUrlFor(asJob(entry));
    const seen = async () => {
      const page = await pageFor(id);
      try {
        return await signedInNow(page, url).catch(() => false);
      } finally {
        page.close();
      }
    };
    if (await seen()) {
      record(id, "queued", null);
      return "signed_in";
    }
    // What the person did somewhere else (a link clicked in their own mail, a sign-out) never shows in this tab.
    // The sign-in is the only thing that can find it out, so it is run again, unless the account is paused.
    const elsewhere = entry.status === "awaiting_email_verification" || entry.waitingFor === "email_link" || entry.waitingFor === "login";
    if (elsewhere && capabilityFor(url)?.verdict === "can") {
      record(id, "queued", null);
      return "retry";
    }
    const deadline = Date.now() + RUN.resumeWaitMs;
    while (Date.now() < deadline && !opts.stop?.()) {
      await sleep(ACCOUNTS.stepMs);
      if (await seen()) {
        record(id, "queued", null);
        return "signed_in";
      }
    }
    return "still_waiting";
  }
  if ((await watchForConfirmation(jev, id, { timeoutMs: RUN.resumeWaitMs, ...(opts.stop ? { stop: opts.stop } : {}) })) === "submitted") {
    recordApplied(id);
    await closeJobTab(id);
    return "applied";
  }
  return "still_waiting";
}

/**
 * Tidies what an interrupted run left: a job a run owned, with no run alive, goes back to the queue
 * if its tab is gone; a form kept open for the person longer than any session lasts goes to the by-hand list.
 */
export async function sweep(): Promise<void> {
  const session = loadSession();
  const old = Date.now() - RUN.waitingExpiryHours * 60 * 60_000;
  const q = loadQueue();
  for (const e of q.entries) {
    const tab = session[e.job.id];
    if (RUN_OWNED.includes(e.status)) {
      if (!tab || !(await hasOpenTab(e.job.id))) record(e.job.id, "queued", null);
    } else if ((e.status === "awaiting_user_action" || e.status === "awaiting_email_verification") && (!tab || Date.parse(tab.since ?? "") < old || !(await hasOpenTab(e.job.id)))) {
      record(e.job.id, "needs_review", `${e.statusReason ?? "it waited for you"}. It was left open too long and is closed now: apply by hand`);
      await closeJobTab(e.job.id).catch(() => undefined);
    }
  }
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
    r = await nextPage(jev, forJob(profile, e), asJob(e), { dry: o.dry });
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
  const rec = record(r.jobId, outcome.action, outcome.reason, {}, outcome.waitingFor ?? null);
  if (outcome.action === "awaiting_user_action" || outcome.action === "awaiting_email_verification") {
    // A sign-in only the person can finish: the page stays open for them, they are told, and the run moves on.
    const waitingFor = outcome.waitingFor ?? (outcome.action === "awaiting_email_verification" ? "email_link" : "unknown");
    keepTab(r.jobId, outcome.action);
    assist(rec.job, waitingFor, r.url);
    console.log(`  left open for you: ${waitingWords(waitingFor)}. Then run: npx jev resume`);
    return false;
  }
  if (outcome.rememberSite) rememberWalledHost(rec.job.url);
  // A form the tool cannot finish is closed in a sending run: it is on the by-hand list with its link.
  if (outcome.action !== "needs_review" || o.submit) await closeJobTab(r.jobId);
  return outcome.action === "applied";
}

export async function pipeline(entries: QueueEntry[], o: RunOptions): Promise<{ reports: FillReport[]; sent: string[] }> {
  const profile = loadProfile();
  const jev = new JevClient();
  await ensureBrowser();
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
    const first = await fillOnce(jev, profile, e, o.dry);
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
      const first = await fillOnce(jev, profile, e, o.dry);
      await finish(e, o.fillOnly ? first : await walk(jev, profile, e, first, o));
    } catch (err) {
      console.log(`${e.job.id}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { reports, sent };
}
