/**
 * Turns a dumped form into a fill plan with one JEV call per chunk of fields.
 *
 * Text-like fields: a choice over every profile key, bank intent and special
 * key, so the answer is "which value goes here" in one shot.
 * Select, radio and combobox fields: a choice over the field's own options
 * (plus "none") given the candidate's facts, so the answer is the option.
 * Checkboxes: a noul, "should this be checked".
 * File inputs: resume upload, no model needed.
 */
import { FORM, CACHE, PATHS } from "../config.js";
import { hashOf, KeyedCache } from "../util/cache.js";
import { isoOf, shapedForBox, toYmd } from "../util/dates.js";
import type { JevClient } from "../jev/client.js";
import { choice, noul } from "../jev/questions.js";
import type { Answer, ChoiceAnswer, NoulAnswer, Questions } from "../jev/types.js";
import { ALL_KEYS, isProfileKey, isSpecialKey, profileFacts, valueFor, type FieldKey } from "../profile/fieldKeys.js";
import { monthName, type Profile } from "../profile/schema.js";
import { BANK_INTENTS } from "../answers/bank.js";
import { locationTier } from "../jobs/hardFilters.js";
import type { Job } from "../jobs/normalize.js";
import type { DumpedField, FieldsDump, FillPlan, PlannedField } from "./fields.js";
import { documentPolicy, documentsFor, tailorJob } from "../documents/tailor.js";
import { loadQueue } from "../jobs/queue.js";

const NONE = "__none__";

export function buildFormState(profile: Profile, job: Job, dump: FieldsDump, fields: DumpedField[]): Record<string, unknown> {
  const tier = locationTier(job.locations);
  const country = tier === "vancouver" || tier === "canada" ? "Canada" : tier === "us" ? "United States" : tier === "remote" ? "remote (treat as the company's country)" : "unknown";
  return {
    page: { url: dump.url, title: dump.title, context: dump.context },
    job: { company: job.company, title: job.title, locations: job.locations, country },
    candidate: {
      facts: profileFacts(profile),
      work_authorization: {
        citizenships: profile.workAuthorization.citizenships,
        authorized_without_sponsorship_in: profile.workAuthorization.authorizedCountries,
        needs_sponsorship_elsewhere: profile.workAuthorization.requiresSponsorshipElsewhere,
        statement: profile.workAuthorization.statement,
        for_this_job: authForCountry(profile, country),
      },
      education: {
        ...profile.education[0],
        degree_start: `${monthName(profile.education[0]?.startMonth ?? 1)} ${profile.education[0]?.startYear} (month ${profile.education[0]?.startMonth})`,
        degree_end_or_graduation: `${monthName(profile.education[0]?.gradMonth ?? 1)} ${profile.education[0]?.gradYear} (month ${profile.education[0]?.gradMonth})`,
      },
      /** What the candidate has done, so a count or a yes/no about it is answered from the record and not guessed. */
      background: {
        experience: profile.experience.map((e) => ({ company: e.company, title: e.title, location: e.location, start: e.start, end: e.end, current: e.current })),
        internships_and_jobs_held: profile.experience.length,
        projects: profile.projects.map((p) => ({ name: p.name, role: p.role, start: p.start, end: p.end })),
        skills: profile.skills,
        spoken_languages: profile.spokenLanguages,
        notes: profile.facts,
      },
      demographics: profile.demographics,
      preferences: profile.preferences,
      /** The candidate's own answers to recurring questions. They outrank any guess. */
      standing_answers: profile.answers,
      gpa_policy: "Only give a GPA if the field is required. The cumulative GPA is " + (profile.education[0]?.gpa?.cumulative ?? "not provided") + " on a 4.0 scale.",
      rules: [
        `The candidate may work without sponsorship only in: ${profile.workAuthorization.authorizedCountries.join(", ")}. Never claim work authorization anywhere else.`,
        "Never write a cover letter.",
        "Salary expectation is left blank or set to negotiable.",
        "Marketing opt-ins are optional and left unchecked. Consent and acknowledgement boxes required to apply are checked.",
        "A Start Date or End Date that follows School, Degree or Field of Study fields is the degree's start or end, never the job start. The job start is only asked by fields that say available, start work, or join.",
      ],
    },
    fields: fields.map((f, i) => ({
      id: f.id,
      kind: f.kind,
      section: f.section,
      /** Labels of the two fields just above this one: "Start Date" after "School" and "Degree" is an education date. */
      preceded_by: fields.slice(Math.max(0, i - 2), i).map((p) => p.label).filter(Boolean),
      label: f.label,
      hint: f.hint,
      placeholder: f.placeholder,
      name: f.name,
      autocomplete: f.autocomplete,
      required: f.required,
      options: hasChoosableOptions(f) ? f.options.map((o) => o.label) : [],
    })),
  };
}

/** Raised whenever the gates below change, so a plan cached under the old rules is not reused. */
const PLAN_VERSION = 10;

/** A box that asks for somebody else's contact details: a reference, a supervisor, an emergency contact. Never the applicant's. */
const OTHER_PERSON = /\b(reference|referee|referr(?:al|er)|referred by|supervisor|manager|emergency|next of kin|recruiter|contact person|guardian|parent|spouse|alternate|secondary)\b/i;
const AUTH_Q = /authori[sz]ed to work|legally (?:authori[sz]ed|eligible|entitled|permitted|able) to work|eligible to work|right to work|work authori[sz]ation|legally work/i;
// "Do you require work authorization?" and "Will you require authorization to work?" ask whether the employer has to arrange one: that is sponsorship, in other words.
const NEEDS_PERMIT_Q = /\b(?:require|need)s?\b[^.?]{0,25}\b(?:(?:work|employment) (?:authori[sz]ation|visa|permit)|authori[sz]ation to work)/i;
const SPONSOR_Q = new RegExp(`sponsor|${NEEDS_PERMIT_Q.source}`, "i");
/** A tick that accepts something: terms, an agreement, a notice. */
const AGREEMENT_Q = /\b(agree|agreement|acknowledg|consent|terms|privacy|arbitration|attest|certify|accept)/i;
/** Ticks that say the application is true or that a privacy notice was read: every application needs them. */
/**
 * The part of a date a box labelled Month, Day or Year takes, as a plain number. Null when the box
 * is not one of those, or the value is not a date. A date that names only a month is its first day.
 */
export function datePart(label: string, value: string): string | null {
  const which = /^\s*(month|mm|day|dd|year|yyyy)\s*\*?\s*$/i.exec(label)?.[1]?.toLowerCase();
  const d = which ? toYmd(value) : null;
  if (!which || !d) return null;
  return String(which.startsWith("m") ? d.month : which.startsWith("d") ? d.day : d.year);
}

/** A question about working on site, in an office or in a city the person would move to. */
const WORKPLACE_Q = /\brelocat|\bon[- ]?site\b|\bin[- ](?:the[- ])?office\b|\bin[- ]person\b|\bbased in\b|\bcommut|\bhybrid\b/i;
/** A name box that asks for the whole name: "Name (first & last)", "First and last name", "Full name". */
const BOTH_NAMES = /\bfirst\b[^.]{0,12}\blast\b|\bfull name\b/i;
/** A box that says the person goes by a name other than their legal one. */
const PREFERRED_NAME_BOX = /\b(i have|i use|i go by)\b[^.]{0,30}\b(preferred|different|another) name\b/i;
const ROUTINE_AGREEMENT = /\b(privacy|true|accurate|correct|complete|information (?:i|provided|above)|data (?:protection|processing))/i;

export type Category = "contact_other" | "authorization" | "sponsorship" | "agreement" | "general";

/** What kind of answer a field asks for, from its question. The kinds that must be true get stricter rules. */
export function categoryOf(f: Pick<DumpedField, "label" | "section" | "hint" | "kind">): Category {
  const words = `${f.label} ${f.section ?? ""}`;
  if ((f.kind === "email" || f.kind === "tel") && OTHER_PERSON.test(`${words} ${f.hint ?? ""}`)) return "contact_other";
  if (f.kind === "checkbox") return AGREEMENT_Q.test(words) ? "agreement" : "general";
  const sponsor = SPONSOR_Q.test(words);
  const auth = AUTH_Q.test(words);
  // "Authorized to work without sponsorship" is a question about authorization; "will you require sponsorship" is about sponsorship.
  if (auth && !NEEDS_PERMIT_Q.test(words) && (!sponsor || /without (?:the need for |requiring |needing )?(?:visa )?sponsor/i.test(words))) return "authorization";
  if (sponsor && (!auth || NEEDS_PERMIT_Q.test(words))) return "sponsorship";
  return "general";
}

/** The country a question about the right to work means: the one it names, else the posting's. Null when neither says. */
export function countryOf(label: string, job: Job): string | null {
  if (/\bcanad/i.test(label)) return "Canada";
  if (/united states|\bu\.?s\.?a?\.?\b|\bamerica\b/i.test(label)) return "United States";
  const tier = locationTier(job.locations);
  return tier === "vancouver" || tier === "canada" ? "Canada" : tier === "us" ? "United States" : null;
}

/** Yes or No, when an option plainly says one of them. */
export const polarity = (label: string): "Yes" | "No" | null => (/^\s*yes\b/i.test(label) ? "Yes" : /^\s*no\b/i.test(label) ? "No" : null);

/** The true answer to a question about the right to work, from the profile. Null when the country cannot be told. */
export function truthFor(category: Category, label: string, profile: Profile, job: Job): "Yes" | "No" | null {
  const country = countryOf(label, job);
  if (!country) return null;
  const auth = authForCountry(profile, country);
  return category === "authorization" ? auth.authorized : category === "sponsorship" ? auth.requires_sponsorship : null;
}

/** True when the person's standing answers say the tool may accept agreements for them. */
export const approvesAgreements = (profile: Profile): boolean => profile.answers.some((a) => /agreement|acknowledg|terms|attestation/i.test(a.question) && /\b(i agree|tick)\b/i.test(a.answer));

/**
 * Why an answer about the right to work may not go in, or null when it may: the option must say
 * what the profile says for the country the question means. Used for JEV's picks and the writer's.
 */
export function gateAnswer(f: Pick<DumpedField, "label" | "section" | "hint" | "kind">, value: string, profile: Profile, job: Job): string | null {
  const category = categoryOf(f);
  if (category !== "authorization" && category !== "sponsorship") return null;
  const truth = truthFor(category, f.label, profile, job);
  if (truth === null) return "the question does not name a country and the posting's is not clear, so the answer is yours";
  const said = polarity(value);
  if (said !== null && said !== truth) return `the answer "${value.slice(0, 30)}" does not match the profile, which says ${truth} for ${countryOf(f.label, job)}`;
  return null;
}

export function authForCountry(profile: Profile, country: string): { authorized: "Yes" | "No"; requires_sponsorship: "Yes" | "No" } {
  const ok = profile.workAuthorization.authorizedCountries.some((c) => country.toLowerCase().includes(c.toLowerCase()));
  return { authorized: ok ? "Yes" : "No", requires_sponsorship: ok ? "No" : "Yes" };
}

const TEXT_KINDS = new Set(["text", "email", "tel", "url", "number", "date", "calendar", "textarea"]);

/** Input types whose value is fixed by the type itself; JEV only picks among the matching keys. */
const KEYS_BY_KIND: Partial<Record<string, string[]>> = {
  url: ["linkedin_url", "github_url", "website_url", "leave_blank"],
};

export function questionsFor(fields: DumpedField[]): Questions {
  const q: Questions = {};
  const keyCriteria: Record<string, string> = { ...ALL_KEYS };
  for (const [intent, desc] of Object.entries(BANK_INTENTS)) keyCriteria[`bank:${intent}`] = desc;
  for (const f of fields) {
    const section = f.section ? ` in the "${f.section}" section` : "";
    const i = fields.indexOf(f);
    const before = fields.slice(Math.max(0, i - 2), i).map((p) => p.label).filter(Boolean);
    const context = before.length ? ` (directly after the fields ${before.map((b) => `"${b.slice(0, 40)}"`).join(" and ")})` : "";
    const title = `Field "${f.label || f.placeholder || f.name}"${section}${context}${f.hint ? ` (${f.hint.slice(0, 120)})` : ""}${f.required ? ", required" : ", optional"}`;
    if (f.kind === "email" || f.kind === "tel") continue; // fixed by the input type; see planField
    const restricted = KEYS_BY_KIND[f.kind];
    if (restricted) {
      q[f.id] = choice(`${title}, an input of type ${f.kind}: which value should fill it?`, Object.fromEntries(restricted.map((k) => [k, keyCriteria[k] as string])));
    } else if (TEXT_KINDS.has(f.kind)) {
      q[f.id] = choice(`${title}: which value should fill it?`, keyCriteria);
    } else if (f.kind === "select" || f.kind === "radio" || f.kind === "combobox") {
      const opts = f.options;
      if (!hasChoosableOptions(f)) {
        // No list yet, or one too long to show (countries, schools): JEV names the value and code finds it in the list.
        q[f.id] = choice(`${title}: a dropdown ${opts.length ? `with ${opts.length} options, too many to list` : "whose options are not visible yet"}. Which value belongs in it?`, keyCriteria);
        continue;
      }
      const criteria: Record<string, string> = {};
      opts.forEach((o, i) => (criteria[`o${i}`] = o.label || o.value));
      criteria[NONE] = f.required ? "No option fits the candidate at all" : "Leave unselected: optional and not applicable";
      q[f.id] = choice(`${title}: which option is correct for the candidate?`, criteria);
    } else if (f.kind === "checkbox") {
      q[f.id] = noul(`${title}: should this checkbox be checked for the candidate?`, {
        true: "A consent, acknowledgement, terms or accuracy box needed to submit, or a true statement about the candidate",
        false: "A marketing or alert opt-in, or a statement that is not true of the candidate",
      });
    }
  }
  return q;
}

/** A list JEV can pick from directly: present, and short enough to show whole. */
export function hasChoosableOptions(f: DumpedField): boolean {
  return (f.kind === "select" || f.kind === "radio" || f.kind === "combobox") && f.options.length > 0 && f.options.length <= FORM.maxOptionsForJev;
}

const SALARY_LABEL = /salary|compensation|desired pay|expected pay|pay (rate|range|expectation)|hourly rate|wage/i;

const EDUCATION_NEIGHBOUR = /school|university|college|degree|field of study|major|education|graduat|start date|end date/i;
const DATE_LABEL = /^(start|end)\s*(date|month|year)?$/i;

/**
 * A Start Date or End Date select that sits right after education fields is
 * the degree's dates. That is a fact from the profile, so it is resolved in
 * code: month selects get the month (by name or number), year selects the year.
 * Returns null when the field is not one of these.
 */
export function educationDatePlan(f: DumpedField, previous: DumpedField[], profile: Profile): PlannedField | null {
  if (!DATE_LABEL.test(f.label.trim()) || (f.kind !== "select" && f.kind !== "combobox") || f.options.length === 0) return null;
  if (!previous.some((p) => EDUCATION_NEIGHBOUR.test(p.label))) return null;
  const edu = profile.education[0];
  if (!edu) return null;
  const isStart = /^start/i.test(f.label.trim());
  const month = isStart ? edu.startMonth : edu.gradMonth;
  const year = isStart ? edu.startYear : edu.gradYear;
  const labels = f.options.map((o) => o.label.trim());
  const looksLikeYears = labels.filter((l) => /^(19|20)\d\d$/.test(l)).length >= Math.max(2, labels.length / 2);
  const looksLikeMonths = labels.some((l) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(l)) || labels.filter((l) => /^(0?[1-9]|1[0-2])$/.test(l)).length >= 12;
  let opt: { value: string; label: string } | undefined;
  if (looksLikeYears) opt = f.options.find((o) => o.label.trim() === String(year) || o.value === String(year));
  else if (looksLikeMonths) {
    const name = monthName(month).toLowerCase();
    opt = f.options.find((o) => o.label.trim().toLowerCase().startsWith(name.slice(0, 3)) || o.label.trim() === String(month) || o.label.trim() === String(month).padStart(2, "0") || o.value === String(month));
  }
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required };
  if (!opt) return { ...base, action: "review", key: isStart ? "education_start_date" : "graduation_date", value: null, optionLabel: null, confidence: 0.4, note: `education ${isStart ? "start" : "end"} date, no matching option for ${monthName(month)} ${year}` };
  return { ...base, action: "fill", key: isStart ? "education_start_date" : "graduation_date", value: f.kind === "select" ? opt.value : opt.label, optionLabel: opt.label, confidence: 1, note: "degree date from the profile" };
}

const EMPLOYMENT_NEIGHBOUR = /company|employer|job title|^title$|position|^role$/i;
const SCHOOL_NEIGHBOUR = /school|university|college|degree|discipline|field of study|major/i;
const WORK_DATE_LABEL = /^(start|end)\s*(?:date)?\s*(month|year)?$/i;
const CURRENT_ROLE = /^(current role|current position|i currently work here|currently work here)$/i;

/** Which block a date field sits in, from the nearest field above it that is not itself a date. */
export function sectionOf(previous: DumpedField[]): "education" | "employment" | null {
  for (let i = previous.length - 1; i >= 0; i--) {
    const label = (previous[i] as DumpedField).label.trim();
    if (/^(start|end)\b/i.test(label) || CURRENT_ROLE.test(label)) continue;
    if (EMPLOYMENT_NEIGHBOUR.test(label)) return "employment";
    return SCHOOL_NEIGHBOUR.test(label) ? "education" : null;
  }
  return null;
}

/**
 * Dates and the "current role" box of a work-history block are facts about the most recent job
 * in the profile, so they are resolved in code. Returns null when the field is not one of these.
 */
export function employmentDatePlan(f: DumpedField, previous: DumpedField[], profile: Profile): PlannedField | null {
  const exp = profile.experience[0];
  if (!exp || sectionOf(previous) !== "employment") return null;
  const label = f.label.trim();
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null as string | null };
  if (f.kind === "checkbox" && CURRENT_ROLE.test(label)) {
    return exp.current
      ? { ...base, action: "fill", key: "checked", value: "true", confidence: 1, note: "the most recent job is the current one" }
      : { ...base, action: "skip", key: "unchecked", value: null, confidence: 1, note: "the most recent job has ended" };
  }
  const m = WORK_DATE_LABEL.exec(label);
  if (!m) return null;
  const isStart = /^start/i.test(m[1] as string);
  const date = /^(\d{4})-(\d{2})/.exec(isStart ? exp.start : exp.end);
  if (!date) return isStart || !exp.current ? null : { ...base, action: "skip", key: "leave_blank", value: null, confidence: 1, note: "still in this job, no end date" };
  const year = date[1] as string;
  const month = parseInt(date[2] as string, 10);
  const labels = f.options.map((o) => o.label.trim());
  const part = (m[2]?.toLowerCase() as "month" | "year" | undefined) ?? (labels.filter((l) => /^(19|20)\d\d$/.test(l)).length >= 2 ? "year" : labels.length ? "month" : undefined);
  const key = isStart ? "employment_start_date" : "employment_end_date";
  const note = "work history date from the profile";
  if ((f.kind === "select" || f.kind === "combobox") && f.options.length) {
    const name = monthName(month).toLowerCase();
    const opt = part === "year"
      ? f.options.find((o) => o.label.trim() === year || o.value === year)
      : f.options.find((o) => o.label.trim().toLowerCase().startsWith(name.slice(0, 3)) || o.label.trim() === String(month) || o.label.trim() === String(month).padStart(2, "0") || o.value === String(month));
    if (!opt) return { ...base, action: "review", key, value: null, confidence: 0.4, note: `work history ${isStart ? "start" : "end"} date, no matching option for ${monthName(month)} ${year}` };
    return { ...base, action: "fill", key, value: f.kind === "select" ? opt.value : opt.label, optionLabel: opt.label, confidence: 1, note };
  }
  if (part === "year" && (f.kind === "text" || f.kind === "number")) return { ...base, action: "fill", key, value: year, confidence: 1, note };
  return null;
}

const SLOT_LABEL = /assess|interview|session|time slot|schedule|appointment|attend|preferred date/i;
const SLOT_OPTION = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+[a-z]*\s*\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}:\d{2}\b/i;

/** A question that asks the candidate to pick one of several dates or times for an interview, a test or an event. */
export function isSlotChoice(f: DumpedField): boolean {
  return SLOT_LABEL.test(f.label) && f.options.filter((o) => SLOT_OPTION.test(o.label)).length >= 2;
}

/** Typing a name to sign an agreement is the candidate's act, not the tool's. An NDA is theirs to read first, whatever the box looks like. */
const SIGNATURE_LABEL = /\bNDA\b|non-?disclosure|e-?signature|electronic signature|(typ(e|ing)|enter(ing)?) your (full |legal )*name/i;

/**
 * Other wordings a list may know a planned value by. Today that is the field of study, whose other
 * names the profile gives. Only a list gets them: a box that takes any text is given the profile's own word.
 */
export function alternatesFor(p: Pick<PlannedField, "key" | "kind">, profile: Profile): { alternates?: string[] } {
  const also = p.key === "major" && p.kind === "combobox" ? profile.education[0]?.fieldAlso : undefined;
  return also?.length ? { alternates: also } : {};
}

let plans: KeyedCache<FillPlan> | null = null;

/**
 * Maps a form to a fill plan. A form that was mapped before, with nothing changed in the form,
 * the job or the candidate, gets the same plan back without asking JEV: this is the second fill
 * of a form, and the real run after a rehearsal.
 */
export async function mapForm(jev: JevClient, profile: Profile, job: Job, dump: FieldsDump): Promise<FillPlan> {
  if (!CACHE.plans) return mapFormFresh(jev, profile, job, dump);
  plans ??= new KeyedCache<FillPlan>(PATHS.plans, "all", CACHE.maxPlans);
  // The values a form happens to hold (an earlier fill, an autofill) do not change what belongs in it.
  const fields = dump.fields.map(({ value: _value, checked: _checked, ...rest }) => rest);
  // A plan made with the profile's resume is not the plan for a run that wants a tailored one, and the other way round.
  const key = hashOf({ fields, submit: dump.submitSelectors, state: buildFormState(profile, job, { ...dump, url: "" }, []), form: FORM, documents: documentPolicy(), version: PLAN_VERSION });
  const hit = plans.get(key);
  if (hit) return { ...hit, jobId: job.id, url: dump.url, jevCostUsd: 0 };
  const plan = await mapFormFresh(jev, profile, job, dump);
  plans.set(key, plan);
  plans.save();
  return plan;
}

async function mapFormFresh(jev: JevClient, profile: Profile, job: Job, dump: FieldsDump): Promise<FillPlan> {
  const planned: PlannedField[] = [];
  const startCost = jev.usage.costUsd;
  const resolvedInCode = new Set<string>();
  dump.fields.forEach((f, i) => {
    const above = dump.fields.slice(Math.max(0, i - 8), i);
    const p = employmentDatePlan(f, above, profile) ?? (sectionOf(above) === "employment" ? null : educationDatePlan(f, dump.fields.slice(Math.max(0, i - 4), i), profile));
    if (p) {
      planned.push(p);
      resolvedInCode.add(f.id);
    }
  });
  // Tailored documents, when the person asked for them: the resume written for this job goes in the resume box,
  // and a cover letter is written when the form has a box for one, as a file or as text.
  const coverBox = dump.fields.some((f) => COVER_LABEL.test(`${f.label} ${f.name} ${f.hint}`));
  const policy = documentPolicy();
  let docs = documentsFor(job.id, profile);
  if ((policy.resume && !docs) || (policy.cover && coverBox && !docs?.coverText)) {
    const entry = loadQueue().entries.find((e) => e.job.id === job.id);
    if (entry) {
      try {
        docs = await tailorJob(profile, entry, { cover: policy.cover && coverBox });
      } catch (err) {
        // A draft the truth gate refused, or a print that failed, is no reason to skip the job: the profile's own resume goes.
        console.log(`   tailored documents not used: ${err instanceof Error ? err.message : String(err)}. Sending the profile's resume instead.`);
        docs = null;
      }
    }
  }
  const coverText = policy.cover ? (docs?.coverText ?? null) : null;
  dump.fields.forEach((f) => {
    if (f.kind !== "textarea" || resolvedInCode.has(f.id) || !coverText || !COVER_LABEL.test(`${f.label} ${f.name} ${f.hint}`)) return;
    planned.push({ id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null, action: "fill", key: "cover_letter", value: f.maxLength ? coverText.slice(0, f.maxLength) : coverText, confidence: 1, note: "the cover letter written for this job" });
    resolvedInCode.add(f.id);
  });
  const askable = dump.fields.filter((f) => f.kind !== "file" && !resolvedInCode.has(f.id));
  // A chunk too large for JEV's context (long questions, long option lists) is halved and asked again.
  const ask = async (chunk: DumpedField[]): Promise<Record<string, Answer>> => {
    const questions = questionsFor(chunk);
    if (!Object.keys(questions).length) return {};
    try {
      return await jev.decide(buildFormState(profile, job, dump, chunk), questions, `map-form:${job.id}:${job.company}`);
    } catch (err) {
      if (chunk.length < 2 || !/max_tokens_exceeded|context length|too large/i.test(err instanceof Error ? err.message : "")) throw err;
      const half = Math.ceil(chunk.length / 2);
      return { ...(await ask(chunk.slice(0, half))), ...(await ask(chunk.slice(half))) };
    }
  };
  for (let i = 0; i < askable.length; i += FORM.fieldsPerCall) {
    const chunk = askable.slice(i, i + FORM.fieldsPerCall);
    const answers = await ask(chunk);
    for (const f of chunk) planned.push(planField(f, answers[f.id], profile, job));
  }
  const fileBoxes = dump.fields.filter((f) => f.kind === "file");
  const wants = fileBoxes.map(fileBoxWants);
  // A box that names no document is the resume box only when no other box on the form asks for the resume.
  const unnamedResume = wants.includes("resume") ? -1 : wants.indexOf("unnamed");
  fileBoxes.forEach((f, i) => {
    const want = i === unnamedResume ? "resume" : wants[i];
    // The one transcript on file is the undergraduate one unless the profile holds a graduate degree.
    const graduate = profile.education.some((e) => /master|\bm\.?sc?\b|\bmba\b|ph\.?d|doctor/i.test(e.degree));
    const file =
      want === "resume" ? (policy.resume && docs ? docs.resume : profile.resume.path)
      : want === "cover" ? (policy.cover && docs?.cover ? docs.cover : null)
      : want === "transcript" || (want === "graduate_transcript" && graduate) ? (profile.transcript?.path ?? null)
      : null;
    planned.push({
      id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required,
      action: file ? "upload" : "skip", key: want === "resume" ? "resume_upload" : "leave_blank",
      value: file, optionLabel: null, confidence: 1,
      note: file ? (want === "resume" && file !== profile.resume.path ? "the resume written for this job" : want === "cover" ? "the cover letter written for this job" : null) : want === "autofill" ? "autofill helper, skipped so it does not overwrite the plan" : want === "transcript" ? "asks for a transcript. Set transcript.path in your profile to attach one" : want === "graduate_transcript" ? "asks for a graduate transcript, and the profile has no graduate degree" : want === "cover" ? "asks for a cover letter. Run apply --cover to write one" : "not a resume upload",
    });
  });
  const ordered = dump.fields.map((f) => planned.find((p) => p.id === f.id) as PlannedField);
  return {
    jobId: job.id,
    url: dump.url,
    fields: ordered,
    fills: ordered
      .filter((p) => p.action === "fill" && p.value !== null)
      // A list may know the field of study by another name. The profile says which names are the same field.
      .map((p) => ({ selector: p.selector, kind: p.kind, value: p.value as string, ...alternatesFor(p, profile) })),
    uploads: ordered.filter((p) => p.action === "upload").map((p) => ({ selector: p.selector, path: p.value as string })),
    drafts: ordered.filter((p) => p.action === "draft").map((p) => {
      const f = dump.fields.find((x) => x.id === p.id) as DumpedField;
      return { id: p.id, selector: p.selector, label: p.label, hint: f.hint, maxLength: f.maxLength, intent: p.key };
    }),
    reviews: ordered.filter((p) => p.action === "review").map((p) => {
      const f = dump.fields.find((x) => x.id === p.id) as DumpedField;
      return { id: p.id, selector: p.selector, kind: p.kind, label: p.label, options: f.options.map((o) => o.label), why: p.note ?? "low confidence" };
    }),
    submitSelectors: dump.submitSelectors,
    jevCostUsd: jev.usage.costUsd - startCost,
  };
}

export function planField(f: DumpedField, answer: Answer | undefined, profile: Profile, job: Job): PlannedField {
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null as string | null };
  // A reference's email or a supervisor's phone is not the applicant's: such a box is never filled from the profile.
  if (categoryOf(f) === "contact_other") {
    return { ...base, action: f.required ? "review" : "skip", key: f.required ? "unknown" : "leave_blank", value: null, confidence: 1, note: "asks for another person's contact details" };
  }
  if (f.kind === "email") return { ...base, action: "fill", key: "email", value: profile.email, confidence: 1, note: null };
  if (f.kind === "tel") {
    // National digits unless the placeholder or hint shows an international format.
    const intl = /\+\d|country code|international/i.test(`${f.placeholder} ${f.hint}`);
    return { ...base, action: "fill", key: intl ? "phone_with_country_code" : "phone", value: intl ? `${profile.phone.countryCode}${profile.phone.national}` : profile.phone.national, confidence: 1, note: null };
  }
  if (SIGNATURE_LABEL.test(f.label)) return { ...base, action: "review", key: "signature", value: null, confidence: 1, note: "signing an agreement is for the candidate to do" };
  if (isSlotChoice(f)) return { ...base, action: "review", key: "schedule", value: null, confidence: 1, note: "choosing a date or a time slot is for the candidate to do" };
  if (!answer) return { ...base, action: "review", key: "unknown", value: null, confidence: 0, note: "no answer" };

  if (f.kind === "checkbox") {
    // Whether the person goes by another name is a fact in the profile, not a judgement about the box.
    if (PREFERRED_NAME_BOX.test(f.label)) {
      const other = !!profile.name.preferred && profile.name.preferred !== profile.name.first;
      return other
        ? { ...base, action: "fill", key: "checked", value: "true", confidence: 1, note: "the profile gives a preferred name" }
        : { ...base, action: "skip", key: "unchecked", value: null, confidence: 1, note: "the profile gives no other name" };
    }
    const p = (answer as NoulAnswer).noul;
    if (p >= FORM.gates.tick) {
      // Accepting an agreement is the person's: the tool ticks it when their standing answers say so, or when it only says the application is true.
      if (categoryOf(f) === "agreement" && !ROUTINE_AGREEMENT.test(f.label) && !approvesAgreements(profile)) {
        return { ...base, action: "review", key: "unknown", value: null, confidence: p, note: "accepting this is yours to decide; a standing answer about agreements lets the tool tick it" };
      }
      return { ...base, action: "fill", key: "checked", value: "true", confidence: p, note: null };
    }
    if (p <= FORM.gates.leave) return { ...base, action: "skip", key: "unchecked", value: null, confidence: 1 - p, note: "left unchecked" };
    return { ...base, action: "review", key: "unknown", value: null, confidence: Math.max(p, 1 - p), note: "unsure whether to check" };
  }

  let a = answer as ChoiceAnswer;
  if (hasChoosableOptions(f)) {
    if (a.choice === NONE) {
      if (f.required) return { ...base, action: "review", key: "unknown", value: null, confidence: a.confidence, note: "required but no option fits" };
      return { ...base, action: "skip", key: "leave_blank", value: null, confidence: a.confidence, note: "optional, left unselected" };
    }
    const idx = parseInt(a.choice.replace(/^o/, ""), 10);
    const opt = f.options[idx];
    if (!opt) return { ...base, action: "review", key: "unknown", value: null, confidence: 0, note: "option index out of range" };
    // An answer about the right to work must say what the profile says. JEV picked the option; code checks it.
    const refused = gateAnswer(f, opt.label, profile, job);
    if (refused) return { ...base, action: "review", key: "unknown", value: null, confidence: a.confidence, note: refused };
    const category = categoryOf(f);
    if ((category === "authorization" || category === "sponsorship") && polarity(opt.label) === null && a.confidence < FORM.gates.authority) {
      return { ...base, action: "review", key: "unknown", value: null, confidence: a.confidence, note: "an answer about the right to work that is not a plain yes or no" };
    }
    // An answer about the right to work was checked against the profile above. Any other choice among a few
    // statements (yes or no, office or hybrid or remote) is about the person and code cannot check it, so a
    // lean is not enough: the writer reads the standing answers.
    const statement = category === "general" && f.options.length <= FORM.gates.statementOptions;
    // Where the person will work is settled by their standing answer about relocating, which the writer reads.
    // JEV answers such a question from where they live now, and is sure of it.
    const whereTheyWork = statement && WORKPLACE_Q.test(f.label);
    const action = !whereTheyWork && a.confidence >= (statement ? FORM.gates.statement : FORM.reviewConfidence) ? "fill" : "review";
    // Radios and comboboxes are matched by label in fillFields.js: radio value attributes are often missing or all "on".
    const value = f.kind === "select" ? opt.value : opt.label;
    return { ...base, action, key: `option:${a.choice}`, value, optionLabel: opt.label, confidence: a.confidence, note: a.confidence < FORM.autoConfidence ? `confidence ${a.confidence.toFixed(2)}` : null };
  }

  // A box that asks for first and last name takes both, whichever name JEV took it for.
  const key = (a.choice === "first_name" || a.choice === "preferred_name") && BOTH_NAMES.test(f.label) ? "full_name" : a.choice;
  // Keys that would put the same text in the box are one answer, so their probabilities add up:
  // "country", "citizenship" and "work authorization country" all say Canada.
  const confidence = agreedConfidence(a, profile, job);
  a = { ...a, confidence };
  const note = a.confidence < FORM.autoConfidence ? `confidence ${a.confidence.toFixed(2)}` : null;
  const textLike = f.kind === "text" || f.kind === "textarea";
  // A salary box that will not submit empty gets the profile's standing wording, never a number the candidate did not give.
  if (f.required && textLike && SALARY_LABEL.test(f.label) && !profile.preferences.salaryExpectation && (key === "salary_expectation" || key === "leave_blank" || key === "unknown" || key === "free_text")) {
    return { ...base, action: "fill", key: "salary_expectation", value: profile.preferences.salaryIfRequired, confidence: a.confidence, note: "salary is required, so the standing wording is used" };
  }
  if (a.confidence < FORM.reviewConfidence) {
    // An open question is drafted whatever the confidence: the writer reads the question itself, not JEV's guess at its intent.
    if (f.kind === "textarea" && (key.startsWith("bank:") || key === "free_text")) return { ...base, action: "draft", key: key.startsWith("bank:") ? key.slice(5) : key, value: null, confidence: a.confidence, note: `intent is a guess (${a.confidence.toFixed(2)})` };
    return { ...base, action: "review", key, value: null, confidence: a.confidence, note: `low confidence, best guess ${key}` };
  }
  if (key.startsWith("bank:")) return { ...base, action: "draft", key: key.slice(5), value: null, confidence: a.confidence, note };
  if (isSpecialKey(key)) {
    if (key === "free_text") return { ...base, action: "draft", key: "free_text", value: null, confidence: a.confidence, note };
    if (key === "resume_upload") return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "text field mapped to resume; probably a link or name" };
    if (key === "leave_blank") return { ...base, action: f.required ? "review" : "skip", key, value: null, confidence: a.confidence, note: f.required ? "required but mapped to leave blank" : null };
    return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "unknown field" };
  }
  if (isProfileKey(key)) {
    let value = valueForJob(profile, job, key as FieldKey, f.label);
    // Workday lists a dial code under its country, "Canada (+1)", and many countries share one code. The country is the profile's own.
    if (value !== null && key === "phone_country_code" && f.widget === "workday-prompt" && profile.address.country) value = `${profile.address.country} (${value})`;
    // A list takes one language: the first the profile names. A box that takes any text gets them all.
    if (value !== null && key === "spoken_languages" && (f.kind === "combobox" || f.kind === "select") && profile.spokenLanguages[0]) value = profile.spokenLanguages[0].name;
    if (value === null) {
      if (key === "gpa") return { ...base, action: f.required ? "fill" : "skip", key, value: f.required ? gpaValue(profile) : null, confidence: a.confidence, note: f.required ? "GPA given only because the field is required" : "GPA not volunteered" };
      return { ...base, action: f.required ? "review" : "skip", key, value: null, confidence: a.confidence, note: f.required ? "required but the profile has no value" : null };
    }
    if (f.kind === "calendar") {
      // A calendar takes a day. A value that names only a month is its first day; anything that is not a date goes to Claude.
      const day = toYmd(value);
      if (!day) return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "the calendar needs a date, and the profile's value is not one" };
      return { ...base, action: "fill", key, value: isoOf(day), confidence: a.confidence, note };
    }
    // A date asked for in three boxes (Workday's Month, Day, Year): each box gets its own part of the date.
    const part = TEXT_KINDS.has(f.kind) ? datePart(f.label, value) : null;
    if (part !== null) return { ...base, action: "fill", key, value: part, confidence: a.confidence, note };
    // A text box that names a date format gets the date written that way: typed as "May 2027", a masked box keeps "02/27/".
    return { ...base, action: "fill", key, value: TEXT_KINDS.has(f.kind) ? shapedForBox(value, `${f.placeholder} ${f.hint}`) : value, confidence: a.confidence, note };
  }
  return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "unrecognized key" };
}

/** Which document a file box asks for, from its question, its name and its hint. The resume is never put in a box that asks for something else. */
/** A box that asks for a cover letter, as a file or as text. */
export const COVER_LABEL = /cover\s*letter|covering letter|letter of (motivation|interest|application)|motivation letter/i;

export function fileBoxWants(f: Pick<DumpedField, "label" | "name" | "hint" | "selector">): "resume" | "cover" | "transcript" | "graduate_transcript" | "autofill" | "other" | "unnamed" {
  const text = `${f.label} ${f.name} ${f.hint} ${f.selector}`;
  if (/autofill|auto-fill|parse|prefill/i.test(text)) return "autofill";
  if (COVER_LABEL.test(text)) return "cover";
  if (/transcript/i.test(text)) return /\b(graduate|master|phd|doctoral)\b/i.test(text) && !/undergraduate/i.test(text) ? "graduate_transcript" : "transcript";
  if (/resume|résumé|\bcv\b|curriculum/i.test(text)) return "resume";
  if (/cover|letter|portfolio|photo|picture|certificate|writing sample|work sample|reference|other|additional/i.test(text)) return "other";
  return "unnamed";
}

function agreedConfidence(a: ChoiceAnswer, profile: Profile, job: Job): number {
  const valueOf = (key: string) => (isProfileKey(key) ? valueForJob(profile, job, key as FieldKey) : null);
  const value = valueOf(a.choice);
  if (value === null) return a.confidence;
  const agreed = Object.entries(a.probabilities).reduce((sum, [key, p]) => (valueOf(key) === value ? sum + p : sum), 0);
  return Math.min(1, Math.max(a.confidence, agreed));
}

function gpaValue(profile: Profile): string | null {
  const g = profile.education[0]?.gpa;
  return g?.cumulative !== undefined ? g.cumulative.toFixed(2) : null;
}

/** Profile value for a key, with the two job-dependent keys resolved against the posting's country. */
export function valueForJob(profile: Profile, job: Job, key: FieldKey, label = ""): string | null {
  if (isSpecialKey(key)) return null;
  if (key === "authorized_to_work" || key === "requires_sponsorship") {
    // The country is the one the question names, else the posting's. When neither says, the answer is the person's.
    const country = countryOf(label, job);
    if (!country) return null;
    const auth = authForCountry(profile, country);
    return key === "authorized_to_work" ? auth.authorized : auth.requires_sponsorship;
  }
  return valueFor(profile, key);
}
