/**
 * Fills job.description. Uses the ATS public API when the URL points at
 * Greenhouse, Lever or Ashby (clean text, no rate limits) and falls back to
 * fetching the page and stripping it to text. Descriptions are capped so a
 * rating request stays well inside JEV's context window.
 */
import { JEV } from "../config.js";
import { fetchAshbyJob, ashbyJobId, ashbySlug } from "../sources/ats/ashby.js";
import { fetchGreenhouseJob, greenhouseJobId, greenhouseSlug } from "../sources/ats/greenhouse.js";
import { fetchLeverJob, leverJobId, leverSlug } from "../sources/ats/lever.js";
import { fetchWorkdayJob } from "../sources/ats/workday.js";
import { getText } from "../util/http.js";
import { htmlToText, truncate } from "../util/text.js";
import type { Job } from "./normalize.js";

export async function describe(job: Job): Promise<Job> {
  if (job.description && job.description.length > 200) {
    return { ...job, description: truncate(job.description, JEV.maxDescriptionChars) };
  }
  let text: string | null = null;
  let source: Job["descriptionSource"] = "none";
  try {
    if (job.ats === "greenhouse") {
      const slug = greenhouseSlug(job.url);
      const id = greenhouseJobId(job.url);
      if (slug && id) {
        text = await fetchGreenhouseJob(slug, id);
        source = "api";
      }
    } else if (job.ats === "lever") {
      const slug = leverSlug(job.url);
      const id = leverJobId(job.url);
      if (slug && id) {
        text = await fetchLeverJob(slug, id);
        source = "api";
      }
    } else if (job.ats === "ashby") {
      const slug = ashbySlug(job.url);
      const id = ashbyJobId(job.url);
      if (slug && id) {
        text = await fetchAshbyJob(slug, id, job.company);
        source = "api";
      }
    }
    if (!text && job.ats === "workday") {
      text = await fetchWorkdayJob(job.url);
      if (text) source = "api";
    }
    if (!text) {
      const html = await getText(job.url, { cacheMs: 6 * 60 * 60_000 });
      text = extractMainText(html);
      source = "html";
    }
  } catch {
    text = null;
  }
  if (!text || text.length < 80) return { ...job, description: "", descriptionSource: "none" };
  return { ...job, description: truncate(text, JEV.maxDescriptionChars), descriptionSource: source };
}

/** Prefers <main> or <article>, then the densest chunk of the body, so nav and footer do not drown the posting. */
export function extractMainText(html: string): string {
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s\S]*?<\/article>/i.exec(html)?.[0];
  if (main) {
    const t = htmlToText(main);
    if (t.length > 400) return t;
  }
  const body = /<body[\s\S]*?<\/body>/i.exec(html)?.[0] ?? html;
  return htmlToText(body);
}
