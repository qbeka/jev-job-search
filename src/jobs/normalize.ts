/**
 * One Job shape for every source. Everything downstream (filters, rating,
 * the queue, the CSV) reads this and nothing else.
 */
import { workday } from "../accounts/workday.js";
import { createHash } from "node:crypto";

export type Ats =
  | "greenhouse" | "lever" | "ashby" | "workday" | "icims" | "smartrecruiters" | "jobvite"
  | "rippling" | "bamboohr" | "taleo" | "oracle" | "successfactors" | "linkedin" | "amazon" | "other";

export type Sponsorship = "offers" | "none" | "citizenship" | "unknown";

export type Job = {
  id: string;
  source: string;
  company: string;
  title: string;
  url: string;
  ats: Ats;
  locations: string[];
  /** ISO date (YYYY-MM-DD) or null when the source does not say. */
  postedAt: string | null;
  terms: string[];
  sponsorship: Sponsorship;
  degrees: string[];
  category: string | null;
  description?: string;
  descriptionSource?: "api" | "html" | "none";
};

export function jobId(url: string): string {
  return createHash("sha256").update(postingKey(url)).digest("hex").slice(0, 16);
}

/** True when host is the domain itself or one of its subdomains. A substring test would also match evil-greenhouse.io.example.com. */
export function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * What makes two links the same posting. The lists and the boards link one job in several ways
 * (the careers page with gh_jid, the board page, the embedded form), so the big three are keyed by
 * the ATS's own posting id; everything else by its canonical URL.
 */
export function postingKey(raw: string): string {
  const url = canonicalUrl(raw);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(url)?.[0]?.toLowerCase();
  if (hostIs(host, "ashbyhq.com") && uuid) return `ashby:${uuid}`;
  if (hostIs(host, "lever.co") && uuid) return `lever:${uuid}`;
  const gh = /[?&](?:gh_jid|token)=(\d+)/.exec(url)?.[1] ?? (hostIs(host, "greenhouse.io") ? /\/jobs\/(\d+)/.exec(url)?.[1] : undefined);
  // Greenhouse numbers its EU and US postings separately.
  if (gh) return `greenhouse${hostIs(host, "eu.greenhouse.io") ? "-eu" : ""}:${gh}`;
  return url;
}

/** Drops tracking params and fragments so the same posting from two lists dedupes. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    const drop = [...u.searchParams.keys()].filter((k) => /^(utm_|ref$|source$|src$|gh_src$|lever-source|mobile$|needsRedirect$|embed$|locationId$)/i.test(k));
    for (const k of drop) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    // A posting and its own form page are one job: Ashby adds /application, Lever adds /apply.
    if (hostIs(u.hostname, "ashbyhq.com")) u.pathname = u.pathname.replace(/\/application\/?$/, "");
    if (hostIs(u.hostname, "lever.co")) u.pathname = u.pathname.replace(/\/apply\/?$/, "");
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function atsFromUrl(url: string): Ats {
  const h = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const u = url.toLowerCase();
  const on = (...domains: string[]) => domains.some((d) => hostIs(h, d));
  if (on("greenhouse.io") || /[?&]gh_jid=/.test(u)) return "greenhouse";
  if (on("lever.co")) return "lever";
  if (on("ashbyhq.com")) return "ashby";
  if (on("myworkdayjobs.com", "workday.com") || /(^|\.)wd\d+\./.test(h)) return "workday";
  if (on("icims.com") || /[?&]icims=1\b/.test(u)) return "icims";
  if (on("smartrecruiters.com")) return "smartrecruiters";
  if (on("jobvite.com")) return "jobvite";
  if (on("rippling.com")) return "rippling";
  if (on("bamboohr.com")) return "bamboohr";
  if (on("taleo.net")) return "taleo";
  if (on("oraclecloud.com")) return "oracle";
  if (on("successfactors.com", "jobs.sap.com") || /[?&]ats=successfactors\b/.test(u)) return "successfactors";
  if (on("linkedin.com")) return "linkedin";
  if (on("amazon.jobs")) return "amazon";
  return "other";
}

export function ageDays(job: Pick<Job, "postedAt">, now = new Date()): number | null {
  if (!job.postedAt) return null;
  const t = new Date(job.postedAt + "T00:00:00Z").getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Parses "Sep 29, 2026", "Sep 29", "2026-09-29", "Sept 5" into an ISO date. Year-less dates assume the most recent past occurrence. */
export function parseLooseDate(s: string, now = new Date()): string | null {
  const t = s.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /^([A-Za-z]{3,5})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(t);
  if (!m) return null;
  const month = MONTHS[(m[1] as string).toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[2] as string, 10);
  let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
  let d = new Date(Date.UTC(year, month, day));
  if (!m[3] && d.getTime() > now.getTime() + 86_400_000) {
    year -= 1;
    d = new Date(Date.UTC(year, month, day));
  }
  return toIsoDate(d);
}

export function dedupe(jobs: Job[]): Job[] {
  const seen = new Map<string, Job>();
  for (const j of jobs) {
    const existing = seen.get(j.id);
    if (!existing) {
      seen.set(j.id, j);
      continue;
    }
    // Keep the richer record: more locations, a posted date, a description.
    const merged: Job = {
      ...existing,
      locations: existing.locations.length >= j.locations.length ? existing.locations : j.locations,
      postedAt: existing.postedAt ?? j.postedAt,
      terms: existing.terms.length ? existing.terms : j.terms,
      sponsorship: existing.sponsorship !== "unknown" ? existing.sponsorship : j.sponsorship,
      degrees: existing.degrees.length ? existing.degrees : j.degrees,
      category: existing.category ?? j.category,
      source: existing.source.includes(j.source) ? existing.source : `${existing.source}+${j.source}`,
    };
    seen.set(j.id, merged);
  }
  return [...seen.values()];
}

/**
 * The URL that opens the application form directly, when the ATS has a
 * predictable one. Greenhouse's embed page is server-rendered and skips the
 * company's custom careers site; Lever and Ashby have fixed apply paths.
 */
export function greenhouseEmbedUrl(slug: string, id: string, eu = false): string {
  return `https://job-boards.${eu ? "eu." : ""}greenhouse.io/embed/job_app?for=${slug}&token=${id}`;
}

/**
 * The plain Greenhouse form for a job that is linked through the company's own careers page
 * (`?gh_jid=`). The board's slug is not in that link, but a job found by polling the board carries
 * it in its source. Null when it cannot be worked out.
 */
export function greenhouseFallbackUrl(job: Pick<Job, "url" | "ats" | "source">): string | null {
  if (job.ats !== "greenhouse") return null;
  const id = /[?&]gh_jid=(\d+)/.exec(job.url)?.[1];
  const slug = /greenhouse:([a-z0-9_-]+)/i.exec(job.source)?.[1];
  return id && slug ? greenhouseEmbedUrl(slug, id) : null;
}

export function applyUrlFor(job: Pick<Job, "url" | "ats">): string {
  if (job.ats === "greenhouse") {
    const slug = /greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9_-]+)/i.exec(job.url)?.[1] ?? /[?&]for=([a-z0-9_-]+)/i.exec(job.url)?.[1];
    const id = /\/jobs\/(\d+)/.exec(job.url)?.[1] ?? /[?&](?:gh_jid|token)=(\d+)/.exec(job.url)?.[1];
    if (slug && id && slug !== "embed") return greenhouseEmbedUrl(slug, id, /\.eu\.greenhouse\.io/i.test(job.url));
    return job.url;
  }
  if (job.ats === "lever") {
    const m = /^(https:\/\/jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36})/i.exec(job.url);
    return m ? `${m[1]}/apply` : job.url;
  }
  if (job.ats === "ashby") {
    const m = /^(https:\/\/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{36})/i.exec(job.url);
    return m ? `${m[1]}/application` : job.url;
  }
  // Workday: straight to the application, past the choice between "autofill" and "apply manually".
  if (job.ats === "workday" && workday.tenantOf(job.url)) return workday.applicationUrl(job.url);
  return job.url;
}
