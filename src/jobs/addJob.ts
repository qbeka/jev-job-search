/**
 * One posting by its link: the way to apply to a job the person found themselves. The posting is
 * read from its board's own API, rated like any other, and put in the queue at the top.
 */
import { JevClient } from "../jev/client.js";
import { ashbyJobId, ashbySlug, fetchAshbyBoard } from "../sources/ats/ashby.js";
import { fetchGreenhouseBoard, greenhouseJobId, greenhouseSlug } from "../sources/ats/greenhouse.js";
import { fetchLeverBoard, leverJobId, leverSlug } from "../sources/ats/lever.js";
import { fetchWorkdayPosting } from "../sources/ats/workday.js";
import { capabilityFor } from "../accounts/capability.js";
import type { Profile } from "../profile/schema.js";
import { canonicalUrl, jobId, type Job } from "./normalize.js";
import { entryFor, loadQueue, MAYBE_SENT, mutateQueue, type QueueEntry } from "./queue.js";
import { rateJob } from "./rate.js";

export const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s);

/** The posting behind a link, from the board's API. Null when the board is not one the tool reads. */
export async function fetchPosting(url: string): Promise<Job | null> {
  const want = canonicalUrl(url);
  const pick = (jobs: Job[], id: string | null) => jobs.find((j) => j.url === want || j.id === jobId(want) || (id !== null && j.url.includes(id))) ?? null;
  const gh = greenhouseSlug(url);
  if (gh) return pick(await fetchGreenhouseBoard(gh, gh), greenhouseJobId(url));
  const lv = leverSlug(url);
  if (lv) return pick(await fetchLeverBoard(lv, lv), leverJobId(url));
  const ab = ashbySlug(url);
  if (ab) return pick(await fetchAshbyBoard(ab, ab), ashbyJobId(url));
  return fetchWorkdayPosting(url);
}

/** Reads, rates and queues one posting. Returns its queue entry, or throws with the reason it could not be read. */
export async function addJob(jev: JevClient, profile: Profile, url: string): Promise<QueueEntry> {
  const job = await fetchPosting(url);
  if (!job) throw new Error(`could not read a posting at ${url}. The tool reads Greenhouse, Lever, Ashby and Workday links; for another board, run discover and apply from the queue.`);
  // A board that wants an account is taken only where the person has one or allowed one.
  const account = capabilityFor(job.url);
  if (account?.verdict === "no") throw new Error(`${job.company} is on Workday, where every employer wants an account, and you have not allowed one. To allow it: npx jev accounts add workday --email you@example.com --create --terms --verify-email`);
  const before = loadQueue().entries.find((e) => e.job.id === job.id);
  if (before && MAYBE_SENT.includes(before.status)) return before;
  const fit = await rateJob(jev, job, profile);
  // Rating took a while, so the entry is merged into the queue as it is now.
  return mutateQueue((q) => {
    const previous = q.entries.find((e) => e.job.id === job.id);
    if (previous && MAYBE_SENT.includes(previous.status)) return previous;
    const entry = { ...entryFor(job, fit, null, previous), status: "queued" as const, statusReason: null, waitingFor: null };
    q.entries = [entry, ...q.entries.filter((e) => e.job.id !== job.id)];
    return entry;
  });
}
