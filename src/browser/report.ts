/**
 * What a fill produced: the report a person reads, the plan a later step
 * needs, and the rules that say whether a form may be sent. Nothing here
 * touches the browser, so every rule is tested offline.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "../util/store.js";
import { showsValue } from "../util/dates.js";
import path from "node:path";
import { FORM, PATHS } from "../config.js";
import type { FieldsDump, FillPlan } from "../forms/fields.js";
import type { Resolution } from "../answers/memory.js";
import type { ControlState } from "./session.js";
import type { WaitingFor } from "../jobs/queue.js";

export type Fill = { selector: string; kind: string; value: string };
export type FieldReport = { label: string; required: boolean; action: string; shown: string; note: string | null };
export type TakeHome = { text: string; url: string };
export type FillReport = {
  jobId: string;
  /** A take-home assignment the form mentions, with its link. */
  takeHome?: TakeHome[];
  company: string;
  title: string;
  ats: string;
  url: string;
  state: "filled" | "blocked";
  reason: string | null;
  /** Set when the form sits behind a sign-in the tool could not finish: what the job waits for. */
  auth?: { status: "login_required" | "awaiting_user_action" | "awaiting_email_verification" | "queued"; waitingFor: WaitingFor | null };
  fields: FieldReport[];
  drafts: FillPlan["drafts"];
  reviews: FillPlan["reviews"];
  failed: { selector: string; label: string; why: string }[];
  /** Optional fields the tool wanted to answer, could not, and left empty. They do not hold the form. */
  leftBlank: { selector: string; label: string; why: string }[];
  missingRequired: string[];
  /** True when nothing is left open: every wanted value is on the page and no required field is empty. Only a ready form may be submitted. */
  ready: boolean;
  /** What Claude decided about the fields JEV left open, once resolve has run. */
  resolution?: Resolution;
  /** How many of those answers came from the answer memory, and whether Claude had to be asked at all. */
  recalled?: number;
  writerCalled?: boolean;
  /** Which page of the form this report describes. A one-page form is page 1. */
  page: number;
  /** The fields of the pages before this one, as they were left. */
  earlier: FieldReport[];
  /** True when this page has a Next or Continue button and no Submit: the form goes on. */
  hasNext: boolean;
  /** Set when the form's Next was clicked and the form did not move: what the page said. Such a form is not clicked again. */
  stuck?: string;
  /** True when moving to the next page sent the application: the button that looked like Next was the last one. */
  sent?: boolean;
  seconds: number;
  jevCostUsd: number;
};

const reportFile = (jobId: string) => path.join(PATHS.runs, `${jobId}.report.json`);
const planFile = (jobId: string) => path.join(PATHS.runs, `${jobId}.plan.json`);

export function saveReport(r: FillReport): FillReport {
  writeAtomic(reportFile(r.jobId), JSON.stringify(r, null, 2));
  return r;
}

export function loadReport(jobId: string): FillReport {
  if (!existsSync(reportFile(jobId))) throw new Error(`No fill report for job ${jobId}. Run fill first.`);
  const r = JSON.parse(readFileSync(reportFile(jobId), "utf8")) as FillReport;
  // A report written before forms had pages is a one-page form.
  return { ...r, page: r.page ?? 1, earlier: r.earlier ?? [], hasNext: r.hasNext ?? false, leftBlank: r.leftBlank ?? [] };
}

/** The dump and the plan of the page a job's tab shows, kept for the steps after the fill. */
export function savePlan(jobId: string, dump: FieldsDump, plan: FillPlan): void {
  writeAtomic(planFile(jobId), JSON.stringify({ dump, plan }, null, 2));
}

export function loadPlan(jobId: string): { dump: FieldsDump; plan: FillPlan } {
  return JSON.parse(readFileSync(planFile(jobId), "utf8")) as { dump: FieldsDump; plan: FillPlan };
}

/**
 * What changed on a page between two reads of it. A question that appears once another is answered
 * pushes the controls below it down, so a control found by its position gets a new selector, and
 * its old selector may now name another control. Controls are therefore told apart by what they
 * are (kind, label, name), in the order they appear, never by their selector alone.
 * moved: old selector to new, for controls that are still there under another selector.
 * fresh: controls that were not there before.
 */
export function comparePages(before: FieldsDump, after: FieldsDump): { moved: Map<string, string>; fresh: FieldsDump["fields"] } {
  const identity = (f: FieldsDump["fields"][number]) => `${f.kind}|${f.label}|${f.name}`;
  const earlier = new Map<string, string[]>();
  for (const f of before.fields) earlier.set(identity(f), [...(earlier.get(identity(f)) ?? []), f.selector]);
  const moved = new Map<string, string>();
  const fresh: FieldsDump["fields"] = [];
  const unmatched: FieldsDump["fields"] = [];
  for (const f of after.fields) {
    const was = earlier.get(identity(f))?.shift();
    if (was === undefined) unmatched.push(f);
    else if (was !== f.selector) moved.set(was, f.selector);
  }
  // A control that kept its selector and only changed its words (a file box that now names the file, a box whose
  // generated name changed) is the same control, not a new one.
  const leftOver = new Set([...earlier.values()].flat());
  const kindOf = new Map(before.fields.map((f) => [f.selector, f.kind]));
  for (const f of unmatched) if (!(leftOver.has(f.selector) && kindOf.get(f.selector) === f.kind)) fresh.push(f);
  return { moved, fresh };
}

/** A report for a job whose form could not be opened or filled at all. */
export function blockedReport(job: { id: string; company: string; title: string; ats: string; url: string }, reason: string, url = job.url, seconds = 0): FillReport {
  return { jobId: job.id, company: job.company, title: job.title, ats: job.ats, url, state: "blocked", reason, fields: [], drafts: [], reviews: [], failed: [], leftBlank: [], missingRequired: [], ready: false, page: 1, earlier: [], hasNext: false, seconds, jevCostUsd: 0 };
}

/**
 * Required fields the page shows empty. A group of checkboxes that share a name is one question:
 * it is answered once any box in it is ticked, so the unticked ones are not missing.
 */
export function emptyRequiredFields(d: FieldsDump, plan: FillPlan, shown: string[], states: ControlState[]): FillPlan["fields"] {
  // A required group of checkboxes is satisfied by any one tick. The group is the boxes that share a name,
  // or, when each box has a name of its own (Ashby), the boxes under one question.
  const boxes = d.fields.filter((f) => f.kind === "checkbox");
  const groupOf = new Map(boxes.map((f) => [f.selector, f.name && boxes.filter((o) => o.name === f.name).length > 1 ? `name:${f.name}` : f.section ? `question:${f.section}` : ""]));
  const answeredGroups = new Set(plan.fields.filter((f, i) => f.kind === "checkbox" && shown[i]).map((f) => groupOf.get(f.selector)).filter((n): n is string => !!n));
  return plan.fields.filter((f, i) => f.required && !shown[i] && states[i] !== "off" && f.action !== "upload" && !(f.kind === "checkbox" && answeredGroups.has(groupOf.get(f.selector) ?? "")));
}

export const emptyRequired = (d: FieldsDump, plan: FillPlan, shown: string[], states: ControlState[]) => emptyRequiredFields(d, plan, shown, states).map((f) => f.label);

/**
 * True when a control shows what it was given. A box is compared in the shape the site writes it
 * (showsValue); a choice by the option that was picked; a checkbox by whether it is ticked.
 * Anything else only has to show something.
 */
export function showsPlanned(f: { kind: string; value: string | null; optionLabel?: string | null }, shown: string): boolean {
  const value = f.value ?? "";
  const n = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  if (f.kind === "checkbox") return /^(true|yes|1|on|checked)$/i.test(value) ? !!shown : !shown;
  if (f.kind === "radio" || f.kind === "select") {
    const expect = [f.optionLabel, value].filter((x): x is string => !!x);
    return !!shown && expect.some((e) => n(e) === n(shown) || showsValue(e, shown));
  }
  if (["text", "email", "tel", "url", "number", "textarea", "combobox", "date"].includes(f.kind)) return showsValue(value, shown);
  return !!shown;
}

/**
 * The fields that show a value other than the one they were given: by the plan, or by a later
 * answer from the memory or the writer, which replaces the plan's. An empty box is not this.
 */
export function showsAnother(planned: FillPlan["fields"], answers: { selector: string; kind: string; value: string }[], shown: string[], states: ControlState[]): Failure[] {
  return planned.flatMap((f, i) => {
    const now = shown[i] ?? "";
    if (!now || states[i] === "off") return [];
    const answer = answers.find((x) => x.selector === f.selector);
    const want = answer ? { kind: f.kind, value: answer.value } : f.action === "fill" && f.value ? f : null;
    if (!want || showsPlanned(want, now)) return [];
    return [{ selector: f.selector, why: `the page shows "${now.slice(0, 40)}" instead of "${((answer ? null : f.optionLabel) ?? want.value ?? "").slice(0, 40)}"` }];
  });
}

/**
 * A form that was not on screen when it was read back proves nothing: a page drawing itself again,
 * or lying under a dialog, shows every box as switched off. One or two boxes switched off by
 * another answer is the form's own doing; many at once holds the form.
 */
export function notOnScreen(planned: FillPlan["fields"], states: ControlState[]): Failure[] {
  const gone = planned.filter((_, i) => states[i] !== "on").length;
  if (gone <= Math.max(FORM.maxSwitchedOff, Math.floor(planned.length * FORM.switchedOffShare))) return [];
  return [{ selector: "form", why: `${gone} of the form's ${planned.length} boxes were not on screen when the page was read back, so nothing on it is confirmed` }];
}

type Open = Pick<FillReport, "state" | "drafts" | "reviews" | "failed" | "missingRequired">;

/** Nothing is left open on this page: every wanted value is on it and no required field is empty. */
export const isClean = (r: Open) => r.state === "filled" && !r.drafts.length && !r.reviews.length && !r.failed.length && !r.missingRequired.length;

/** A form may be sent only from its last page, and only when that page is clean. */
export const isReady = (r: Open & Pick<FillReport, "hasNext">) => isClean(r) && !r.hasNext;

export const SIGN_IN_REASON = "the site wants a sign-in or an account";

const buttons = (submitSelectors: string[]) => submitSelectors.map((s) => ({ selector: s.split("  /*")[0] ?? s, text: /\/\*\s*(.*?)\s*\*\//.exec(s)?.[1] ?? "" }));

/** The control that sends the form, from the buttons the dump found. English first, then the French a bilingual Canadian form uses. */
export function pickSubmit(submitSelectors: string[]): { selector: string; text: string } | null {
  const candidates = buttons(submitSelectors);
  return candidates.find((c) => /submit|soumettre/i.test(c.text)) ?? candidates.find((c) => /apply|send|finish|postuler|envoyer/i.test(c.text) && !/linkedin|indeed/i.test(c.text)) ?? null;
}

/** The control that leads to the next page, when the page has one and has no way to send. */
export function pickNext(submitSelectors: string[]): { selector: string; text: string } | null {
  if (pickSubmit(submitSelectors)) return null;
  return buttons(submitSelectors).find((c) => /^(next|next step|continue|save and continue|save & continue|save and next)\b/i.test(c.text)) ?? null;
}

export type Failure = { selector: string; why: string };
/**
 * Sorts what did not land into what holds the form and what does not. An optional field that the
 * page shows empty is simply unanswered, which is true and harmless, so it is recorded and the form
 * goes on. Everything else holds the form: a required field, a field that shows some other value,
 * the resume, a field the plan does not know, and a save the form's own server refused.
 */
export function splitFailures(plan: Pick<FillPlan, "fields">, failed: Failure[], shown: string[]): { holds: Failure[]; leftBlank: Failure[] } {
  const holds: Failure[] = [];
  const leftBlank: Failure[] = [];
  for (const given of failed) {
    const i = plan.fields.findIndex((p) => p.selector === given.selector);
    const field = plan.fields[i];
    // A pay box that refuses words wants a number, and the profile gives none: say so instead of "did not land".
    const f = field && /salary|compensation|pay\b/i.test(field.label) && /did not keep|not confirmed/.test(given.why) ? { ...given, why: "the pay box takes only a number, and your profile gives no pay figure" } : given;
    const harmless = !!field && !field.required && !shown[i] && field.action !== "upload" && field.kind !== "file" && !/refused/.test(f.why);
    (harmless ? leftBlank : holds).push(f);
  }
  // One or two optional boxes that would not take a value are a quirk of the form. Many are a fill that went wrong.
  if (leftBlank.length > FORM.maxLeftBlank) return { holds: [...holds, ...leftBlank], leftBlank: [] };
  return { holds, leftBlank };
}
