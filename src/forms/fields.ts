/**
 * The contract between the browser scripts and the mapper.
 * dumpFields.js produces a FieldsDump; mapForm turns it into a FillPlan;
 * fillFields.js applies the plan.
 */
import { z } from "zod";

/** calendar: a date box that cannot be typed into and is set by clicking through its pop-up of months and days. */
export const FieldKind = z.enum(["text", "email", "tel", "url", "number", "date", "calendar", "textarea", "select", "combobox", "radio", "checkbox", "file"]);
export type FieldKind = z.infer<typeof FieldKind>;

export const DumpedField = z.object({
  /** Stable key for this dump: f0, f1, ... */
  id: z.string(),
  /** The widget that draws the control, when the dump recognises it: intl-tel, react-select, datalist, calendar, buttons, label-drawn. */
  widget: z.string().default(""),
  /** CSS selector that finds the element again (or the radio group's first input). */
  selector: z.string(),
  kind: FieldKind,
  name: z.string().default(""),
  label: z.string().default(""),
  /** Nearby helper or description text, when present. */
  hint: z.string().default(""),
  placeholder: z.string().default(""),
  required: z.boolean().default(false),
  /** Current value, or the checked option for radios. */
  value: z.string().default(""),
  checked: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  accept: z.string().default(""),
  maxLength: z.number().nullable().default(null),
  autocomplete: z.string().default(""),
  /** Nearest heading above the control: "Education", "Work authorization", "Voluntary self-identification". */
  section: z.string().default(""),
  /** True when the "radio" is a group of plain buttons rather than input elements. */
  buttonGroup: z.boolean().default(false),
});
export type DumpedField = z.infer<typeof DumpedField>;

export const FieldsDump = z.object({
  url: z.string(),
  title: z.string().default(""),
  /** Visible text near the top of the form: headings and intro copy. */
  context: z.string().default(""),
  fields: z.array(DumpedField),
  submitSelectors: z.array(z.string()).default([]),
  /** Embedded application forms found on the page, by iframe src. */
  frames: z.array(z.string()).default([]),
  /** True when the page shows a password box: a login or account page, which the tool never fills. */
  hasPassword: z.boolean().default(false),
  /** A take-home assignment the page asks for, with its link: the application still goes, and the assignment is listed for the person. */
  takeHome: z.array(z.object({ text: z.string(), url: z.string() })).default([]),
});
export type FieldsDump = z.infer<typeof FieldsDump>;

/**
 * True when a dump is an application form and not some other page with inputs on it (a careers
 * page with a search box and a language picker). An application asks for a resume, an email or a name.
 */
/**
 * True for a page that holds an application: a box for a file, or both a name and an email. An
 * email box alone is a job alert or a newsletter, which must never be filled or sent.
 */
export function isApplicationForm(d: FieldsDump): boolean {
  const asksFile = d.fields.some((f) => f.kind === "file" || /resume|\bcv\b|curriculum/i.test(f.label));
  const asksName = d.fields.some((f) => /first name|last name|full name|legal name|^(your )?name\b|prénom|\bnom\b/i.test(f.label));
  const asksEmail = d.fields.some((f) => f.kind === "email" || /e-?mail|courriel/i.test(f.label));
  return asksFile || (asksName && asksEmail);
}

export const PlanAction = z.enum([
  /** fillFields.js writes the value. */
  "fill",
  /** Claude uses the Chrome upload tool with the resume path. */
  "upload",
  /** Claude drafts text from answer-context and fills it. */
  "draft",
  /** Deliberately left empty. */
  "skip",
  /** JEV was unsure; Claude reads the label and decides. */
  "review",
]);
export type PlanAction = z.infer<typeof PlanAction>;

export const PlannedField = z.object({
  id: z.string(),
  selector: z.string(),
  kind: FieldKind,
  label: z.string(),
  required: z.boolean(),
  action: PlanAction,
  /** The profile key, bank intent, or special key JEV chose. */
  key: z.string(),
  /** What goes in the box (for select and radio: the option value). Null when not fill. */
  value: z.string().nullable(),
  /** For select and radio: the option label matched, for Claude's eyes. */
  optionLabel: z.string().nullable(),
  confidence: z.number(),
  note: z.string().nullable(),
});
export type PlannedField = z.infer<typeof PlannedField>;

export const FillPlan = z.object({
  jobId: z.string(),
  url: z.string(),
  fields: z.array(PlannedField),
  /** Fields the browser script should apply, already filtered to action = fill. */
  /** alternates: other wordings of the same value, for a list that does not have the first. picked: the option a list took. */
  fills: z.array(z.object({ selector: z.string(), kind: FieldKind, value: z.string(), alternates: z.array(z.string()).optional(), picked: z.string().optional() })),
  uploads: z.array(z.object({ selector: z.string(), path: z.string() })),
  drafts: z.array(z.object({ id: z.string(), selector: z.string(), label: z.string(), hint: z.string(), maxLength: z.number().nullable(), intent: z.string() })),
  reviews: z.array(z.object({ id: z.string(), selector: z.string(), kind: FieldKind, label: z.string(), options: z.array(z.string()), why: z.string() })),
  submitSelectors: z.array(z.string()),
  jevCostUsd: z.number(),
});
export type FillPlan = z.infer<typeof FillPlan>;
