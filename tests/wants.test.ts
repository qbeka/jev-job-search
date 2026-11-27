import { describe, expect, it } from "vitest";
import { fitQuestions, scoreFromAnswers } from "../src/jobs/rate.js";
import type { Job } from "../src/jobs/normalize.js";
import { inPlaces, levelRefusedByTitle, placeMultiplier, wantsOf, type Wants } from "../src/jobs/wants.js";
import { locationTier } from "../src/jobs/hardFilters.js";
import { LOCATION_MULTIPLIER, PLACE_MULTIPLIER } from "../src/config.js";
import type { Answer } from "../src/jev/types.js";

const now = new Date("2026-10-02T12:00:00Z");
const job = (over: Partial<Job> = {}): Job => ({
  id: "j", source: "t", company: "Acme", title: "Software Engineer, New Grad", url: "https://job-boards.greenhouse.io/acme/jobs/1", ats: "greenhouse",
  locations: ["New York, NY"], postedAt: "2026-10-01", terms: [], sponsorship: "unknown", degrees: [], category: null, ...over,
});
const us = { authorized: true, citizen: true };
const w = (over: Partial<Wants> = {}): Wants => ({ levels: [], places: [], remote: "open", relocate: true, areas: [], ...over });

function answers(over: Record<string, Partial<Answer>> = {}): Record<string, Answer> {
  const base: Record<string, Answer> = {
    is_software_role: { type: "noul", noul: 0.98 },
    level: { type: "choice", choice: "internship", probabilities: { internship: 1 }, confidence: 1 },
    is_unpaid: { type: "noul", noul: 0.02 },
    needs_advanced_degree: { type: "noul", noul: 0.02 },
    work_auth: { type: "choice", choice: "canada_ok", probabilities: { canada_ok: 1 }, confidence: 1 },
    term: { type: "choice", choice: "summer", probabilities: { summer: 1 }, confidence: 1 },
    graduation_excluded: { type: "noul", noul: 0.05 },
    returning_student_required: { type: "noul", noul: 0.2 },
    stack_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    experience_match: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
    location_tier: { type: "choice", choice: "canada", probabilities: {}, confidence: 1 },
    interview_practical: { type: "noul", noul: 0.3 },
    callback_likelihood: { type: "score", score: 3, legend: { "3": "Likely" }, probabilities: {}, confidence: 0.7 },
    needs_account: { type: "noul", noul: 0.1 },
    requires_references: { type: "noul", noul: 0.05 },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...(base[k] as Answer), ...v } as Answer;
  return base;
}


describe("wantsOf", () => {
  const prefs = (p: Record<string, unknown>) => ({ preferences: { remote: "open", willingToRelocate: "yes", preferredLocations: [], ...p } }) as never;
  it("treats both kinds, or none, as no preference", () => {
    expect(wantsOf(prefs({ roleTypes: ["internship", "new_grad"] })).levels).toEqual([]);
    expect(wantsOf(prefs({})).levels).toEqual([]);
    expect(wantsOf(prefs({ roleTypes: ["new_grad", "part_time"] })).levels).toEqual(["new_grad"]);
  });
});

describe("levelRefusedByTitle", () => {
  it("drops internships for someone who asked for new grad roles only", () => {
    expect(levelRefusedByTitle("Software Engineer Intern", w({ levels: ["new_grad"] }))).toMatch(/internship/);
    expect(levelRefusedByTitle("Summer Analyst Intern - Multiple Teams", w({ levels: ["new_grad"] }))).toMatch(/internship/);
    expect(levelRefusedByTitle("Software Engineer Co-op", w({ levels: ["new_grad"] }))).toMatch(/internship/);
    expect(levelRefusedByTitle("Software Engineer New Grad", w({ levels: ["new_grad"] }))).toBeNull();
    expect(levelRefusedByTitle("International Payments Engineer", w({ levels: ["new_grad"] }))).toBeNull();
  });
  it("drops full-time roles for someone who asked for internships only, and nothing without a preference", () => {
    expect(levelRefusedByTitle("Software Engineer, New Grad", w({ levels: ["internship"] }))).toMatch(/full-time/);
    expect(levelRefusedByTitle("Software Engineer Intern", w({ levels: ["internship"] }))).toBeNull();
    expect(levelRefusedByTitle("Software Engineer Intern", w())).toBeNull();
  });
});

describe("placeMultiplier", () => {
  const tier = (locs: string[]) => locationTier(locs);
  it("keeps the default tiers when no places are named", () => {
    expect(placeMultiplier({ locations: ["Austin, TX"] }, "us", w())).toBe(LOCATION_MULTIPLIER.us);
  });
  it("ranks the person's own places first, by any common spelling", () => {
    const nyc = w({ places: ["New York"] });
    for (const loc of ["New York, NY", "NYC", "Hybrid - New York, NY", "Brooklyn, NY"]) expect(placeMultiplier({ locations: [loc] }, tier([loc]), nyc)).toBe(PLACE_MULTIPLIER.preferred);
    expect(placeMultiplier({ locations: ["Austin, TX"] }, "us", nyc)).toBe(PLACE_MULTIPLIER.sameCountryWillMove);
    expect(placeMultiplier({ locations: ["Austin, TX"] }, "us", w({ places: ["New York"], relocate: false }))).toBe(PLACE_MULTIPLIER.sameCountry);
    expect(placeMultiplier({ locations: ["London, UK"] }, "international", nyc)).toBe(PLACE_MULTIPLIER.elsewhereWillMove);
    expect(placeMultiplier({ locations: ["Toronto, ON"] }, "canada", nyc)).toBe(PLACE_MULTIPLIER.elsewhereWillMove);
  });
  it("counts remote by how the person feels about it", () => {
    expect(placeMultiplier({ locations: ["Remote"] }, "remote", w({ places: ["New York"] }))).toBe(PLACE_MULTIPLIER.remoteOpen);
    expect(placeMultiplier({ locations: ["Remote"] }, "remote", w({ places: ["New York", "Remote"] }))).toBe(PLACE_MULTIPLIER.remoteWanted);
    expect(placeMultiplier({ locations: ["Remote in USA"] }, "us", w({ places: ["New York"], remote: "no" }))).toBe(PLACE_MULTIPLIER.sameCountryWillMove);
  });
  it("does not match a place inside another word", () => {
    expect(inPlaces(["Los Angeles, CA"], ["LA"])).toBe(true);
    expect(inPlaces(["Atlanta, GA"], ["LA"])).toBe(false);
    expect(inPlaces(["Vancouver, WA"], ["Vancouver"])).toBe(true);
  });
});

describe("scoreFromAnswers with what the person asked for", () => {
  it("skips a rated internship for a new-grad-only person, and ranks new grad roles above it otherwise", () => {
    const intern = answers({ level: { choice: "internship", confidence: 0.9 } });
    const grad = answers({ level: { choice: "new_grad", confidence: 0.9 }, term: { choice: "new_grad" } });
    const only = w({ levels: ["new_grad"], places: ["New York"] });
    expect(scoreFromAnswers(job({ title: "Platform Engineer" }), intern, now, us, only).skipReason).toMatch(/internship/);
    expect(scoreFromAnswers(job(), grad, now, us, only).decision).toBe("apply");
    const unsure = answers({ level: { choice: "internship", confidence: 0.5 } });
    const fit = scoreFromAnswers(job({ title: "Platform Engineer" }), unsure, now, us, only);
    expect(fit.skipReason).toBeNull();
    expect(fit.score).toBeLessThan(scoreFromAnswers(job(), grad, now, us, only).score);
  });
  it("ranks a job in the person's city above the same job elsewhere", () => {
    const grad = answers({ level: { choice: "new_grad" }, term: { choice: "new_grad" } });
    const nyc = w({ places: ["New York"] });
    expect(scoreFromAnswers(job(), grad, now, us, nyc).score).toBeGreaterThan(scoreFromAnswers(job({ locations: ["Owego, NY"] }), grad, now, us, nyc).score);
  });
  it("adds the area match only when areas were named, and asks for it only then", () => {
    const grad = answers({ level: { choice: "new_grad" }, term: { choice: "new_grad" } });
    const ml = w({ areas: ["Machine learning"] });
    const strong = scoreFromAnswers(job(), { ...grad, area_match: { type: "score", score: 4, legend: {}, probabilities: {}, confidence: 0.9 } as Answer }, now, us, ml).score;
    const weak = scoreFromAnswers(job(), { ...grad, area_match: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 0.9 } as Answer }, now, us, ml).score;
    expect(strong).toBeGreaterThan(weak);
    expect(scoreFromAnswers(job(), grad, now, us, w()).components.areaMatch).toBeUndefined();
    const edu = [{ gradMonth: 5, gradYear: 2027 }] as never;
    expect(fitQuestions({ education: edu, preferences: { engineeringAreas: ["Machine learning"] } as never })).toHaveProperty("area_match");
    expect(fitQuestions({ education: edu })).not.toHaveProperty("area_match");
  });
});
