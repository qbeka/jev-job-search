/**
 * What becomes of a job after its form was filled and resolved, before
 * anything is sent. The rules are the person's: a site that wants a sign-in,
 * a form that asks for a signature, and a question the profile cannot answer
 * are not worked around. The job is set aside for them with the reason.
 */
import { SIGN_IN_REASON, type FillReport } from "../browser/report.js";
import type { QueueEntry } from "../jobs/queue.js";

export type Outcome = {
  /** send: the form is ready. Anything else is the status the job is recorded with. */
  action: "send" | QueueEntry["status"];
  reason: string | null;
  /** The job's site put a sign-in in front of the form: the next discover skips that site. */
  rememberSite: boolean;
};

/** One line that says why a filled form is not ready, for the record. */
export function notReady(r: FillReport): string {
  if (r.resolution && r.resolution.verdict !== "ready" && r.resolution.reason) return r.resolution.reason;
  const open = [
    ...r.missingRequired.map((l) => `empty: ${l.slice(0, 60)}`),
    ...r.failed.map((f) => (/^(the form did not move on|could not tell that)/.test(f.why) ? f.why : `did not land: ${f.label.slice(0, 60)}`)),
    ...r.reviews.map((x) => `${x.why.startsWith("signing") ? "asks for a signature" : "unsure"}: ${x.label.slice(0, 60)}`),
    ...r.drafts.map((x) => `unwritten: ${x.label.slice(0, 60)}`),
  ];
  const where = r.page > 1 ? `page ${r.page}: ` : "";
  return where + (open.join("; ") || r.reason || "not verified");
}

export function outcomeOf(r: FillReport, maxPages: number): Outcome {
  if (r.sent) return { action: "applied", reason: null, rememberSite: false };
  if (r.state === "blocked") {
    const reason = r.reason ?? "no form found";
    if (reason === SIGN_IN_REASON || /login_required/.test(reason)) return { action: "login_required", reason: SIGN_IN_REASON, rememberSite: true };
    // A posting that has closed is not something the person can do by hand either.
    if (/page looks like: closed/.test(reason)) return { action: "skipped", reason: "the posting has closed", rememberSite: false };
    return { action: "blocked", reason, rememberSite: /page looks like: job_description/.test(reason) };
  }
  if (r.resolution?.verdict === "skip") return { action: "skipped", reason: r.resolution.reason, rememberSite: false };
  if (r.ready) return { action: "send", reason: null, rememberSite: false };
  if (r.hasNext && r.page >= maxPages && !r.failed.length && !r.missingRequired.length) return { action: "needs_review", reason: `the form runs over more than ${maxPages} pages`, rememberSite: false };
  return { action: "needs_review", reason: notReady(r), rememberSite: false };
}
