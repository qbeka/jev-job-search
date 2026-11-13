import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileSchema, type Profile } from "../src/profile/schema.js";
import { categoryOf, countryOf, gateAnswer, planField, residenceOf, valueForJob } from "../src/forms/mapForm.js";
import type { DumpedField } from "../src/forms/fields.js";
import type { Job } from "../src/jobs/normalize.js";

const example = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
/** The example candidate lives in Canada and is authorized there only. */
const inCanada = example;
/** A student who lives in the United States and may work there now (on OPT, say) but will need sponsorship later. */
const inUs: Profile = {
  ...example,
  address: { ...example.address, city: "Boston", region: "Massachusetts", regionCode: "MA", postalCode: "02115", country: "United States", countryCode: "US" },
  workAuthorization: { ...example.workAuthorization, authorizedCountries: [], authorizedWithSponsorshipLater: ["United States"] },
};

const job = (locations: string[]): Job => ({ id: "j", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://x", ats: "ashby", locations, postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null });
const field = (over: Partial<DumpedField>): DumpedField => ({ id: "f0", widget: "", selector: "#x", kind: "text", name: "", label: "", hint: "", placeholder: "", required: false, value: "", options: [], accept: "", maxLength: null, autocomplete: "", buttonGroup: false, section: "", ...over });
const yesNo = [{ value: "1", label: "Yes" }, { value: "0", label: "No" }];
const pick = (choice: string) => ({ type: "choice", choice, confidence: 0.95, probabilities: {} }) as never;

/** A posting listed in Canada and the United States reads as Canadian. */
const canadaAndUs = job(["Toronto, ON", "San Francisco, CA"]);
const usOnly = job(["New York, NY"]);
const authQ = field({ kind: "radio", label: "Are you authorized to work in the country you currently reside in?", options: yesNo, required: true });
const sponsorQ = field({ kind: "radio", label: "Do you, now or in the future, require sponsorship to work in the country you currently reside in?", options: yesNo, required: true });

describe("a question about the country the candidate lives in", () => {
  it("is still a question about authorization or sponsorship", () => {
    expect(categoryOf(authQ)).toBe("authorization");
    expect(categoryOf(sponsorQ)).toBe("sponsorship");
  });

  it("means the candidate's country of residence, not the posting's", () => {
    expect(countryOf(authQ.label, canadaAndUs, inUs)).toBe("United States");
    expect(countryOf(sponsorQ.label, canadaAndUs, inUs)).toBe("United States");
    expect(countryOf(authQ.label, usOnly, inCanada)).toBe("Canada");
    for (const label of [
      "Are you legally authorized to work in your country of residence?",
      "Are you authorized to work in the country where you currently live?",
      "Are you authorized to work in the country you live in?",
      "Will you require sponsorship to work in your current country of residence?",
    ]) {
      expect(countryOf(label, canadaAndUs, inUs), label).toBe("United States");
    }
  });

  it("lets the true answers through for a candidate in the United States on a Canadian posting", () => {
    expect(gateAnswer(authQ, "Yes", inUs, canadaAndUs)).toBeNull();
    expect(gateAnswer(sponsorQ, "Yes", inUs, canadaAndUs)).toBeNull();
    expect(gateAnswer(authQ, "No", inUs, canadaAndUs)).toMatch(/which says Yes for United States/);
    expect(gateAnswer(sponsorQ, "No", inUs, canadaAndUs)).toMatch(/which says Yes for United States/);
    expect(planField(authQ, pick("o0"), inUs, canadaAndUs)).toMatchObject({ action: "fill", optionLabel: "Yes" });
    expect(planField(sponsorQ, pick("o0"), inUs, canadaAndUs)).toMatchObject({ action: "fill", optionLabel: "Yes" });
    expect(valueForJob(inUs, canadaAndUs, "authorized_to_work", authQ.label)).toBe("Yes");
    expect(valueForJob(inUs, canadaAndUs, "requires_sponsorship", sponsorQ.label)).toBe("Yes");
  });

  it("lets the true answers through for a candidate in Canada on a US posting", () => {
    expect(gateAnswer(authQ, "Yes", inCanada, usOnly)).toBeNull();
    expect(gateAnswer(sponsorQ, "No", inCanada, usOnly)).toBeNull();
    expect(gateAnswer(sponsorQ, "Yes", inCanada, usOnly)).toMatch(/which says No for Canada/);
  });

  it("gives way to a country the question names", () => {
    const named = "Are you authorized to work in Canada? We ask because you may not reside there.";
    expect(countryOf(named, usOnly, inUs)).toBe("Canada");
    expect(gateAnswer(field({ kind: "radio", label: named, options: yesNo }), "Yes", inUs, usOnly)).toMatch(/which says No for Canada/);
    expect(countryOf("Do you reside in the United States and are you authorized to work there?", canadaAndUs, inCanada)).toBe("United States");
  });

  it("does not read a permanent resident status as a place", () => {
    expect(countryOf("Are you a citizen or permanent resident of the country of this job?", canadaAndUs, inUs)).toBe("Canada");
    expect(countryOf("Do you hold permanent residence in the country of this job?", canadaAndUs, inUs)).toBe("Canada");
  });

  it("names the country of residence from the address, by name or by code", () => {
    expect(residenceOf(inUs)).toBe("United States");
    expect(residenceOf(inCanada)).toBe("Canada");
    expect(residenceOf({ ...inUs, address: { ...inUs.address, country: "USA" } })).toBe("United States");
    expect(residenceOf({ ...inUs, address: { ...inUs.address, country: "Germany", countryCode: "DE" } })).toBe("Germany");
  });
});
