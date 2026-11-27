import { describe, expect, it } from "vitest";
import { followShortLink, resolveShortLinks } from "../src/sources/shortLinks.js";
import { atsFromUrl, jobId, type Job } from "../src/jobs/normalize.js";

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const job = (url: string): Job => ({ id: jobId(url), source: "t", company: "Method", title: "Software Engineer Intern", url, ats: atsFromUrl(url), locations: [], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null });

describe("short links", () => {
  it("follows a short link to the posting and takes its board and id", async () => {
    const fetchImpl = async (u: string) => (u.startsWith("https://go.vansh.nyc/") ? redirect("https://job-boards.greenhouse.io/method/jobs/8208724003") : new Response("", { status: 200 }));
    const jobs = [job("https://go.vansh.nyc/1Fq?s=y"), job("https://jobs.lever.co/acme/1")];
    await resolveShortLinks(jobs, { fetchImpl, cacheFile: null });
    expect(jobs[0]!.url).toBe("https://job-boards.greenhouse.io/method/jobs/8208724003");
    expect(jobs[0]!.ats).toBe("greenhouse");
    expect(jobs[0]!.id).toBe(jobId("https://job-boards.greenhouse.io/method/jobs/8208724003"));
    expect(jobs[1]!.url).toBe("https://jobs.lever.co/acme/1");
  });
  it("leaves a job alone when the link does not redirect, or redirects to itself forever", async () => {
    expect(await followShortLink("https://go.vansh.nyc/x", async () => new Response("", { status: 200 }))).toBeNull();
    expect(await followShortLink("https://go.vansh.nyc/x", async () => redirect("https://go.vansh.nyc/x"))).toBeNull();
    expect(await followShortLink("https://go.vansh.nyc/x", async () => redirect("/y"))).toBeNull();
  });
  it("treats LinkedIn's Workday gadget as Workday", () => {
    expect(atsFromUrl("https://applywithlinkedin.myworkdaygadgets.com/awli/")).toBe("workday");
  });
});
