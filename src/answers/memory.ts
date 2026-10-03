/**
 * The answer memory: data/memory.json, git-ignored. Every answer the writer
 * gives is kept, so a question that was answered once is not paid for again.
 *
 * - The same form again (a rehearsal, then the real run): the whole
 *   resolution is reused, so what was read in the rehearsal is what is sent.
 * - The same question on another company's form: the answer is reused when
 *   the writer marked it as true for any company and the form offers it.
 * - A question worded differently: JEV decides whether it asks for the same
 *   thing, and only a confident yes reuses the answer.
 *
 * Every entry carries a fingerprint of the candidate's context. When the
 * profile, the drafts or the voice guide change, older entries stop
 * matching, so a corrected profile is never overruled by a remembered answer.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "../util/store.js";
import { z } from "zod";
import { MEMORY, PATHS } from "../config.js";
import type { JevClient } from "../jev/client.js";
import { choice } from "../jev/questions.js";
import type { ChoiceAnswer, Questions } from "../jev/types.js";

/** A field still open on a form, as the writer and the memory both see it. */
export type OpenField = {
  selector: string;
  kind: string;
  label: string;
  /** For a checkbox or a radio option: the question it belongs to. */
  question: string;
  hint: string;
  required: boolean;
  maxLength: number | null;
  options: string[];
  /** Why it is open: a draft, a review, or the reason a value did not land. */
  why: string;
};

export const Resolution = z.object({
  /** ready: every open field is answered or rightly left blank. needs_review: a required field cannot be answered truthfully. skip: the job should not be applied to. */
  verdict: z.enum(["ready", "needs_review", "skip"]),
  reason: z.string().default(""),
  answers: z
    .array(
      z.object({
        selector: z.string(),
        value: z.string(),
        /** True when the same value answers the same question on any other company's form. */
        reusable: z.boolean().default(false),
      }),
    )
    .default([]),
  /** The two cells of the tracking sheet, written while the posting is already being read. */
  note: z.object({ what_they_do: z.string().default(""), why_fit: z.string().default("") }).optional(),
});
export type Resolution = z.infer<typeof Resolution>;

const Remembered = z.object({
  /** The kind of control and the question, normalized, with the company's name masked. */
  key: z.string(),
  question: z.string(),
  value: z.string(),
  company: z.string(),
  jobId: z.string(),
  fingerprint: z.string(),
  at: z.string(),
});
export type Remembered = z.infer<typeof Remembered>;

const FormMemory = z.object({
  fingerprint: z.string(),
  /** A hash of the open fields the resolution answered. */
  openKey: z.string(),
  /** The same hash per field, so an answer can be reused when only some of the open fields changed. */
  fields: z.record(z.string()).default({}),
  company: z.string(),
  at: z.string(),
  resolution: Resolution,
});

export const MemoryFile = z.object({
  version: z.literal(1).default(1),
  forms: z.record(FormMemory).default({}),
  answers: z.array(Remembered).default([]),
});
export type MemoryFile = z.infer<typeof MemoryFile>;

/** Where a reused answer came from, for the report a person reads. */
export type Recalled = { value: string; reusable: boolean; source: "same form" | "same question" | "similar question"; from: string };

export function loadMemory(file = PATHS.memory): MemoryFile {
  if (!existsSync(file)) return MemoryFile.parse({});
  try {
    return MemoryFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A memory that cannot be read is an empty memory: the writer is asked again.
    return MemoryFile.parse({});
  }
}

export function saveMemory(mem: MemoryFile, file = PATHS.memory): void {
  writeAtomic(file, JSON.stringify(mem, null, 1));
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}{} ]+/gu, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** text, choice or checkbox: answers are only reused between controls that take the same kind of value. */
export function kindClass(f: Pick<OpenField, "kind" | "options">): "text" | "choice" | "checkbox" {
  if (f.kind === "checkbox") return "checkbox";
  if (f.kind === "select" || f.kind === "radio" || f.kind === "combobox" || f.options.length) return "choice";
  return "text";
}

/** The question a field asks, with the company's name replaced by a placeholder so "worked at Acme before?" is one question everywhere. */
export function questionOf(f: Pick<OpenField, "label" | "question">, company: string): string {
  const text = f.question && f.question !== f.label ? `${f.question} / ${f.label}` : f.label;
  const name = company.trim();
  return (name.length > 1 ? text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, "giu"), "{company}") : text).replace(/\s+/g, " ").trim();
}

export const keyOf = (f: OpenField, company: string) => `${kindClass(f)}:${norm(questionOf(f, company))}`;

const fieldKey = (f: OpenField) => sha(JSON.stringify([f.selector, f.kind, f.label, f.question, f.required, f.maxLength, f.options]));

export function openKey(open: OpenField[]): string {
  return sha(open.map(fieldKey).sort().join(" "));
}

/** A fingerprint of everything the writer is told about the candidate. */
export const fingerprintOf = (context: string) => sha(context);

/** The remembered value as this field can take it, or null when it cannot: an option the form does not offer, or text longer than the box. */
export function fits(value: string, f: OpenField): string | null {
  const kind = kindClass(f);
  if (kind === "checkbox") return /^(true|false)$/i.test(value) ? value.toLowerCase() : null;
  if (kind === "choice") {
    if (!f.options.length) return value;
    return f.options.find((o) => norm(o) === norm(value)) ?? null;
  }
  return f.maxLength === null || value.length <= f.maxLength ? value : null;
}

/** The whole resolution of this form from last time, when the candidate's context and the open fields are both unchanged. */
export function recallForm(mem: MemoryFile, jobId: string, fingerprint: string, open: OpenField[]): Resolution | null {
  const m = mem.forms[jobId];
  return m && m.fingerprint === fingerprint && m.openKey === openKey(open) ? m.resolution : null;
}

/**
 * When the same form comes back with other fields open (JEV was sure of one this time and unsure
 * of another), the answers it got last time are reused field by field, and only what is new is
 * asked. This is done only if last time ended ready: a form that was held is judged whole again.
 */
export function recallSameFields(mem: MemoryFile, jobId: string, fingerprint: string, open: OpenField[]): Map<string, Recalled> {
  const hits = new Map<string, Recalled>();
  const m = mem.forms[jobId];
  if (!m || m.fingerprint !== fingerprint || m.resolution.verdict !== "ready") return hits;
  for (const f of open) {
    const a = m.resolution.answers.find((x) => x.selector === f.selector);
    const value = a && m.fields[f.selector] === fieldKey(f) ? fits(a.value, f) : null;
    if (a && value !== null) hits.set(f.selector, { value, reusable: a.reusable, source: "same form", from: m.company });
  }
  return wholeGroupsOnly(hits, open);
}

/** Answers to exactly these questions, given before on any form. */
export function recallExact(mem: MemoryFile, fingerprint: string, company: string, open: OpenField[]): Map<string, Recalled> {
  const hits = new Map<string, Recalled>();
  const byKey = new Map(mem.answers.filter((a) => a.fingerprint === fingerprint).map((a) => [a.key, a]));
  for (const f of open) {
    const a = byKey.get(keyOf(f, company));
    const value = a ? fits(a.value, f) : null;
    if (a && value !== null) hits.set(f.selector, { value, reusable: true, source: "same question", from: a.company });
  }
  return wholeGroupsOnly(hits, open);
}

/**
 * A group of checkboxes is one question. It is answered from memory only when every box in it is,
 * so a remembered tick is never combined with boxes nobody has decided.
 */
function wholeGroupsOnly(hits: Map<string, Recalled>, open: OpenField[]): Map<string, Recalled> {
  const boxes = open.filter((f) => f.kind === "checkbox" && f.question);
  for (const question of new Set(boxes.map((f) => f.question))) {
    const group = boxes.filter((f) => f.question === question);
    if (group.some((f) => !hits.has(f.selector))) for (const f of group) hits.delete(f.selector);
  }
  return hits;
}

const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
/** The share of the shorter question's words that the other one has too. */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** For each open field, the remembered questions worth showing JEV: the same kind of control, a value the field can take, closest wording first. */
export function candidatesFor(mem: MemoryFile, fingerprint: string, company: string, f: OpenField): Remembered[] {
  if (kindClass(f) === "checkbox") return [];
  const q = questionOf(f, company);
  return mem.answers
    .filter((a) => a.fingerprint === fingerprint && a.key.startsWith(`${kindClass(f)}:`) && fits(a.value, f) !== null)
    .map((a) => ({ a, score: overlap(q, a.question) }))
    .filter((x) => x.score >= MEMORY.minWordOverlap)
    .sort((x, y) => y.score - x.score)
    .slice(0, MEMORY.candidates)
    .map((x) => x.a);
}

/** The question JEV is asked about one open field: which remembered question, if any, is the same question. */
export function sameQuestion(asked: string, candidates: Remembered[]) {
  return choice(`Which of the earlier questions asks for exactly the same information as this question on a job application form: "${asked}"?`, {
    ...Object.fromEntries(candidates.map((c, i) => [`q${i}`, `The earlier question "${c.question}". Choose it only if one and the same answer is a complete and correct answer to both questions.`])),
    none: "No earlier question is the same. The new question asks for something else, or it names a different country, place, technology, period or condition, or one is phrased in the negative and the other is not, or it wants a different length or level of detail.",
  });
}

/** Answers to questions JEV is confident are the same as remembered ones, for the fields exact matching left open. */
export async function recallSimilar(jev: JevClient, mem: MemoryFile, fingerprint: string, company: string, open: OpenField[], label = "same-question"): Promise<Map<string, Recalled>> {
  const hits = new Map<string, Recalled>();
  const asked = new Map<string, { f: OpenField; candidates: Remembered[] }>();
  const questions: Questions = {};
  open.forEach((f, i) => {
    const candidates = candidatesFor(mem, fingerprint, company, f);
    if (!candidates.length) return;
    asked.set(`f${i}`, { f, candidates });
    questions[`f${i}`] = sameQuestion(questionOf(f, company), candidates);
  });
  if (!asked.size) return hits;
  const answers = await jev.decide({ task: "Match each new application-form question to an earlier question that asks for exactly the same information, or to none." }, questions, label);
  for (const [id, { f, candidates }] of asked) {
    const a = answers[id] as ChoiceAnswer;
    const picked = /^q\d+$/.test(a.choice) ? candidates[Number(a.choice.slice(1))] : undefined;
    const value = picked ? fits(picked.value, f) : null;
    if (picked && value !== null && a.confidence >= MEMORY.sameQuestionConfidence) hits.set(f.selector, { value, reusable: true, source: "similar question", from: picked.company });
  }
  return hits;
}

/**
 * Keeps what the writer just decided. The whole resolution is kept for this form. An answer is
 * kept for other forms only when the writer marked it reusable and the page showed it afterwards
 * (a checkbox left unticked shows nothing, and that is its answer).
 */
export function remember(mem: MemoryFile, args: { jobId: string; company: string; fingerprint: string; open: OpenField[]; resolution: Resolution; landed: (selector: string) => boolean; recalled?: Set<string>; at?: string }): MemoryFile {
  const at = args.at ?? new Date().toISOString();
  mem.forms[args.jobId] = { fingerprint: args.fingerprint, openKey: openKey(args.open), fields: Object.fromEntries(args.open.map((f) => [f.selector, fieldKey(f)])), company: args.company, at, resolution: args.resolution };
  for (const a of args.resolution.answers) {
    const f = args.open.find((x) => x.selector === a.selector);
    // Only what the writer itself wrote is kept for other forms. An answer that was recalled is not
    // stored again under the new wording, so one judgement of "same question" never builds on another.
    if (!f || !a.reusable || args.recalled?.has(a.selector)) continue;
    const unticked = f.kind === "checkbox" && !/^true$/i.test(a.value);
    if (!unticked && !args.landed(a.selector)) continue;
    const entry: Remembered = { key: keyOf(f, args.company), question: questionOf(f, args.company), value: f.kind === "checkbox" ? String(/^true$/i.test(a.value)) : a.value, company: args.company, jobId: args.jobId, fingerprint: args.fingerprint, at };
    const i = mem.answers.findIndex((x) => x.key === entry.key && x.fingerprint === entry.fingerprint);
    if (i >= 0) mem.answers[i] = entry;
    else mem.answers.push(entry);
  }
  return mem;
}

/** Drops what can no longer match: entries written for an earlier version of the candidate's context. */
export function prune(mem: MemoryFile, fingerprint: string): MemoryFile {
  return { version: 1, forms: Object.fromEntries(Object.entries(mem.forms).filter(([, m]) => m.fingerprint === fingerprint)), answers: mem.answers.filter((a) => a.fingerprint === fingerprint) };
}
