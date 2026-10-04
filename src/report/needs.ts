/**
 * What waits for the person, as the dashboard shows it: forms that are open for them, questions
 * a form asked that the profile could not answer, submissions that were never confirmed, and
 * emails the tool could not place. Also the two things the page can do about them: save an
 * answer, and bring a form to the front.
 */
import { readFileSync } from "node:fs";
import { BROWSER, PATHS } from "../config.js";
import { loadReport } from "../browser/report.js";
import { loadSession } from "../browser/session.js";
import { categoryOf } from "../forms/mapForm.js";
import { mutateQueue, updateEntry, type QueueEntry } from "../jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { loadInbox } from "../mail/status.js";
import { ProfileSchema } from "../profile/schema.js";
import { mailSearchUrl, waitingWords } from "../run/assist.js";
import { withStore, writeAtomic } from "../util/store.js";

/** ask: the person can answer it here. profile: it comes from the profile and is changed there. sign: it is theirs to do by hand, on the form. */
export type Question = { question: string; kind: "ask" | "profile" | "sign"; options: string[]; canRemember: boolean; note: string };

export type Needs = {
  waiting: { id: string; company: string; title: string; todo: string; reason: string; mail: string | null; open: boolean }[];
  questions: { id: string; company: string; title: string; link: string; reason: string; items: Question[] }[];
  unconfirmed: { id: string; company: string; title: string; link: string }[];
  mail: { id: string; from: string; subject: string; on: string; kind: string | null; why: string; jobs: { id: string; company: string; title: string }[] }[];
};

const PLACEHOLDER = /^(select|select\.\.\.|select an option|select one|please select|choose|choose one|-+)?$/i;

/** What kind of question a label is, and whether an answer to it may be kept for other forms. */
export function questionFor(label: string, kind: string, options: string[], why: string): Question {
  const category = categoryOf({ label, section: "", hint: "", kind: kind as never });
  const choices = options.filter((o) => !PLACEHOLDER.test(o.trim()));
  if (/^signing/.test(why)) return { question: label, kind: "sign", options: [], canRemember: false, note: "This asks for your signature. Open the form and sign it yourself." };
  // The right to work is one answer per country, held in the profile. It is never answered form by form.
  if (category === "authorization" || category === "sponsorship") return { question: label, kind: "profile", options: [], canRemember: false, note: "Your profile does not say this for the job's country. Add it with /profile; it is the same for every form in that country and is never answered one form at a time." };
  if (category === "contact_other") return { question: label, kind: "sign", options: [], canRemember: false, note: "This asks for another person's details. Open the form and give them yourself." };
  return { question: label, kind: "ask", options: choices, canRemember: true, note: "" };
}

export function buildNeeds(entries: QueueEntry[], o: { report?: typeof loadReport; inboxFile?: string } = {}): Needs {
  const report = o.report ?? loadReport;
  const session = loadSession();
  const brief = (e: QueueEntry) => ({ id: e.job.id, company: e.job.company, title: e.job.title });
  const needs: Needs = { waiting: [], questions: [], unconfirmed: [], mail: [] };
  for (const e of entries) {
    if (e.status === "awaiting_user_action" || e.status === "awaiting_email_verification") {
      const w = e.waitingFor ?? (e.status === "awaiting_email_verification" ? "email_link" : "unknown");
      let host = "";
      try {
        host = new URL(session[e.job.id]?.url ?? e.job.url).hostname;
      } catch {
        host = "";
      }
      needs.waiting.push({ ...brief(e), todo: waitingWords(w), reason: e.statusReason ?? "", mail: (w === "human_code" || w === "email_link") && host ? mailSearchUrl(host) : null, open: !!session[e.job.id] });
    } else if (e.status === "submission_unknown") {
      needs.unconfirmed.push({ ...brief(e), link: e.job.url });
    } else if (e.status === "needs_review") {
      let items: Question[] = [];
      try {
        const r = report(e.job.id);
        const seen = new Set<string>();
        for (const v of r.reviews) {
          if (seen.has(v.label)) continue;
          seen.add(v.label);
          items.push(questionFor(v.label, v.kind, v.options, v.why));
        }
        for (const d of r.drafts) if (!seen.has(d.label)) items.push(questionFor(d.label, "textarea", [], ""));
      } catch {
        items = [];
      }
      if (items.length) needs.questions.push({ ...brief(e), link: e.job.url, reason: e.statusReason ?? "", items });
    }
  }
  const byId = new Map(entries.map((e) => [e.job.id, e]));
  const applied = entries.filter((e) => e.status === "applied" || e.status === "submission_unknown");
  for (const m of loadInbox(o.inboxFile).review) {
    const named = m.jobIds.map((id) => byId.get(id)).filter((e): e is QueueEntry => !!e);
    // With no application named, the person picks among the ones at companies the sender or subject mentions.
    const jobs = (named.length ? named : applied.filter((e) => `${m.from} ${m.subject}`.toLowerCase().includes(e.job.company.toLowerCase()))).slice(0, 8).map(brief);
    needs.mail.push({ id: m.id, from: m.from, subject: m.subject, on: new Date(m.receivedAt).toISOString().slice(0, 10), kind: m.kind, why: m.why, jobs });
  }
  return needs;
}

export type Answer = { question: string; answer: string; remember: boolean };

/**
 * Saves the person's answers to a job's open questions and puts the job back in the queue. An
 * answer they asked to keep becomes a standing answer in the profile; the rest belong to this one
 * job. A question about the right to work is refused here: that is the profile's, per country.
 */
export function saveAnswers(id: string, answers: Answer[], files: { profile?: string; queue?: string; rows?: string } = {}): { company: string; title: string; kept: number } {
  const clean = answers.map((a) => ({ question: a.question.trim().slice(0, 700), answer: a.answer.trim().slice(0, 4000), remember: a.remember })).filter((a) => a.question && a.answer);
  for (const a of clean) if (questionFor(a.question, "text", [], "").kind !== "ask") throw new Error("that question is not one to answer here");
  const keep = clean.filter((a) => a.remember);
  return withStore(() => {
    if (keep.length) {
      const file = files.profile ?? PATHS.profile;
      const raw = JSON.parse(readFileSync(file, "utf8")) as { answers?: { question: string; answer: string }[] };
      const rest = (raw.answers ?? []).filter((x) => !keep.some((k) => k.question === x.question));
      const next = { ...raw, answers: [...rest, ...keep.map(({ question, answer }) => ({ question, answer }))] };
      // The profile is only ever written whole and valid.
      ProfileSchema.parse(next);
      writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    }
    const e = mutateQueue((q) => {
      const was = q.entries.find((x) => x.job.id === id);
      if (!was) throw new Error(`No queue entry with id ${id}`);
      const mine = clean.filter((a) => !a.remember).map(({ question, answer }) => ({ question, answer }));
      const others = (was.answers ?? []).filter((x) => !clean.some((k) => k.question === x.question));
      return updateEntry(q, id, { answers: [...others, ...mine], status: "queued", statusReason: null, waitingFor: null });
    }, files.queue);
    saveRows(upsertEntry(loadRows(files.rows), e), files.rows);
    return { company: e.job.company, title: e.job.title, kept: keep.length };
  });
}

/** Brings the tab a job's form is open in to the front of the tool's Chrome window. False when it is not open. */
export async function showForm(id: string): Promise<boolean> {
  const tab = loadSession()[id];
  if (!tab) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${BROWSER.port}/json/activate/${tab.targetId}`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
