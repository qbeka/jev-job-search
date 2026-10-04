import { describe, expect, it } from "vitest";
import { ageDays, atsFromUrl, canonicalUrl, dedupe, hostIs, jobId, parseLooseDate, postingKey, type Job } from "../src/jobs/normalize.js";

describe("postingKey", () => {
  it("gives one id to every way a list links the same posting", () => {
    expect(postingKey("https://www.pinterestcareers.com/jobs/?gh_jid=8138049")).toBe("greenhouse:8138049");
    expect(postingKey("https://job-boards.greenhouse.io/pinterest/jobs/8138049")).toBe("greenhouse:8138049");
    expect(postingKey("https://boards.greenhouse.io/embed/job_app?for=pinterest&token=8138049")).toBe("greenhouse:8138049");
    expect(postingKey("https://job-boards.eu.greenhouse.io/acme/jobs/4978937101")).toBe("greenhouse-eu:4978937101");
    const ashby = "https://jobs.ashbyhq.com/acme/134c282c-2837-44a8-9f7c-74ca39486490";
    expect(postingKey(`${ashby}/application?embed=true`)).toBe(postingKey(`${ashby}?locationId=6fdca225`));
    expect(jobId("https://stripe.com/jobs/search?gh_jid=8157838")).toBe(jobId("https://job-boards.greenhouse.io/stripe/jobs/8157838"));
  });

  it("keeps different postings apart and detects iCIMS behind a careers page", () => {
    expect(postingKey("https://www.pinterestcareers.com/jobs/?gh_jid=8138049")).not.toBe(postingKey("https://www.pinterestcareers.com/jobs/?gh_jid=7838591"));
    expect(postingKey("https://example.com/careers/42")).toBe("https://example.com/careers/42");
    expect(atsFromUrl("https://careers.example.com/jobs/5150?icims=1")).toBe("icims");
  });
});

describe("hostIs", () => {
  it("matches a domain and its subdomains, and nothing that merely contains it", () => {
    expect(hostIs("job-boards.greenhouse.io", "greenhouse.io")).toBe(true);
    expect(hostIs("greenhouse.io", "greenhouse.io")).toBe(true);
    expect(hostIs("greenhouse.io.example.com", "greenhouse.io")).toBe(false);
    expect(hostIs("notgreenhouse.io", "greenhouse.io")).toBe(false);
    expect(atsFromUrl("https://greenhouse.io.example.com/jobs/1")).toBe("other");
    expect(atsFromUrl("https://acme.wd5.myworkdayjobs.com/x")).toBe("workday");
  });
});

describe("canonicalUrl and jobId", () => {
  it("treats a posting and its form page as the same job", () => {
    const posting = "https://jobs.ashbyhq.com/acme/134c282c-2837-44a8-9f7c-74ca39486490";
    expect(canonicalUrl(`${posting}/application?embed=true`)).toBe(posting);
    expect(canonicalUrl(`${posting}?embed=true&locationId=6fdca225`)).toBe(posting);
    expect(jobId(`${posting}/application?embed=true`)).toBe(jobId(posting));
    expect(canonicalUrl("https://jobs.lever.co/acme/0a1b2c3d-0000-4000-8000-000000000000/apply")).toBe("https://jobs.lever.co/acme/0a1b2c3d-0000-4000-8000-000000000000");
  });

  it("drops tracking params and fragments so duplicates collapse", () => {
    const a = canonicalUrl("https://jobs.ashbyhq.com/replit/7e0d?utm_source=github-vansh-ouckah&ref=Simplify#top");
    const b = canonicalUrl("https://jobs.ashbyhq.com/replit/7e0d");
    expect(a).toBe(b);
    expect(jobId(a)).toBe(jobId(b));
  });
  it("keeps params that identify the job", () => {
    expect(canonicalUrl("https://stripe.com/jobs/search?gh_jid=8157838&utm_source=x")).toBe("https://stripe.com/jobs/search?gh_jid=8157838");
  });
});

describe("atsFromUrl", () => {
  it.each([
    ["https://job-boards.greenhouse.io/doordashcanada/jobs/8170944", "greenhouse"],
    ["https://stripe.com/jobs/search?gh_jid=8157838", "greenhouse"],
    ["https://jobs.lever.co/matchgroup/69396299/apply", "lever"],
    ["https://jobs.ashbyhq.com/cohere/8c035d3d", "ashby"],
    ["https://intactfc.wd3.myworkdayjobs.com/en-US/intactfc/job/x", "workday"],
    ["https://careers-kinaxis.icims.com/jobs/35372/job", "icims"],
    ["https://amazon.jobs/en/jobs/10553947/x", "amazon"],
    ["https://egup.fa.us2.oraclecloud.com/hcmUI/x", "oracle"],
    ["https://www.tesla.com/careers/search/job/x", "other"],
  ])("%s → %s", (url, ats) => {
    expect(atsFromUrl(url)).toBe(ats);
  });
});

describe("parseLooseDate", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  it("parses full and year-less dates", () => {
    expect(parseLooseDate("Sep 29, 2026", now)).toBe("2026-09-29");
    expect(parseLooseDate("Sep 09", now)).toBe("2026-09-09");
    expect(parseLooseDate("Sept 5", now)).toBe("2026-09-05");
    expect(parseLooseDate("2026-08-21", now)).toBe("2026-08-21");
  });
  it("assumes last year when a year-less date would be in the future", () => {
    expect(parseLooseDate("Dec 20", now)).toBe("2025-12-20");
  });
  it("returns null for junk", () => {
    expect(parseLooseDate("Rolling", now)).toBeNull();
  });
});

describe("ageDays and dedupe", () => {
  const base: Job = { id: "x", source: "a", company: "C", title: "T", url: "https://x", ats: "other", locations: [], postedAt: "2026-09-30", terms: [], sponsorship: "unknown", degrees: [], category: null };
  it("computes whole days", () => {
    expect(ageDays(base, new Date("2026-10-02T23:00:00Z"))).toBe(2);
    expect(ageDays({ postedAt: null })).toBeNull();
  });
  it("merges duplicates and keeps the richer record", () => {
    const a = { ...base, locations: ["Toronto, ON"], sponsorship: "unknown" as const };
    const b = { ...base, source: "b", locations: [], postedAt: null, sponsorship: "offers" as const };
    const [m] = dedupe([a, b]);
    expect(m?.locations).toEqual(["Toronto, ON"]);
    expect(m?.postedAt).toBe("2026-09-30");
    expect(m?.sponsorship).toBe("offers");
    expect(m?.source).toBe("a+b");
  });
});

describe("applyUrlFor", () => {
  it("builds direct form urls for the three main ATSs", async () => {
    const { applyUrlFor } = await import("../src/jobs/normalize.js");
    expect(applyUrlFor({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/pinterest/jobs/8138049" })).toBe("https://job-boards.greenhouse.io/embed/job_app?for=pinterest&token=8138049");
    expect(applyUrlFor({ ats: "greenhouse", url: "https://job-boards.eu.greenhouse.io/acme/jobs/4978937101" })).toBe("https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&token=4978937101");
    expect(applyUrlFor({ ats: "greenhouse", url: "https://stripe.com/jobs/search?gh_jid=8157838" })).toBe("https://stripe.com/jobs/search?gh_jid=8157838");
    // Workday: straight to the application. A careers page that only runs on Workday behind its own address is left as it is.
    expect(applyUrlFor({ ats: "workday", url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Intern_R1" })).toBe("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Intern_R1/apply/applyManually");
    expect(applyUrlFor({ ats: "workday", url: "https://careers.acme.com/job/1" })).toBe("https://careers.acme.com/job/1");
    expect(applyUrlFor({ ats: "lever", url: "https://jobs.lever.co/matchgroup/69396299-e587-4063-aef6-0ce2fd66e9ee" })).toBe("https://jobs.lever.co/matchgroup/69396299-e587-4063-aef6-0ce2fd66e9ee/apply");
    expect(applyUrlFor({ ats: "ashby", url: "https://jobs.ashbyhq.com/cohere/8c035d3d-081d-4c8a-914a-72f4efaad254" })).toBe("https://jobs.ashbyhq.com/cohere/8c035d3d-081d-4c8a-914a-72f4efaad254/application");
    expect(applyUrlFor({ ats: "other", url: "https://x/y" })).toBe("https://x/y");
  });
  it("finds the board's own form for a job linked through a careers page, when the source names the board", async () => {
    const { greenhouseFallbackUrl } = await import("../src/jobs/normalize.js");
    const viaCareers = { ats: "greenhouse" as const, url: "https://www.acme.com/careers/roles?gh_jid=123456" };
    expect(greenhouseFallbackUrl({ ...viaCareers, source: "simplify-newgrad+greenhouse:acme" })).toBe("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123456");
    expect(greenhouseFallbackUrl({ ...viaCareers, source: "simplify-newgrad" })).toBeNull();
    expect(greenhouseFallbackUrl({ ats: "lever", url: "https://jobs.lever.co/acme/x", source: "lever:acme" })).toBeNull();
  });
});
