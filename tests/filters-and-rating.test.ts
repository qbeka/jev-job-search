import { describe, expect, it } from "vitest";
import { DISCOVER } from "../src/config.js";
import { locationTier, preFilter } from "../src/jobs/hardFilters.js";
import type { Job } from "../src/jobs/normalize.js";
import { FIT_QUESTIONS, fitQuestions, scoreFromAnswers } from "../src/jobs/rate.js";
import { usStatus } from "../src/profile/schema.js";
import type { Answer } from "../src/jev/types.js";

const now = new Date("2026-10-02T12:00:00Z");
const job = (over: Partial<Job> = {}): Job => ({
  id: "j", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://job-boards.greenhouse.io/acme/jobs/1", ats: "greenhouse",
  locations: ["Toronto, ON, Canada"], postedAt: "2026-10-01", terms: ["Summer 2027"], sponsorship: "unknown", degrees: [], category: null, ...over,
});

describe("locationTier", () => {
  it.each([
    [["Vancouver, BC, Canada"], "vancouver"],
    [["Burnaby, BC"], "vancouver"],
    [["Toronto, ON"], "canada"],
    [["Montreal, QC, Canada"], "canada"],
    [["Remote"], "remote"],
    [["Remote in USA"], "us"],
    [["SF"], "us"],
    [["NYC"], "us"],
    [["Palo Alto, CA"], "us"],
    [["London, UK"], "international"],
    [[], "unclear"],
  ])("%j → %s", (locs, tier) => {
    expect(locationTier(locs)).toBe(tier);
  });
});

describe("preFilter", () => {
  it("passes a fresh Canadian software internship", () => {
    expect(preFilter(job(), now)).toBeNull();
  });
  it("rejects account-walled ATSs", () => {
    expect(preFilter(job({ ats: "workday" }), now)).toMatch(/workday/);
    expect(preFilter(job({ ats: "icims" }), now)).toMatch(/account/);
    expect(preFilter(job({ ats: "amazon" }), now)).toMatch(/account/);
  });
  it("rejects stale postings but keeps undated ones", () => {
    expect(preFilter(job({ postedAt: "2026-09-01" }), now)).toMatch(/days ago/);
    expect(preFilter(job({ postedAt: null }), now)).toBeNull();
  });
  it("rejects non-software titles unless they also say software", () => {
    expect(preFilter(job({ title: "Hardware Engineer Intern" }), now)).toMatch(/not a software role/);
    expect(preFilter(job({ title: "Product Manager Intern" }), now)).toMatch(/not a software role/);
    expect(preFilter(job({ title: "Software Engineer Intern, Hardware Tools" }), now)).toBeNull();
  });
  it("rejects US roles with no sponsorship or citizenship flags, but not Canadian ones", () => {
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "none" }), now)).toMatch(/no sponsorship/);
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "citizenship" }), now)).toMatch(/citizenship/);
    // A candidate who may work in the United States is not ruled out by "no sponsorship"; only a citizen passes a citizenship flag.
    const resident = { authorized: true, citizen: false };
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "none" }), now, () => false, resident)).toBeNull();
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "citizenship" }), now, () => false, resident)).toMatch(/citizenship/);
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "citizenship" }), now, () => false, { authorized: true, citizen: true })).toBeNull();
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "unknown" }), now)).toBeNull();
    expect(preFilter(job({ locations: ["Toronto, ON"], sponsorship: "none" }), now)).toBeNull();
  });
  it("rejects advanced-degree-only, French and unpaid postings", () => {
    expect(preFilter(job({ degrees: ["Master's", "PhD"] }), now)).toMatch(/advanced degree/);
    expect(preFilter(job({ degrees: ["Bachelor's", "Master's"] }), now)).toBeNull();
    expect(preFilter(job({ title: "Stagiaire en développement logiciel" }), now)).toMatch(/non-English/);
    expect(preFilter(job({ title: "Unpaid Software Intern" }), now)).toMatch(/unpaid/);
  });
});

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

describe("scoreFromAnswers", () => {
  it("asks every question the scorer reads", () => {
    for (const k of Object.keys(answers())) expect(FIT_QUESTIONS).toHaveProperty(k);
  });
  it("queues a strong, fresh Canadian internship", () => {
    const fit = scoreFromAnswers(job(), answers(), now);
    expect(fit.decision).toBe("apply");
    expect(fit.score).toBeGreaterThan(DISCOVER.applyThreshold);
    expect(fit.locationTier).toBe("canada");
  });
  it("ranks Vancouver above the same job in the US, and fresh above stale", () => {
    const van = scoreFromAnswers(job({ locations: ["Vancouver, BC"] }), answers(), now).score;
    const us = scoreFromAnswers(job({ locations: ["Austin, TX"] }), answers({ work_auth: { choice: "us_sponsors" } }), now).score;
    const stale = scoreFromAnswers(job({ locations: ["Vancouver, BC"], postedAt: "2026-09-19" }), answers(), now).score;
    expect(van).toBeGreaterThan(us);
    expect(van).toBeGreaterThan(stale);
  });
  it("skips on the hard rules regardless of score", () => {
    expect(scoreFromAnswers(job(), answers({ is_software_role: { noul: 0.2 } }), now).skipReason).toBe("not a software role");
    expect(scoreFromAnswers(job(), answers({ level: { choice: "experienced", confidence: 0.9 } }), now).skipReason).toMatch(/experience/);
    expect(scoreFromAnswers(job(), answers({ is_unpaid: { noul: 0.9 } }), now).skipReason).toBe("unpaid");
    expect(scoreFromAnswers(job(), answers({ needs_advanced_degree: { noul: 0.9 } }), now).skipReason).toMatch(/degree/);
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_no_sponsorship", confidence: 0.8 } }), now).skipReason).toMatch(/no sponsorship/);
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_citizenship_required", confidence: 0.8 } }), now).skipReason).toMatch(/citizenship/);
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_no_sponsorship", confidence: 0.8 } }), now, { authorized: true, citizen: false }).skipReason).toBeNull();
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_citizenship_required", confidence: 0.8 } }), now, { authorized: true, citizen: true }).skipReason).toBeNull();
    expect(scoreFromAnswers(job(), answers({ requires_references: { noul: 0.95 } }), now).skipReason).toMatch(/references/);
  });
  it("only trusts the account signal when the ATS is unknown", () => {
    expect(scoreFromAnswers(job({ ats: "greenhouse" }), answers({ needs_account: { noul: 0.95 } }), now).skipReason).toBeNull();
    expect(scoreFromAnswers(job({ ats: "other" }), answers({ needs_account: { noul: 0.95 } }), now).skipReason).toMatch(/account/);
  });
  it("uses JEV's location only when the code cannot tell", () => {
    const fit = scoreFromAnswers(job({ locations: [] }), answers({ location_tier: { choice: "remote" } }), now);
    expect(fit.locationTier).toBe("remote");
  });
});

describe("graduation window and account walls", () => {
  it("ranks a posting that asks for another graduation date lower, without dropping it", () => {
    const fits = scoreFromAnswers(job(), answers(), now);
    const excluded = scoreFromAnswers(job(), answers({ graduation_excluded: { noul: 0.95 } }), now);
    expect(excluded.decision).not.toBe("skip");
    expect(excluded.score).toBeLessThan(fits.score);
    expect(excluded.reasons).toContain("asks for a different graduation date");
  });
  it("reads a rating saved before the question existed as no mismatch", () => {
    const old = answers();
    delete old.graduation_excluded;
    expect(scoreFromAnswers(job(), old, now).score).toBe(scoreFromAnswers(job(), answers(), now).score);
  });
  it("words the term and graduation questions from the profile's own graduation date", () => {
    const q = fitQuestions({ education: [{ school: "U", degree: "BSc", field: "CS", startMonth: 9, startYear: 2025, gradMonth: 12, gradYear: 2028, status: "in_progress" }] });
    expect(JSON.stringify(q.term)).toContain("Summer 2028");
    expect(JSON.stringify(q.graduation_excluded)).toContain("December 2028");
    for (const k of Object.keys(answers())) expect(q).toHaveProperty(k);
  });
  it("skips careers sites that need an account and boards whose forms cannot be read", () => {
    expect(preFilter(job({ url: "https://acme.eightfold.ai/careers/job/1", ats: "other" }), now, () => true)).toMatch(/account/);
    // An older posting passes when one search asks for more days.
    const old = job({ postedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString().slice(0, 10) });
    expect(preFilter(old, now, () => false)).toMatch(/posted 20 days ago/);
    expect(preFilter(old, now, () => false, { authorized: false, citizen: false }, 30)).toBeNull();
    // Jobvite's forms run over several pages, which the runner walks. SmartRecruiters' cannot be read yet.
    expect(preFilter(job({ ats: "jobvite" }), now, () => false)).toBeNull();
    expect(preFilter(job({ ats: "smartrecruiters" }), now, () => false)).toMatch(/cannot be read/);
    expect(preFilter(job(), now, () => false)).toBeNull();
  });
});

describe("usStatus", () => {
  const wa = (authorizedCountries: string[], citizenships: string[]) => ({ workAuthorization: { citizenships, authorizedCountries, requiresSponsorshipElsewhere: true, statement: "" } });
  it("reads the candidate's standing in the United States from the profile, however the country is written", () => {
    expect(usStatus(wa(["Canada"], ["Canada"]))).toEqual({ authorized: false, citizen: false });
    expect(usStatus(wa(["United States"], ["India"]))).toEqual({ authorized: true, citizen: false });
    expect(usStatus(wa(["USA", "Canada"], ["U.S."]))).toEqual({ authorized: true, citizen: true });
  });
  it("counts a candidate who needs sponsorship later as not authorized without it, so the rating still skips a refusal", () => {
    const later = { workAuthorization: { ...wa(["Canada"], ["Canada"]).workAuthorization, authorizedWithSponsorshipLater: ["U.S."] } };
    expect(usStatus(later)).toEqual({ authorized: false, citizen: false });
    const refuses = answers({ work_auth: { choice: "us_no_sponsorship", confidence: 0.8 } });
    expect(scoreFromAnswers(job({ locations: ["SF"] }), refuses, new Date("2026-11-01"), usStatus(later)).skipReason).toMatch(/no sponsorship/);
  });
});

