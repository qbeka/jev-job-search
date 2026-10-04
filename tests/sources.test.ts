import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReadmeTable } from "../src/sources/githubReadme.js";
import { parseSimplify } from "../src/sources/simplify.js";
import { parseSheetCsv } from "../src/sources/sheetImport.js";
import { greenhouseJobId, greenhouseSlug } from "../src/sources/ats/greenhouse.js";
import { ashbyJobId, ashbySlug } from "../src/sources/ats/ashby.js";
import { leverJobId, leverSlug } from "../src/sources/ats/lever.js";
import { boardsFromJobs } from "../src/sources/companies.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const now = new Date("2026-10-02T12:00:00Z");

describe("README table parser", () => {
  it("reads the badge-link format and skips closed rows", () => {
    const jobs = parseReadmeTable(fixture("canadian-2027.md"), "canadian-2027", now);
    expect(jobs.length).toBeGreaterThan(200);
    expect(jobs.every((j) => !/shields\.io|imgur/.test(j.url))).toBe(true);
    const intact = jobs.find((j) => j.company === "Intact");
    expect(intact?.url).toMatch(/myworkdayjobs\.com/);
    expect(intact?.postedAt).toBe("2026-09-29");
    expect(intact?.terms).toEqual(["Winter 2027"]);
    expect(jobs.some((j) => /Processor Complex Engineer/.test(j.title))).toBe(false);
  });
  it("reads the html-link format with sponsorship flags and carried-over company names", () => {
    const jobs = parseReadmeTable(fixture("vansh-2027.md"), "vansh-2027", now);
    const vertiv = jobs.filter((j) => j.company === "Vertiv");
    expect(vertiv.length).toBe(2);
    expect(vertiv[0]?.sponsorship).toBe("none");
    expect(vertiv[0]?.title).not.toMatch(/🛂/);
    const teledyne = jobs.find((j) => /Teledyne/.test(j.company));
    expect(teledyne?.sponsorship).toBe("citizenship");
    expect(jobs.find((j) => j.company === "Replit")?.ats).toBe("ashby");
    expect(jobs.find((j) => j.company === "Replit")?.url).not.toMatch(/utm_source/);
  });
  it("reads the small Canada list", () => {
    const jobs = parseReadmeTable(fixture("canada-summer-2027.md"), "canada-summer-2027", now);
    expect(jobs.length).toBeGreaterThan(10);
    expect(jobs.find((j) => j.company === "Doordash")?.ats).toBe("greenhouse");
  });
});

describe("Simplify listings parser", () => {
  it("keeps active, visible software rows and maps fields", () => {
    const raw = [
      { category: "Software", company_name: "Acme", title: "SWE Intern", active: true, is_visible: true, terms: ["Summer 2027"], date_posted: 1790899200, url: "https://job-boards.greenhouse.io/acme/jobs/1?utm_source=Simplify", locations: ["Toronto, ON, Canada"], sponsorship: "Offers Sponsorship", degrees: ["Bachelor's"] },
      { category: "Hardware", company_name: "Acme", title: "HW Intern", active: true, date_posted: 1790899200, url: "https://x/2", locations: [] },
      { category: "Software", company_name: "Old", title: "Closed", active: false, date_posted: 1790899200, url: "https://x/3", locations: [] },
    ];
    const jobs = parseSimplify(raw, "simplify-internships");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Acme", ats: "greenhouse", sponsorship: "offers", postedAt: "2026-10-02", terms: ["Summer 2027"] });
    expect(jobs[0]?.url).not.toMatch(/utm_source/);
  });
});

describe("sheet import", () => {
  it("turns unapplied rows into jobs", () => {
    const csv = 'Company,What They Do,Role / Title,Location,Visa / Work Auth,Job Link,App. Status\r\nStripe,Payments,Software Engineer New Grad,"Toronto, ON",Canada,https://stripe.com/jobs/search?gh_jid=8157838,Not applied\r\nZip,Procurement,SWE,Toronto,Canada,https://jobs.ashbyhq.com/zip/b5242472,Applied\r\n';
    const jobs = parseSheetCsv(csv);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Stripe", title: "Software Engineer New Grad", ats: "greenhouse", source: "sheet" });
  });
});

describe("ATS url helpers and board discovery", () => {
  it("extracts slugs and ids", () => {
    expect(greenhouseSlug("https://job-boards.greenhouse.io/doordashcanada/jobs/8170944")).toBe("doordashcanada");
    expect(greenhouseJobId("https://job-boards.greenhouse.io/doordashcanada/jobs/8170944")).toBe("8170944");
    expect(greenhouseJobId("https://stripe.com/jobs/search?gh_jid=8157838")).toBe("8157838");
    expect(leverSlug("https://jobs.lever.co/matchgroup/69396299-e587-4063-aef6-0ce2fd66e9ee/apply")).toBe("matchgroup");
    expect(leverJobId("https://jobs.lever.co/matchgroup/69396299-e587-4063-aef6-0ce2fd66e9ee/apply")).toBe("69396299-e587-4063-aef6-0ce2fd66e9ee");
    expect(ashbySlug("https://jobs.ashbyhq.com/Superhuman%20Platform%20Inc/5f1f25ee-709d-4ae0-ada4-d1f243bde89c")).toBe("Superhuman Platform Inc");
    expect(ashbyJobId("https://jobs.ashbyhq.com/cohere/8c035d3d-081d-4c8a-914a-72f4efaad254")).toBe("8c035d3d-081d-4c8a-914a-72f4efaad254");
  });
  it("derives boards from job urls without duplicating seeds", () => {
    const jobs = parseReadmeTable(fixture("canada-summer-2027.md"), "x", now);
    const boards = boardsFromJobs(jobs, [{ ats: "greenhouse", slug: "doordashcanada", company: "DoorDash" }]);
    expect(boards.filter((b) => b.slug === "doordashcanada")).toHaveLength(1);
    expect(boards.some((b) => b.ats === "ashby" && /Superhuman/.test(b.slug))).toBe(true);
  });
});

describe("Workday postings", () => {
  it("reads the parts of a posting link, with or without a locale and an apply step", async () => {
    const { workdayParts } = await import("../src/sources/ats/workday.js");
    expect(workdayParts("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Software-Intern_R1")).toEqual({ origin: "https://acme.wd5.myworkdayjobs.com", tenant: "acme", site: "Careers", path: "Toronto/Software-Intern_R1" });
    expect(workdayParts("https://acme.wd5.myworkdayjobs.com/Careers/job/Toronto/Software-Intern_R1/apply/applyManually")?.path).toBe("Toronto/Software-Intern_R1");
    expect(workdayParts("https://acme.wd5.myworkdayjobs.com/Careers")).toBeNull();
    expect(workdayParts("https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
  });

  it("turns Workday's own posting data into a job", async () => {
    const { workdayJob } = await import("../src/sources/ats/workday.js");
    const raw = JSON.parse(readFileSync(new URL("./fixtures/workday-posting.json", import.meta.url), "utf8")) as { jobPostingInfo: Record<string, unknown> };
    const link = "https://altera.wd1.myworkdayjobs.com/altera/job/Toronto-Ontario-Canada/Software-Engineer---Intern_R03193";
    const job = workdayJob(raw, `${link}/apply/applyManually`);
    expect(job).toMatchObject({ title: "Software Engineer - Intern", company: "Altera Semiconductor Technology Canada ULC", ats: "workday", url: link, locations: ["Toronto, Ontario, Canada"], source: "workday:altera", descriptionSource: "api" });
    expect(job?.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(job?.description).not.toMatch(/<\/?[a-z]/i);
    // A posting that takes no applications is not a job to queue.
    expect(workdayJob({ ...raw, jobPostingInfo: { ...raw.jobPostingInfo, canApply: "False" } }, link)).toBeNull();
    expect(workdayJob({ nothing: true }, link)).toBeNull();
  });
});
