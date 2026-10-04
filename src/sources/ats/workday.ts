/** Workday's public posting endpoint, the one its own careers page reads. No auth, one posting at a time. */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { canonicalUrl, jobId, type Job } from "../../jobs/normalize.js";
import { htmlToText } from "../../util/text.js";

const WorkdayPosting = z.object({
  jobPostingInfo: z.object({
    title: z.string(),
    jobDescription: z.string().default(""),
    location: z.string().default(""),
    additionalLocations: z.array(z.string()).default([]),
    startDate: z.string().optional(),
    canApply: z.union([z.string(), z.boolean()]).optional(),
    externalUrl: z.string().optional(),
  }),
  hiringOrganization: z.object({ name: z.string().default("") }).default({ name: "" }),
});

/**
 * The parts of a Workday posting link: the employer, its careers site and the posting's own path.
 * https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Software-Intern_R123
 */
export function workdayParts(url: string): { origin: string; tenant: string; site: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const tenant = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(u.hostname)?.[1];
  const m = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+?)(?:\/apply(?:\/[A-Za-z]+)?)?\/?$/.exec(u.pathname);
  if (!tenant || !m?.[1] || !m[2]) return null;
  return { origin: u.origin, tenant: tenant.toLowerCase(), site: m[1], path: m[2] };
}

const apiUrl = (p: { origin: string; tenant: string; site: string; path: string }) => `${p.origin}/wday/cxs/${p.tenant}/${p.site}/job/${p.path}`;

/** A legal entity's name as a company name: "207 Acme Technology Canada ULC" reads "Acme Technology Canada ULC". */
const companyName = (legal: string, tenant: string) => legal.replace(/^\d+\s+/, "").trim() || tenant.charAt(0).toUpperCase() + tenant.slice(1);

/** One posting by its link. Null when the link is not a Workday posting, or the posting is closed or gone. */
export async function fetchWorkdayPosting(url: string): Promise<Job | null> {
  const parts = workdayParts(url);
  return parts ? workdayJob(await getJson(apiUrl(parts), { cacheMs: 20 * 60_000 }), url) : null;
}

/** What Workday says about a posting, as a job. Null for a reply that is not a posting, or a posting that takes no applications. */
export function workdayJob(raw: unknown, url: string): Job | null {
  const parts = workdayParts(url);
  if (!parts) return null;
  const p = WorkdayPosting.safeParse(raw);
  if (!p.success || String(p.data.jobPostingInfo.canApply ?? "true").toLowerCase() === "false") return null;
  const info = p.data.jobPostingInfo;
  // The link is kept as it was given, less the apply step, so the same posting from a list gets the same id.
  const link = canonicalUrl(url.replace(/\/apply(\/[A-Za-z]+)?\/?(?=$|[?#])/, ""));
  const description = htmlToText(info.jobDescription);
  return {
    id: jobId(link),
    source: `workday:${parts.tenant}`,
    company: companyName(p.data.hiringOrganization.name, parts.tenant),
    title: info.title.trim(),
    url: link,
    ats: "workday",
    locations: [...new Set([info.location, ...info.additionalLocations].filter(Boolean))],
    postedAt: info.startDate && /^\d{4}-\d{2}-\d{2}/.test(info.startDate) ? info.startDate.slice(0, 10) : null,
    terms: [],
    sponsorship: "unknown",
    degrees: [],
    category: null,
    description,
    descriptionSource: description ? "api" : "none",
  };
}

/** The words of one posting, for rating. */
export async function fetchWorkdayJob(url: string): Promise<string | null> {
  const parts = workdayParts(url);
  if (!parts) return null;
  try {
    const p = WorkdayPosting.safeParse(await getJson(apiUrl(parts), { cacheMs: 6 * 60 * 60_000 }));
    return p.success ? htmlToText(p.data.jobPostingInfo.jobDescription) || null : null;
  } catch {
    return null;
  }
}
