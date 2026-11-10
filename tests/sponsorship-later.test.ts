import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileSchema, usStatus, type Profile } from "../src/profile/schema.js";
import { profileFacts, valueFor } from "../src/profile/fieldKeys.js";
import { authForCountry, buildFormState, gateAnswer, planField } from "../src/forms/mapForm.js";
import { preFilter } from "../src/jobs/hardFilters.js";
import { ratingKey } from "../src/jobs/rate.js";
import type { DumpedField, FieldsDump } from "../src/forms/fields.js";
import type { Job } from "../src/jobs/normalize.js";

const raw = JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")) as { workAuthorization: Record<string, unknown> };
const example = ProfileSchema.parse(raw);
/** The example candidate, authorized in Canada, who may also work in the US now (on OPT, say) but will need sponsorship later. */
const onOpt: Profile = { ...example, workAuthorization: { ...example.workAuthorization, authorizedWithSponsorshipLater: ["United States"] } };

const job = (locations: string[], over: Partial<Job> = {}): Job => ({ id: "j", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://x", ats: "greenhouse", locations, postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null, ...over });
const field = (over: Partial<DumpedField>): DumpedField => ({ id: "f0", widget: "", selector: "#x", kind: "text", name: "", label: "", hint: "", placeholder: "", required: false, value: "", options: [], accept: "", maxLength: null, autocomplete: "", buttonGroup: false, section: "", ...over });
const yesNo = [{ value: "1", label: "Yes" }, { value: "0", label: "No" }];
const pick = (choice: string) => ({ type: "choice", choice, confidence: 0.95, probabilities: {} }) as never;
const us = job(["New York, NY"]);
const ca = job(["Toronto, ON"]);
const authQ = field({ kind: "select", label: "Are you legally authorized to work in the United States?", options: yesNo, required: true });
const sponsorQ = field({ kind: "radio", label: "Will you now or in the future require sponsorship for employment visa status?", options: yesNo, required: true });

describe("a country where the candidate may work now but needs sponsorship later", () => {
  it("is optional, so a profile written before it still parses and means the same", () => {
    const { authorizedWithSponsorshipLater: _unused, ...older } = raw.workAuthorization;
    const parsed = ProfileSchema.parse({ ...raw, workAuthorization: older });
    expect(parsed.workAuthorization.authorizedWithSponsorshipLater).toBeUndefined();
    expect(authForCountry(parsed, "United States")).toEqual({ authorized: "No", requires_sponsorship: "Yes" });
    expect(usStatus(parsed)).toEqual({ authorized: false, citizen: false });
    expect(ratingKey(us, parsed)).toBe(ratingKey(us, example));
  });

  it("answers Yes to authorized and Yes to sponsorship there, and leaves other countries as they were", () => {
    expect(authForCountry(onOpt, "United States")).toEqual({ authorized: "Yes", requires_sponsorship: "Yes" });
    expect(authForCountry(onOpt, "Canada")).toEqual({ authorized: "Yes", requires_sponsorship: "No" });
    expect(authForCountry(onOpt, "Germany")).toEqual({ authorized: "No", requires_sponsorship: "Yes" });
  });

  it("wins over authorizedCountries when both name the country", () => {
    const both: Profile = { ...onOpt, workAuthorization: { ...onOpt.workAuthorization, authorizedCountries: ["Canada", "United States"] } };
    expect(authForCountry(both, "United States")).toEqual({ authorized: "Yes", requires_sponsorship: "Yes" });
    expect(usStatus(both).authorized).toBe(false);
  });

  it("lets the true answers through the form gate and holds the false ones", () => {
    expect(planField(authQ, pick("o0"), onOpt, us)).toMatchObject({ action: "fill", optionLabel: "Yes" });
    expect(planField(sponsorQ, pick("o0"), onOpt, us)).toMatchObject({ action: "fill", optionLabel: "Yes" });
    expect(gateAnswer(authQ, "Yes", onOpt, us)).toBeNull();
    expect(gateAnswer(sponsorQ, "Yes", onOpt, us)).toBeNull();
    expect(gateAnswer(authQ, "No", onOpt, us)).toMatch(/does not match the profile/);
    expect(gateAnswer(sponsorQ, "No", onOpt, us)).toMatch(/does not match the profile/);
    // A Canadian posting still needs no sponsorship.
    expect(gateAnswer(sponsorQ, "No", onOpt, ca)).toBeNull();
  });

  it("still drops a US posting that refuses sponsorship", () => {
    const status = usStatus(onOpt);
    expect(status).toEqual({ authorized: false, citizen: false });
    const now = new Date("2026-11-01");
    expect(preFilter(job(["Austin, TX"], { sponsorship: "none" }), now, () => false, status)).toMatch(/no sponsorship/);
    expect(preFilter(job(["Austin, TX"]), now, () => false, status)).toBeNull();
    // The rating takes the same status: see "a candidate who needs sponsorship later" in filters-and-rating.test.ts.
  });

  it("tells the form mapper and the writer, and names the country where a box asks where they may work", () => {
    expect(valueFor(onOpt, "work_authorization_country")).toBe("Canada, United States");
    expect(profileFacts(onOpt).authorized_now_but_needs_sponsorship_later_in).toBe("United States");
    expect(profileFacts(example)).not.toHaveProperty("authorized_now_but_needs_sponsorship_later_in");
    const dump = { url: "https://x", title: "Apply", context: "" } as unknown as FieldsDump;
    const state = buildFormState(onOpt, us, dump, []) as { candidate: { work_authorization: Record<string, unknown>; rules: string[] } };
    expect(state.candidate.work_authorization).toMatchObject({ authorized_now_but_needs_sponsorship_later_in: ["United States"], for_this_job: { authorized: "Yes", requires_sponsorship: "Yes" } });
    expect(state.candidate.rules[0]).toMatch(/authorized to work now in: United States, but will need visa sponsorship/);
    const plain = buildFormState(example, us, dump, []) as { candidate: { work_authorization: Record<string, unknown> } };
    expect(plain.candidate.work_authorization).not.toHaveProperty("authorized_now_but_needs_sponsorship_later_in");
  });
});
