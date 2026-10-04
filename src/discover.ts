/**
 * The discover pipeline: sources → dedupe → pre-filter → describe → rate → queue.
 * No browser involved. Safe to run as often as you like; everything is cached
 * and previously applied jobs keep their status.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DISCOVER, PATHS, CACHE } from "./config.js";
import { JevClient } from "./jev/client.js";
import { describe } from "./jobs/describe.js";
import { capabilityFor } from "./accounts/capability.js";
import { preFilter } from "./jobs/hardFilters.js";
import { isWalled, learnedWalledHosts } from "./jobs/walled.js";
import { dedupe, type Job } from "./jobs/normalize.js";
import { entryFor, KEPT_ON_REDISCOVERY, loadQueue, mutateQueue, sortEntries, type QueueEntry, type QueueFile, type QueueStatus } from "./jobs/queue.js";
import { withStore } from "./util/store.js";

/** Jobs whose earlier rating still stands: a run or a person already settled them. */
const NOT_RERATED: readonly QueueStatus[] = KEPT_ON_REDISCOVERY.filter((s) => s !== "needs_review" && s !== "in_progress");
/** Jobs kept in the queue when their posting is gone from every list: sent, unconfirmed, or waiting on the person or a run. */
const CARRIED_OVER: readonly QueueStatus[] = KEPT_ON_REDISCOVERY.filter((s) => s !== "skipped" && s !== "failed");
import { rateJob, type FitResult } from "./jobs/rate.js";
import { loadRows, saveRows, upsertEntry } from "./log/csv.js";
import { usStatus, type Profile } from "./profile/schema.js";
import type { Answer } from "./jev/types.js";
import { KeyedCache } from "./util/cache.js";
import { fetchAshbyBoard } from "./sources/ats/ashby.js";
import { fetchGreenhouseBoard } from "./sources/ats/greenhouse.js";
import { fetchLeverBoard } from "./sources/ats/lever.js";
import { boardsFromJobs, type Board } from "./sources/companies.js";
import { fetchReadmeSources } from "./sources/githubReadme.js";
import { fetchSimplify } from "./sources/simplify.js";
import { importSheet } from "./sources/sheetImport.js";
import { mapLimit } from "./util/http.js";

export const EARLY_CAREER_TITLE = /\b(intern|internship|co-?op|new grad|new graduate|early career|early-career|entry[- ]level|junior|graduate|university|student|campus|associate software|software engineer i\b|engineer i\b|swe i\b)\b/i;

/** A board posting counts as early-career by its title, or by naming the candidate's graduation year. */
export function isEarlyCareerTitle(title: string, gradYear?: number): boolean {
  return EARLY_CAREER_TITLE.test(title) || (gradYear !== undefined && new RegExp(`\\b${gradYear}\\b`).test(title));
}

export type DiscoverOptions = {
  boards?: boolean;
  limit?: number;
  log?: (line: string) => void;
  now?: Date;
  /** The candidate's graduation year: a board title that names it is early-career. */
  gradYear?: number;
  /** Consider postings up to this many days old, for one search. The default is DISCOVER.maxAgeDays. */
  maxAgeDays?: number;
};

export type DiscoverSummary = {
  collected: number;
  unique: number;
  preFiltered: number;
  rated: number;
  /** How many of those ratings came from the cache and cost nothing. */
  reused: number;
  queued: number;
  belowThreshold: number;
  skippedByJev: number;
  jevCostUsd: number;
  jevCalls: number;
};

export async function collectJobs(opts: DiscoverOptions = {}): Promise<Job[]> {
  const log = opts.log ?? (() => {});
  const jobs: Job[] = [];

  const [simplify, readmes] = await Promise.all([
    fetchSimplify().catch((e) => {
      log(`[sources] simplify failed: ${String(e)}`);
      return [] as Job[];
    }),
    fetchReadmeSources(),
  ]);
  log(`[sources] simplify ${simplify.length}, github lists ${readmes.length}`);
  jobs.push(...simplify, ...readmes);

  if (existsSync(PATHS.imports)) {
    for (const f of readdirSync(PATHS.imports).filter((f) => f.endsWith(".csv"))) {
      try {
        const imported = importSheet(path.join(PATHS.imports, f));
        log(`[sources] ${f}: ${imported.length} rows`);
        jobs.push(...imported);
      } catch (e) {
        log(`[sources] ${f} failed: ${String(e)}`);
      }
    }
  }

  if (opts.boards !== false) {
    const boards = boardsFromJobs(jobs);
    log(`[sources] polling ${boards.length} company boards`);
    const results = await mapLimit(boards, DISCOVER.fetchConcurrency, (b: Board) =>
      b.ats === "greenhouse" ? fetchGreenhouseBoard(b.slug, b.company)
      : b.ats === "lever" ? fetchLeverBoard(b.slug, b.company)
      : fetchAshbyBoard(b.slug, b.company),
    );
    let fromBoards = 0;
    results.forEach((r) => {
      if (!r.ok) return;
      const early = r.value.filter((j) => isEarlyCareerTitle(j.title, opts.gradYear));
      fromBoards += early.length;
      jobs.push(...early);
    });
    log(`[sources] boards contributed ${fromBoards} early-career postings`);
  }
  return dedupe(jobs);
}

/** What a search decided about one posting. */
export type Decided = { job: Job; fit: FitResult | null; reason: string | null; failed?: string };

/**
 * The queue after a search: every posting the search saw, with what a run or a person decided
 * about it kept, plus every job the search did not see that was sent, is unconfirmed, or waits on
 * someone. A posting that left the lists must stay: dropped, it could come back later as a new job
 * and be applied to twice.
 */
export function mergeDecided(current: QueueEntry[], decided: Decided[]): QueueEntry[] {
  const byId = new Map(current.map((e) => [e.job.id, e]));
  const entries = decided.map((d) => {
    const before = byId.get(d.job.id);
    // A job that was not read again this time keeps the posting text it had: the writer needs it on a retry.
    const job = !d.job.description && before?.job.description ? { ...d.job, description: before.job.description, ...(before.job.descriptionSource ? { descriptionSource: before.job.descriptionSource } : {}) } : d.job;
    const e = entryFor(job as Job, d.fit, d.reason, before);
    // A rating that failed marks a job nobody settled as failed; one a run or a person settled keeps its status.
    if (d.failed && !(before && KEPT_ON_REDISCOVERY.includes(before.status))) {
      e.status = "failed";
      e.statusReason = d.failed;
    }
    return e;
  });
  const seen = new Set(entries.map((e) => e.job.id));
  for (const e of current) if (!seen.has(e.job.id) && CARRIED_OVER.includes(e.status)) entries.push(e);
  return sortEntries(entries);
}

export async function discover(profile: Profile, jev: JevClient, opts: DiscoverOptions = {}): Promise<{ queue: QueueFile; summary: DiscoverSummary }> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const previous = loadQueue();
  const prevById = new Map(previous.entries.map((e) => [e.job.id, e]));

  const gradYear = profile.education[0]?.gradYear;
  const all = await collectJobs({ ...opts, ...(gradYear !== undefined ? { gradYear } : {}) });
  const learned = learnedWalledHosts();
  const us = usStatus(profile);
  const collected = all.length;
  log(`[discover] ${collected} unique postings`);

  // What this search decided about each posting. The queue entries are built from these at the end,
  // against the queue as it is then: a search takes minutes, and a run may record outcomes meanwhile.
  const decided: Decided[] = [];
  const kept: Job[] = [];
  // An account board counts when the person has an account there or allowed one, even if today's limit of new accounts is used up.
  const withAccount = (url: string) => (capabilityFor(url)?.verdict ?? "no") !== "no";
  for (const job of all) {
    const reason = preFilter(job, now, (url) => isWalled(url, learned), us, opts.maxAgeDays, withAccount);
    if (reason) decided.push({ job, fit: null, reason });
    else kept.push(job);
  }
  log(`[discover] ${kept.length} pass the code filters, ${decided.length} do not`);

  // Jobs with a terminal status from an earlier run are not re-rated.
  const toRate = kept.filter((j) => {
    const prev = prevById.get(j.id);
    if (prev && NOT_RERATED.includes(prev.status) && prev.fit) {
      decided.push({ job: j, fit: prev.fit as FitResult, reason: null });
      return false;
    }
    return true;
  });
  const limited = typeof opts.limit === "number" ? toRate.slice(0, opts.limit) : toRate;
  log(`[discover] fetching ${limited.length} descriptions`);
  const described = await mapLimit(limited, DISCOVER.fetchConcurrency, (j) => describe(j));
  const ready = described.map((r, i) => (r.ok ? r.value : (limited[i] as Job)));

  log(`[discover] rating ${ready.length} with JEV`);
  let done = 0;
  const ratings = CACHE.ratings ? new KeyedCache<Record<string, Answer>>(PATHS.ratings) : undefined;
  const rated = await mapLimit(ready, DISCOVER.rateConcurrency, async (j) => {
    const fit = await rateJob(jev, j, profile, now, ratings);
    done++;
    if (done % 25 === 0) log(`[discover] rated ${done}/${ready.length} (spend $${jev.usage.costUsd.toFixed(4)})`);
    return fit;
  });
  ratings?.save();
  let ratedCount = 0;
  rated.forEach((r, i) => {
    const job = ready[i] as Job;
    if (r.ok) {
      ratedCount++;
      decided.push({ job, fit: r.value, reason: null });
    } else {
      decided.push({ job, fit: null, reason: null, failed: `rating failed: ${String(r.error).slice(0, 120)}` });
    }
  });

  const queue = withStore(() => {
    const merged = mutateQueue((q) => {
      q.generatedAt = now.toISOString();
      q.entries = mergeDecided(q.entries, decided);
      return q;
    });
    let rows = loadRows();
    for (const e of merged.entries) rows = upsertEntry(rows, e);
    saveRows(rows);
    return merged;
  });

  const summary: DiscoverSummary = {
    collected,
    unique: all.length,
    preFiltered: all.length - kept.length,
    rated: ratedCount,
    reused: ratings?.hits ?? 0,
    queued: queue.entries.filter((e) => e.status === "queued").length,
    belowThreshold: queue.entries.filter((e) => e.fit?.decision === "below_threshold").length,
    skippedByJev: queue.entries.filter((e) => e.fit?.decision === "skip").length,
    jevCostUsd: jev.usage.costUsd,
    jevCalls: jev.usage.calls,
  };
  return { queue, summary };
}
