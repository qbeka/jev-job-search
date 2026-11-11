/**
 * JobsWithPay (jobswithpay.com) reads tech jobs directly from company job
 * boards and checks each one every day. Its public search API needs no key.
 * We ask for intern and entry-level jobs and keep the link to the posting on
 * the company's own board (`apply_url`), so the job dedupes with the same
 * posting from the lists and the board polling.
 * Fields observed: id, title, company, locations, pay, posted, last_checked,
 * url (the JobsWithPay page), apply_url, visa_sponsor.
 */
import { z } from "zod";
import { DISCOVER } from "../config.js";
import { getJson } from "../util/http.js";
import { atsFromUrl, canonicalUrl, jobId, type Job } from "../jobs/normalize.js";

const ApiJob = z.object({
  title: z.string(),
  company: z.string(),
  locations: z.array(z.string()).optional(),
  posted: z.string().nullable().optional(),
  apply_url: z.string().nullable().optional(),
  visa_sponsor: z.boolean().optional(),
});

const Page = z.object({
  jobs: z.array(z.unknown()),
  next_cursor: z.string().nullable().optional(),
});

/** The tech job types to read; the rating step decides fit. */
const JOB_TYPES = ["software", "ml_ai", "inference_systems", "infra_cloud", "data_eng", "data_science", "security"];

export function parseJobsWithPay(raw: unknown): { jobs: Job[]; next: string | null } {
  const page = Page.parse(raw);
  const out: Job[] = [];
  for (const item of page.jobs) {
    const p = ApiJob.safeParse(item);
    if (!p.success || !p.data.apply_url) continue;
    const j = p.data;
    const url = canonicalUrl(j.apply_url!);
    out.push({
      id: jobId(url),
      source: "jobswithpay",
      company: j.company.trim(),
      title: j.title.trim(),
      url,
      ats: atsFromUrl(url),
      locations: (j.locations ?? []).map((s) => s.trim()).filter(Boolean),
      postedAt: j.posted && /^\d{4}-\d{2}-\d{2}$/.test(j.posted) ? j.posted : null,
      terms: [],
      sponsorship: j.visa_sponsor ? "offers" : "unknown",
      degrees: [],
      category: null,
    });
  }
  return { jobs: out, next: page.next_cursor ?? null };
}

export function jobsWithPayUrl(cursor: string | null): string {
  const u = new URL(DISCOVER.sources.jobsWithPay);
  u.searchParams.set("level", "intern,entry");
  u.searchParams.set("job_type", JOB_TYPES.join(","));
  if (cursor) u.searchParams.set("cursor", cursor);
  return u.toString();
}

export async function fetchJobsWithPay(): Promise<Job[]> {
  const jobs: Job[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < DISCOVER.jobsWithPayPages; i++) {
    const page = parseJobsWithPay(await getJson(jobsWithPayUrl(cursor), { cacheMs: 30 * 60_000 }));
    jobs.push(...page.jobs);
    if (!page.next) break;
    cursor = page.next;
  }
  return jobs;
}
