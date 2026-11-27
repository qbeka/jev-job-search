import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPrompt, buildSystem, candidateContext, contextFingerprint, parseResolution, type OpenField } from "../src/answers/resolve.js";
import { ProfileSchema } from "../src/profile/schema.js";

const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
const open: OpenField[] = [{ selector: "#q1", kind: "textarea", label: "Why Acme?", question: "", hint: "", required: true, maxLength: 500, options: [], why: "needs writing (why_company)" }];

describe("parseResolution", () => {
  it("reads a bare object and one wrapped in a code fence", () => {
    const body = '{"verdict":"ready","reason":"","answers":[{"selector":"#q1","value":"Because."}]}';
    expect(parseResolution(body).answers[0]).toEqual({ selector: "#q1", value: "Because.", reusable: false });
    expect(parseResolution("```json\n" + body + "\n```").verdict).toBe("ready");
  });
  it("reads whether an answer holds for any company, and the note for the tracking sheet", () => {
    const r = parseResolution('{"verdict":"ready","answers":[{"selector":"#q1","value":"Yes","reusable":true}],"note":{"what_they_do":"Builds rockets.","why_fit":"Shipped six features."}}');
    expect(r.answers[0]?.reusable).toBe(true);
    expect(r.note).toEqual({ what_they_do: "Builds rockets.", why_fit: "Shipped six features." });
  });
  it("defaults the optional parts and rejects anything that is not a verdict", () => {
    expect(parseResolution('{"verdict":"skip"}')).toEqual({ verdict: "skip", reason: "", answers: [] });
    expect(() => parseResolution('{"verdict":"maybe"}')).toThrow();
    expect(() => parseResolution("I could not decide.")).toThrow(/JSON/);
  });
});

describe("the writer's prompt", () => {
  const system = buildSystem(profile);
  const context = candidateContext(profile) as Record<string, any>;
  const prompt = JSON.parse(buildPrompt(null, [{ label: "Email", value: "ada@example.com" }], open)) as Record<string, any>;
  it("puts the rules and the candidate in the system prompt, which is the same for every form", () => {
    expect(context.candidate.facts).toEqual(profile.facts);
    expect(context.candidate.standingAnswers).toEqual(profile.answers);
    expect(context.candidate.workAuthorization.authorizedCountries).toEqual(["Canada"]);
    expect(Object.keys(context.bank)).toContain("why_company");
    expect(system).toContain("Truth comes first.");
    expect(system).toContain(profile.facts[0] as string);
    expect(buildSystem(profile)).toBe(system);
  });
  it("asks the writer to mark what is reusable, and ties remembered answers to the candidate's context", () => {
    expect(system).toContain("reusable, on each answer: true only when");
    expect(contextFingerprint(profile)).toBe(contextFingerprint(profile));
    expect(contextFingerprint({ ...profile, facts: [...profile.facts, "A new fact."] })).not.toBe(contextFingerprint(profile));
  });
  it("keeps what changes per form in the prompt: the job, what is filled, what is open", () => {
    expect(Object.keys(prompt)).toEqual(["job", "already_filled", "open_fields"]);
    expect(prompt.already_filled).toEqual([{ label: "Email", value: "ada@example.com" }]);
    expect(prompt.open_fields[0]).toMatchObject({ selector: "#q1", required: true, maxLength: 500 });
  });
  it("includes the posting when there is one", () => {
    const entry = { job: { id: "j", source: "s", company: "Acme", title: "SWE Intern", url: "https://x/1", ats: "greenhouse", locations: ["Toronto, ON"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null, description: "We build rockets." }, fit: null, preFilterReason: null, status: "queued", statusReason: null, attempts: 0, discoveredAt: "", updatedAt: "", appliedAt: null, notes: null } as unknown as Parameters<typeof buildPrompt>[0];
    expect(JSON.parse(buildPrompt(entry, [], open)).job).toMatchObject({ company: "Acme", description: "We build rockets." });
  });
  it("carries no secret and no resume path", () => {
    const text = system + JSON.stringify(prompt);
    expect(text).not.toMatch(/sk-or-v1-|OPENROUTER/);
    expect(text).not.toContain(profile.resume.path);
  });
});

describe("the address the writer sees", () => {
  it("includes the street and postal code, so a form asking for them is not held", () => {
    const address = (candidateContext(profile) as { candidate: { address: Record<string, string> } }).candidate.address;
    expect(address.city).toBe(profile.address.city);
    expect(address.postalCode).toBe(profile.address.postalCode || undefined);
    expect(address.line1).toBe(profile.address.line1 || undefined);
  });
});
