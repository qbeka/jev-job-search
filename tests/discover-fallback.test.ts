import { describe, expect, it } from "vitest";
import { BELOW_BAR, promoteClosest, reasonGroup, topReasons, type Decided } from "../src/discover.js";
import { DISCOVER } from "../src/config.js";
import type { FitResult } from "../src/jobs/rate.js";
import type { Job } from "../src/jobs/normalize.js";

const job = (id: string): Job => ({ id, source: "t", company: "Acme", title: "Junior Developer", url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, ats: "greenhouse", locations: ["Remote"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null });
const fit = (score: number, decision: FitResult["decision"], skipReason: string | null = null): FitResult => ({ score, decision, skipReason, reasons: ["stack partial"], components: {}, locationTier: "remote", answers: {} });
const d = (id: string, f: FitResult | null, reason: string | null = null): Decided => ({ job: job(id), fit: f, reason });

describe("promoteClosest", () => {
  it("queues the closest below-the-bar jobs, marked, when nothing cleared the bar", () => {
    const decided = [d("a", fit(0.27, "below_threshold")), d("b", fit(0.2, "below_threshold")), d("c", fit(0.1, "below_threshold")), d("x", fit(0.5, "skip", "not a software role")), d("p", null, "posted 40 days ago")];
    expect(promoteClosest(decided, false)).toBe(2);
    expect(decided[0]!.fit!.decision).toBe("apply");
    expect(decided[0]!.fit!.reasons[0]).toBe(BELOW_BAR);
    expect(decided[2]!.fit!.decision).toBe("below_threshold"); // under fallbackMinScore
    expect(decided[3]!.fit!.decision).toBe("skip"); // a hard skip is never promoted
  });
  it("does nothing when a job cleared the bar, or the queue already has jobs", () => {
    const one = [d("a", fit(0.4, "apply")), d("b", fit(0.25, "below_threshold"))];
    expect(promoteClosest(one, false)).toBe(0);
    const two = [d("b", fit(0.25, "below_threshold"))];
    expect(promoteClosest(two, true)).toBe(0);
    expect(two[0]!.fit!.decision).toBe("below_threshold");
  });
  it("queues at most fallbackTop", () => {
    const many = Array.from({ length: DISCOVER.fallbackTop + 5 }, (_, i) => d(String(i), fit(0.2 + i / 1000, "below_threshold")));
    expect(promoteClosest(many, false)).toBe(DISCOVER.fallbackTop);
  });
});

describe("topReasons", () => {
  it("groups reasons of a kind and counts the most common first", () => {
    expect(reasonGroup("posted 16 days ago")).toBe("posted too long ago");
    expect(reasonGroup("workday (needs an account per company)")).toBe("needs an account on the employer's site");
    const decided = [d("1", null, "posted 16 days ago"), d("2", null, "posted 40 days ago"), d("3", fit(0.1, "skip", "not a software role")), d("4", fit(0.1, "below_threshold")), d("5", fit(0.5, "apply"))];
    expect(topReasons(decided)).toEqual([{ reason: "posted too long ago", count: 2 }, { reason: "not a software role", count: 1 }, { reason: "a weak fit for your profile", count: 1 }]);
  });
});
