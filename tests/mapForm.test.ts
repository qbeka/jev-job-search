import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/profile/schema.js";
import { PROFILE_KEYS, profileFacts, valueFor } from "../src/profile/fieldKeys.js";
import { alternatesFor, datePart, approvesAgreements, authForCountry, categoryOf, educationDatePlan, employmentDatePlan, fileBoxWants, gateAnswer, hasChoosableOptions, isSlotChoice, planField, questionsFor, sectionOf, valueForJob } from "../src/forms/mapForm.js";
import { FieldsDump, isApplicationForm, type DumpedField } from "../src/forms/fields.js";
import type { Job } from "../src/jobs/normalize.js";

const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
const job = (locations: string[]): Job => ({ id: "j", source: "t", company: "Acme", title: "SWE Intern", url: "https://x", ats: "greenhouse", locations, postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null });
const field = (over: Partial<DumpedField>): DumpedField => ({ id: "f0", widget: "", selector: "#x", kind: "text", name: "", label: "", hint: "", placeholder: "", required: false, value: "", options: [], accept: "", maxLength: null, autocomplete: "", buttonGroup: false, section: "", ...over });

describe("profile field keys", () => {
  it("has a value or a deliberate null for every key", () => {
    for (const key of Object.keys(PROFILE_KEYS) as Array<keyof typeof PROFILE_KEYS>) {
      expect(() => valueFor(profile, key)).not.toThrow();
    }
    expect(valueFor(profile, "full_name")).toBe("Ada Lovelace");
    expect(valueFor(profile, "phone_with_country_code")).toBe("+15555550123");
    expect(valueFor(profile, "graduation_date")).toBe("April 2027");
    expect(valueFor(profile, "salary_expectation")).toBeNull();
    expect(valueFor(profile, "gpa")).toBeNull();
  });
  it("flattens facts for a JEV state without empty values", () => {
    const facts = profileFacts(profile);
    expect(facts.email).toBe("ada@example.com");
    expect(facts).not.toHaveProperty("salary_expectation");
  });
});

describe("work authorization per posting country", () => {
  it("answers truthfully for Canada and the US", () => {
    expect(authForCountry(profile, "Canada")).toEqual({ authorized: "Yes", requires_sponsorship: "No" });
    expect(authForCountry(profile, "United States")).toEqual({ authorized: "No", requires_sponsorship: "Yes" });
    expect(valueForJob(profile, job(["Toronto, ON"]), "authorized_to_work")).toBe("Yes");
    expect(valueForJob(profile, job(["Austin, TX"]), "requires_sponsorship")).toBe("Yes");
  });
});

describe("questionsFor", () => {
  it("asks a key choice for text fields, an option choice for selects, a noul for checkboxes", () => {
    const q = questionsFor([
      field({ id: "f0", kind: "text", label: "First name" }),
      field({ id: "f1", kind: "select", label: "Are you authorized to work in Canada?", options: [{ value: "y", label: "Yes" }, { value: "n", label: "No" }] }),
      field({ id: "f2", kind: "checkbox", label: "I agree to the privacy policy" }),
      field({ id: "f3", kind: "file", label: "Resume" }),
    ]);
    expect(q.f0?.type).toBe("choice");
    expect(Object.keys((q.f0 as { criteria: Record<string, string> }).criteria)).toContain("first_name");
    expect(Object.keys((q.f0 as { criteria: Record<string, string> }).criteria)).toContain("bank:why_company");
    expect((q.f1 as { criteria: Record<string, string> }).criteria).toMatchObject({ o0: "Yes", o1: "No" });
    expect(q.f2?.type).toBe("noul");
    expect(q.f3).toBeUndefined();
  });
  it("does not ask about tel and email inputs, and restricts url inputs to link keys", () => {
    const q = questionsFor([field({ id: "t", kind: "tel", label: "Phone Number" }), field({ id: "e", kind: "email", label: "Email" }), field({ id: "u", kind: "url", label: "LinkedIn" })]);
    expect(q.t).toBeUndefined();
    expect(q.e).toBeUndefined();
    expect(Object.keys((q.u as { criteria: Record<string, string> }).criteria)).toEqual(["linkedin_url", "github_url", "website_url", "leave_blank"]);
  });
  it("fills tel and email inputs from the input type alone", () => {
    const j = job(["Toronto, ON"]);
    expect(planField(field({ kind: "tel", label: "Phone Number" }), undefined, profile, j)).toMatchObject({ action: "fill", value: "5555550123" });
    expect(planField(field({ kind: "tel", label: "Phone", placeholder: "+1 555 555 5555" }), undefined, profile, j)).toMatchObject({ action: "fill", value: "+15555550123" });
    expect(planField(field({ kind: "email", label: "Personal Email" }), undefined, profile, j)).toMatchObject({ action: "fill", value: "ada@example.com" });
  });
  it("never puts the applicant's details in a box that asks for another person's", () => {
    const j = job(["Toronto, ON"]);
    expect(planField(field({ kind: "email", label: "Reference email" }), undefined, profile, j)).toMatchObject({ action: "skip", value: null });
    expect(planField(field({ kind: "tel", label: "Phone", section: "Emergency contact", required: true }), undefined, profile, j)).toMatchObject({ action: "review", value: null });
    expect(planField(field({ kind: "tel", label: "Supervisor's phone number" }), undefined, profile, j)).toMatchObject({ action: "skip" });
    expect(categoryOf(field({ kind: "email", label: "Email", section: "Personal information" }))).toBe("general");
  });
  it("holds an answer about the right to work to the profile, for the country the question means", () => {
    const yesNo = [{ value: "1", label: "Yes" }, { value: "0", label: "No" }];
    const pick = (choice: string, confidence = 0.95) => ({ type: "choice", choice, confidence, probabilities: {} }) as never;
    const us = job(["New York, NY"]);
    const ca = job(["Toronto, ON"]);
    const auth = field({ kind: "select", label: "Are you legally authorized to work in the United States?", options: yesNo, required: true });
    // The example profile is authorized in Canada only.
    expect(planField(auth, pick("o1"), profile, us)).toMatchObject({ action: "fill", optionLabel: "No" });
    expect(planField(auth, pick("o0"), profile, us)).toMatchObject({ action: "review" });
    const sponsor = field({ kind: "radio", label: "Will you now or in the future require sponsorship?", options: yesNo, required: true });
    expect(planField(sponsor, pick("o0"), profile, us)).toMatchObject({ action: "fill", optionLabel: "Yes" });
    expect(planField(sponsor, pick("o0"), profile, ca)).toMatchObject({ action: "review" });
    // A question that names no country, on a posting whose country is unclear, is the person's.
    const vague = field({ kind: "select", label: "Are you legally authorized to work in the country of this job?", options: yesNo, required: true });
    expect(planField(vague, pick("o0"), profile, job(["Remote"]))).toMatchObject({ action: "review" });
    expect(gateAnswer(auth, "Yes", profile, us)).toMatch(/does not match the profile/);
    expect(gateAnswer(auth, "No", profile, us)).toBeNull();
    expect(gateAnswer(field({ kind: "text", label: "Favourite language" }), "Yes", profile, us)).toBeNull();
    expect(categoryOf(field({ kind: "select", label: "Are you authorized to work in Canada without sponsorship?" }))).toBe("authorization");
    expect(valueForJob(profile, job(["Remote"]), "authorized_to_work")).toBeNull();
    expect(valueForJob(profile, job(["Remote"]), "authorized_to_work", "Are you authorized to work in Canada?")).toBe("Yes");
  });
  it("ticks an agreement only when it is routine or the person's standing answers allow it", () => {
    const j = job(["Toronto, ON"]);
    const sure = { type: "noul", noul: 0.95, confidence: 0.95 } as never;
    expect(planField(field({ kind: "checkbox", label: "I certify that the information above is true and complete" }), sure, profile, j)).toMatchObject({ action: "fill" });
    expect(planField(field({ kind: "checkbox", label: "I agree to the Arbitration Agreement" }), sure, profile, j)).toMatchObject({ action: "review" });
    const allowed = { ...profile, answers: [...profile.answers, { question: "Arbitration agreements, terms and acknowledgements", answer: "I agree. Tick every box needed to submit." }] };
    expect(planField(field({ kind: "checkbox", label: "I agree to the Arbitration Agreement" }), sure, allowed, j)).toMatchObject({ action: "fill" });
    expect(approvesAgreements(profile)).toBe(false);
  });
  it("puts the section into the question", () => {
    const q = questionsFor([field({ id: "s", kind: "text", label: "Start Date", section: "Education" })]);
    expect((q.s as { instructions: string }).instructions).toContain('in the "Education" section');
  });
});

describe("planField", () => {
  const j = job(["Toronto, ON"]);
  it("fills a confidently mapped profile key", () => {
    const p = planField(field({ label: "Email" }), { type: "choice", choice: "email", probabilities: {}, confidence: 0.97 }, profile, j);
    expect(p).toMatchObject({ action: "fill", key: "email", value: "ada@example.com" });
  });
  it("sends low-confidence answers to review", () => {
    const p = planField(field({ label: "Favourite colour" }), { type: "choice", choice: "email", probabilities: {}, confidence: 0.3 }, profile, j);
    expect(p.action).toBe("review");
  });
  it("turns bank intents and free_text into drafts", () => {
    expect(planField(field({ kind: "textarea", label: "Why Acme?" }), { type: "choice", choice: "bank:why_company", probabilities: {}, confidence: 0.9 }, profile, j)).toMatchObject({ action: "draft", key: "why_company" });
    expect(planField(field({ kind: "textarea", label: "Anything else?" }), { type: "choice", choice: "free_text", probabilities: {}, confidence: 0.9 }, profile, j).action).toBe("draft");
  });
  it("picks select options by index and leaves optional ones unselected", () => {
    const sel = field({ kind: "select", label: "Gender", options: [{ value: "m", label: "Male" }, { value: "f", label: "Female" }] });
    expect(planField(sel, { type: "choice", choice: "o1", probabilities: {}, confidence: 0.95 }, profile, j)).toMatchObject({ action: "fill", value: "f", optionLabel: "Female" });
    expect(planField(sel, { type: "choice", choice: "__none__", probabilities: {}, confidence: 0.9 }, profile, j).action).toBe("skip");
    expect(planField({ ...sel, required: true }, { type: "choice", choice: "__none__", probabilities: {}, confidence: 0.9 }, profile, j).action).toBe("review");
  });
  it("gives the GPA only when the field is required", () => {
    const a = { type: "choice" as const, choice: "gpa", probabilities: {}, confidence: 0.95 };
    expect(planField(field({ label: "GPA" }), a, profile, j)).toMatchObject({ action: "skip" });
    expect(planField(field({ label: "GPA", required: true }), a, profile, j)).toMatchObject({ action: "fill", value: "3.50" });
  });
  it("checks consent boxes and leaves opt-ins alone", () => {
    expect(planField(field({ kind: "checkbox", label: "I certify the above is accurate" }), { type: "noul", noul: 0.95 }, profile, j)).toMatchObject({ action: "fill", value: "true" });
    expect(planField(field({ kind: "checkbox", label: "Send me job alerts" }), { type: "noul", noul: 0.05 }, profile, j).action).toBe("skip");
    // Whether the person goes by another name is the profile's to say, however sure JEV is about the box.
    const plain = { ...profile, name: { first: profile.name.first, last: profile.name.last } } as typeof profile;
    expect(planField(field({ kind: "checkbox", label: "I have a preferred name" }), { type: "noul", noul: 0.94 }, plain, j)).toMatchObject({ action: "skip", key: "unchecked" });
    const other = { ...profile, name: { ...profile.name, preferred: "Sam" } } as typeof profile;
    expect(planField(field({ kind: "checkbox", label: "I have a preferred name" }), { type: "noul", noul: 0.1 }, other, j)).toMatchObject({ action: "fill", value: "true" });
  });
  it("never fills salary", () => {
    const p = planField(field({ label: "Salary expectation" }), { type: "choice", choice: "salary_expectation", probabilities: {}, confidence: 0.95 }, profile, j);
    expect(p.action).toBe("skip");
  });
});

describe("captured form dumps", () => {
  it.each(["greenhouse", "ashby", "lever"])("%s dump parses and has no invisible validation inputs", (ats) => {
    const dump = FieldsDump.parse(JSON.parse(readFileSync(new URL(`./fixtures/dump-${ats}.json`, import.meta.url), "utf8")));
    expect(dump.fields.length).toBeGreaterThan(5);
    expect(dump.fields.every((f) => f.id && f.selector && f.label !== undefined)).toBe(true);
    const labels = dump.fields.filter((f) => f.kind !== "file" && f.kind !== "checkbox").map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(questionsFor(dump.fields)).length).toBe(dump.fields.filter((f) => !["file", "email", "tel"].includes(f.kind)).length);
  });
});

describe("educationDatePlan", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
  const years = Array.from({ length: 10 }, (_, i) => ({ value: String(2030 - i), label: String(2030 - i) }));
  const school = field({ id: "s", label: "School" });
  const degree = field({ id: "d", kind: "select", label: "Degree", options: [{ value: "b", label: "Bachelor's" }] });
  it("resolves degree start and end selects from the profile", () => {
    expect(educationDatePlan(field({ id: "m", kind: "select", label: "Start Date", options: months }), [school, degree], profile)).toMatchObject({ action: "fill", value: "9", key: "education_start_date" });
    expect(educationDatePlan(field({ id: "y", kind: "select", label: "Start Date", options: years }), [school, degree], profile)).toMatchObject({ action: "fill", value: "2024" });
    expect(educationDatePlan(field({ id: "e", kind: "select", label: "End Date", options: [{ value: "x", label: "April" }, { value: "y", label: "May" }] }), [degree], profile)).toMatchObject({ action: "fill", value: "x", optionLabel: "April" });
    expect(educationDatePlan(field({ id: "ey", kind: "select", label: "End Date", options: years }), [degree], profile)).toMatchObject({ action: "fill", value: "2027" });
  });
  it("leaves job start dates and unrelated selects to JEV", () => {
    expect(educationDatePlan(field({ id: "j", kind: "select", label: "Start Date", options: months }), [field({ label: "Phone" })], profile)).toBeNull();
    expect(educationDatePlan(field({ id: "k", kind: "select", label: "Country", options: years }), [degree], profile)).toBeNull();
  });
  it("asks for review when no option matches", () => {
    expect(educationDatePlan(field({ id: "r", kind: "select", label: "Start Date", options: [{ value: "a", label: "2010" }, { value: "b", label: "2011" }] }), [degree], profile)?.action).toBe("review");
  });
});

describe("long option lists, salary boxes and split confidence", () => {
  const j = job(["Toronto, ON"]);
  const many = Array.from({ length: 60 }, (_, i) => ({ value: `v${i}`, label: `Country ${i}` }));
  it("asks for a value, not an option index, when a list is too long to show", () => {
    const long = field({ kind: "select", label: "Country", options: many });
    expect(hasChoosableOptions(long)).toBe(false);
    expect(hasChoosableOptions(field({ kind: "select", label: "Country", options: many.slice(0, 5) }))).toBe(true);
    const q = questionsFor([long]);
    expect(Object.keys((q.f0 as { criteria: Record<string, string> }).criteria)).toContain("country");
    expect(planField(long, { type: "choice", choice: "country", probabilities: { country: 1 }, confidence: 1 }, profile, j)).toMatchObject({ action: "fill", value: "Canada" });
  });
  it("puts the standing wording in a salary box that will not submit empty, and leaves an optional one blank", () => {
    const answer = { type: "choice" as const, choice: "salary_expectation", probabilities: {}, confidence: 0.9 };
    expect(planField(field({ label: "Desired Pay", required: true }), answer, profile, j)).toMatchObject({ action: "fill", value: "Negotiable" });
    expect(planField(field({ label: "Salary expectations", required: false }), answer, profile, j).action).toBe("skip");
  });
  it("adds up the probability of keys that would write the same value", () => {
    const split = { type: "choice" as const, choice: "country", probabilities: { country: 0.4, citizenship: 0.35, work_authorization_country: 0.2, city: 0.05 }, confidence: 0.4 };
    const planned = planField(field({ label: "In which country will you be based?" }), split, profile, j);
    expect(planned).toMatchObject({ action: "fill", value: "Canada" });
    expect(planned.confidence).toBeGreaterThan(0.9);
  });
  it("drafts an open question even when its intent is only a guess", () => {
    const guess = { type: "choice" as const, choice: "bank:why_company", probabilities: {}, confidence: 0.3 };
    expect(planField(field({ kind: "textarea", label: "What motivates you?" }), guess, profile, j)).toMatchObject({ action: "draft", key: "why_company" });
    expect(planField(field({ kind: "text", label: "Mystery" }), { ...guess, choice: "city" }, profile, j).action).toBe("review");
  });
});

describe("isApplicationForm", () => {
  const dumpOf = (fields: DumpedField[]) => FieldsDump.parse({ url: "https://x", fields });
  it("tells an application from a page that merely has inputs", () => {
    expect(isApplicationForm(dumpOf([field({ kind: "select", label: "region" }), field({ kind: "select", label: "region" }), field({ label: "Search" })]))).toBe(false);
    expect(isApplicationForm(dumpOf([field({ label: "First Name" }), field({ kind: "email", label: "Email" })]))).toBe(true);
    expect(isApplicationForm(dumpOf([field({ kind: "file", label: "Attach" })]))).toBe(true);
    expect(isApplicationForm(dumpOf([]))).toBe(false);
  });
  it("does not take a job alert or a newsletter box for an application", () => {
    expect(isApplicationForm(dumpOf([field({ kind: "email", label: "Email me jobs like this" })]))).toBe(false);
    expect(isApplicationForm(dumpOf([field({ label: "First name" }), field({ kind: "email", label: "Email" })]))).toBe(true);
    expect(isApplicationForm(dumpOf([field({ kind: "file", label: "Resume/CV (Attach)" })]))).toBe(true);
  });
});

describe("work history, signatures and combined contact boxes", () => {
  const j = job(["Toronto, ON"]);
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][i] as string }));
  const company = field({ id: "c", label: "Company name" });
  const title = field({ id: "t", label: "Title" });
  const school = field({ id: "s", label: "School" });
  it("tells a work-history block from an education block by the nearest field above", () => {
    expect(sectionOf([school, company, title])).toBe("employment");
    expect(sectionOf([company, title, field({ label: "Start date month" }), field({ label: "Start date year" })])).toBe("employment");
    expect(sectionOf([company, school, field({ label: "Degree" })])).toBe("education");
    expect(sectionOf([field({ label: "Phone" })])).toBeNull();
  });
  it("fills work-history dates from the most recent job, not from the degree or the job start", () => {
    const above = [company, title];
    expect(employmentDatePlan(field({ kind: "select", label: "Start date month", options: months }), above, profile)).toMatchObject({ action: "fill", optionLabel: "May", key: "employment_start_date" });
    expect(employmentDatePlan(field({ kind: "text", label: "Start date year" }), above, profile)).toMatchObject({ action: "fill", value: "2026" });
    expect(employmentDatePlan(field({ kind: "select", label: "End date month", options: months }), above, profile)).toMatchObject({ action: "fill", optionLabel: "August" });
    expect(employmentDatePlan(field({ kind: "checkbox", label: "Current role" }), above, profile)).toMatchObject({ action: "skip" });
    expect(employmentDatePlan(field({ kind: "select", label: "Start date month", options: months }), [school], profile)).toBeNull();
    expect(employmentDatePlan(field({ kind: "text", label: "Phone" }), above, profile)).toBeNull();
  });
  it("never types a name to sign an agreement", () => {
    const answer = { type: "choice" as const, choice: "full_name", probabilities: { full_name: 1 }, confidence: 1 };
    expect(planField(field({ label: "Please Review the NDA and indicate your agreement by typing your full name below", required: true }), answer, profile, j)).toMatchObject({ action: "review", key: "signature" });
    expect(planField(field({ label: "Full name" }), answer, profile, j)).toMatchObject({ action: "fill", value: "Ada Lovelace" });
  });
  it("never picks an interview or assessment slot, but still answers ordinary date questions", () => {
    const opt = (l: string) => ({ value: l, label: l });
    const slots = field({ kind: "combobox", required: true, label: "Please select your preferred date to complete the assessment on campus", options: ["Wednesday, October 14 (Evening)", "Thursday, October 15 (Evening)", "Unavailable for in-person assessment"].map(opt) });
    expect(isSlotChoice(slots)).toBe(true);
    expect(planField(slots, { type: "choice", choice: "o2", probabilities: {}, confidence: 0.9 }, profile, j)).toMatchObject({ action: "review", key: "schedule" });
    expect(isSlotChoice(field({ kind: "select", label: "When is your expected graduation date?", options: ["December 2026", "May 2027", "Spring 2028"].map(opt) }))).toBe(false);
    expect(isSlotChoice(field({ kind: "select", label: "Which session of the program?", options: ["Summer (May to August)", "Fall (September to December)"].map(opt) }))).toBe(false);
    expect(isSlotChoice(field({ kind: "select", label: "Interview availability", options: ["Mon Oct 12, 9:00", "Tue Oct 13, 14:30"].map(opt) }))).toBe(true);
  });
  it("answers a box that wants both a phone and an email with both", () => {
    expect(valueFor(profile, "phone_and_email")).toBe("+1 5555550123, ada@example.com");
  });
});

describe("which document a file box asks for", () => {
  const box = (label: string, name = "", selector = "#x") => ({ label, name, hint: "", selector });
  it("reads the question, not the button", () => {
    expect(fileBoxWants(box("Resume/CV (Attach)", "resume", "#resume"))).toBe("resume");
    expect(fileBoxWants(box("Please provide a recent transcript of your undergraduate studies (Attach)", "question_1"))).toBe("transcript");
    expect(fileBoxWants(box("Cover Letter (Attach)", "cover_letter"))).toBe("cover");
    expect(fileBoxWants(box("Autofill from resume"))).toBe("autofill");
    expect(fileBoxWants(box("Attach", "question_2"))).toBe("unnamed");
  });
  it("never takes a transcript box for the resume, even when both words appear", () => {
    expect(fileBoxWants(box("Upload your transcript (not your resume)"))).toBe("transcript");
  });
  it("tells a graduate transcript box from the undergraduate one", () => {
    expect(fileBoxWants(box("If applicable, please provide a recent transcript of your graduate studies (Attach)"))).toBe("graduate_transcript");
    expect(fileBoxWants(box("Please provide a transcript of your undergraduate studies"))).toBe("transcript");
  });
});


describe("a choice among a few statements about the person that code cannot check", () => {
  const yesNo = [{ value: "1", label: "Yes" }, { value: "0", label: "No" }];
  const pick = (choice: string, confidence: number) => ({ type: "choice", choice, confidence, probabilities: {} }) as never;
  const j = { id: "x", source: "t", company: "Acme", title: "Software Engineer", url: "https://example.com", ats: "greenhouse", locations: ["Mountain View, CA"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null, description: "", descriptionSource: "none" } as never;
  const office = field({ kind: "combobox", label: "This position requires 4 days a week in office. Are you able to meet this requirement?", options: yesNo, required: true });

  it("goes to the writer when JEV only leans one way", () => {
    expect(planField(office, pick("o1", 0.75), profile, j)).toMatchObject({ action: "review", optionLabel: "No" });
  });

  it("is filled when JEV is sure", () => {
    const worked = field({ kind: "radio", label: "Have you worked for Acme before?", options: yesNo, required: true });
    expect(planField(worked, pick("o1", 0.75), profile, j)).toMatchObject({ action: "review" });
    expect(planField(worked, pick("o1", 0.9), profile, j)).toMatchObject({ action: "fill", optionLabel: "No" });
  });

  it("leaves a question about where the person will work to the writer, however sure JEV is", () => {
    const based = field({ kind: "radio", label: "Are you currently based, or planning to be based in NYC and able to work on-site 3 days a week?", options: yesNo, required: true });
    expect(planField(based, pick("o1", 0.95), profile, j)).toMatchObject({ action: "review" });
    const lives = field({ kind: "radio", label: "Are you currently living in the UK?", options: yesNo, required: true });
    expect(planField(lives, pick("o1", 0.95), profile, j)).toMatchObject({ action: "fill", optionLabel: "No" });
  });

  it("covers a short list that is not yes or no", () => {
    const how = field({ kind: "radio", label: "Flexible Working", options: [{ value: "a", label: "In one of our offices" }, { value: "b", label: "Hybrid" }, { value: "c", label: "Fully remote" }], required: true });
    expect(planField(how, pick("o2", 0.69), profile, j)).toMatchObject({ action: "review" });
    expect(planField(how, pick("o1", 0.85), profile, j)).toMatchObject({ action: "fill", optionLabel: "Hybrid" });
  });

  it("leaves a long list at the usual floor", () => {
    const list = field({ kind: "select", label: "How did you hear about us?", options: ["Job board", "Referral", "LinkedIn", "Career fair", "GitHub", "Event", "Other"].map((label) => ({ value: label, label })) });
    expect(planField(list, pick("o0", 0.6), profile, j)).toMatchObject({ action: "fill", optionLabel: "Job board" });
  });

  it("gives a box for first and last name both names, whichever name JEV took it for", () => {
    const name = field({ label: "Name (first & last)", hint: "Please enter the name you go by day-to-day.", required: true });
    expect(planField(name, { type: "choice", choice: "preferred_name", probabilities: {}, confidence: 0.73 }, profile, j)).toMatchObject({ action: "fill", key: "full_name", value: `${profile.name.first} ${profile.name.last}` });
    expect(planField(field({ label: "First name" }), { type: "choice", choice: "first_name", probabilities: {}, confidence: 0.95 }, profile, j)).toMatchObject({ value: profile.name.first });
  });
});

describe("a question about needing a work authorization", () => {
  it("is a question about sponsorship, not about being authorized", () => {
    const q = (label: string) => categoryOf({ label, section: "", hint: "", kind: "select" });
    expect(q("Do you require work authorization? (required)")).toBe("sponsorship");
    expect(q("Will you need a work visa to take this job?")).toBe("sponsorship");
    expect(q("Will you now or in the future require sponsorship for employment visa status?")).toBe("sponsorship");
    expect(q("Will you now or in the future require authorization to work in the United States?")).toBe("sponsorship");
    expect(categoryOf({ label: "Will you now or in the future require authorization to work in the United States?", section: "Are you legally authorized to work in the United States?", hint: "", kind: "radio" })).toBe("sponsorship");
    expect(q("Are you legally authorized to work in the United States?")).toBe("authorization");
    expect(q("Are you authorized to work in Canada without requiring sponsorship?")).toBe("authorization");
  });
});

describe("a field of study a list knows by another name", () => {
  const first = profile.education[0];
  if (!first) throw new Error("the example profile has no education");
  const withAlso = { ...profile, education: [{ ...first, fieldAlso: ["Computer Science"] }] } as typeof profile;

  it("is offered to a list under the names the profile gives, and to nothing else", () => {
    expect(alternatesFor({ key: "major", kind: "combobox" }, withAlso)).toEqual({ alternates: ["Computer Science"] });
    expect(alternatesFor({ key: "major", kind: "text" }, withAlso)).toEqual({});
    expect(alternatesFor({ key: "school", kind: "combobox" }, withAlso)).toEqual({});
    expect(alternatesFor({ key: "major", kind: "combobox" }, { ...profile, education: [{ ...first, fieldAlso: undefined }] } as typeof profile)).toEqual({});
  });
});

describe("a date asked for in three boxes", () => {
  it("gives each box its own part, and a date that names only a month starts on its first day", () => {
    expect(datePart("Month", "May 2027")).toBe("5");
    expect(datePart("Day", "May 2027")).toBe("1");
    expect(datePart("Year", "May 2027")).toBe("2027");
    expect(datePart("Month*", "05/14/2027")).toBe("5");
    expect(datePart("DD", "05/14/2027")).toBe("14");
  });

  it("leaves alone a box that is not one of the three, and a value that is not a date", () => {
    expect(datePart("Start month and year", "May 2027")).toBeNull();
    expect(datePart("Month", "as soon as possible")).toBeNull();
  });
});
