/**
 * data/queue.json: every job discovered, its rating, and its application
 * status. Statuses survive re-discovery so a job applied to yesterday is
 * never re-queued.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PATHS } from "../config.js";
import { withStore, writeAtomic } from "../util/store.js";
import { Answer } from "../jev/types.js";
import type { FitResult } from "./rate.js";
import { jobId, type Job } from "./normalize.js";

/**
 * Where a job stands. The first seven are the plain outcomes. The rest are the stops on the way
 * through a board that wants an account, and the two a person or a later check has to settle:
 *   login_required               the board wants a sign-in the tool has no account for
 *   registering                  an account is being created (a run owns the job)
 *   awaiting_email_verification  the board sent a link or a code to prove the inbox is the person's
 *   authenticated                signed in, about to return to the form (a run owns the job)
 *   awaiting_user_action         the filled form is open and waits for the person: a human check, an agreement
 *   submission_unknown           Submit was clicked and no confirmation was seen. Never sent again until settled
 */
export const QueueStatus = z.enum([
  "queued", "in_progress", "applied", "skipped", "failed", "blocked", "needs_review",
  "login_required", "registering", "awaiting_email_verification", "authenticated", "awaiting_user_action", "submission_unknown",
]);
export type QueueStatus = z.infer<typeof QueueStatus>;

/** What a form in awaiting_user_action waits for. */
/** What an employer's email says about an application. */
export const Response = z.enum(["confirmation", "rejection", "assessment", "interview", "offer"]);
export type Response = z.infer<typeof Response>;

export const WaitingFor = z.enum(["human_code", "robot_check", "login", "agreement", "phone", "passkey", "sso", "email_link", "unknown"]);
export type WaitingFor = z.infer<typeof WaitingFor>;

/** Statuses only a run sets and holds. With no run alive, a job left in one of these was interrupted. */
export const RUN_OWNED: readonly QueueStatus[] = ["in_progress", "registering", "authenticated"];
/** Statuses a new search must not undo: everything a run or a person decided. Only a plain queued job is re-decided. */
export const KEPT_ON_REDISCOVERY: readonly QueueStatus[] = QueueStatus.options.filter((s) => s !== "queued");
/** Statuses that mean an application may already be with the employer: such a job is never filled again without an explicit override. */
export const MAYBE_SENT: readonly QueueStatus[] = ["applied", "submission_unknown"];

const JobSchema = z.object({
  id: z.string(),
  source: z.string(),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  ats: z.string(),
  locations: z.array(z.string()),
  postedAt: z.string().nullable(),
  terms: z.array(z.string()),
  sponsorship: z.string(),
  degrees: z.array(z.string()),
  category: z.string().nullable(),
  description: z.string().optional(),
  descriptionSource: z.enum(["api", "html", "none"]).optional(),
});

export const QueueEntry = z.object({
  job: JobSchema,
  fit: z
    .object({
      score: z.number(),
      decision: z.enum(["apply", "below_threshold", "skip"]),
      skipReason: z.string().nullable(),
      reasons: z.array(z.string()),
      components: z.record(z.number()),
      locationTier: z.string(),
      answers: z.record(Answer),
    })
    .nullable(),
  preFilterReason: z.string().nullable(),
  status: QueueStatus,
  statusReason: z.string().nullable(),
  attempts: z.number().int(),
  discoveredAt: z.string(),
  updatedAt: z.string(),
  appliedAt: z.string().nullable(),
  notes: z.string().nullable(),
  /** Set with awaiting_user_action: what the person has to do. */
  waitingFor: WaitingFor.nullable().default(null),
  /** Answers the person gave for this one job, to questions its form asked and the profile could not answer. */
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  /** Every reply that came back by email, as it was read: the kind, when the mailbox received it, and which email it was. Nothing is ever taken out. */
  replies: z.array(z.object({ id: z.string(), kind: Response, at: z.number(), subject: z.string() })).default([]),
  /** Where the application stands, worked out from `replies` by `outcomeOf`: the kind of the reply that counts now, and its day. */
  response: z.object({ kind: Response, on: z.string(), subject: z.string() }).nullable().default(null),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export const QueueFile = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  entries: z.array(QueueEntry),
});
export type QueueFile = z.infer<typeof QueueFile>;

export function loadQueue(file = PATHS.queue): QueueFile {
  if (!existsSync(file)) return { version: 1, generatedAt: new Date().toISOString(), entries: [] };
  // A queue that cannot be read is never treated as empty: an empty queue would apply to everything again.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} cannot be read (${err instanceof Error ? err.message : String(err)}). The last good copy is ${file}.bak`);
  }
  const parsed = QueueFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is corrupt: ${parsed.error.message}. The last good copy is ${file}.bak`);
  // An id is derived from the posting, so it is recomputed on load: a queue written by an older
  // version keeps every status, and an applied job can never come back as a new one.
  for (const e of parsed.data.entries) e.job.id = jobId(e.job.url);
  return parsed.data;
}

/** Replaces the queue file whole, keeping the copy it replaces as queue.json.bak. */
export function saveQueue(q: QueueFile, file = PATHS.queue): void {
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      /* a backup is a convenience */
    }
  }
  writeAtomic(file, JSON.stringify(q, null, 2));
}

/**
 * Changes the queue: a fresh read, the change, a whole-file write, all under the store lock. Every
 * writer goes through this, so a search that took minutes cannot erase what a run recorded meanwhile.
 */
export function mutateQueue<T>(fn: (q: QueueFile) => T, file = PATHS.queue): T {
  return withStore(() => {
    const q = loadQueue(file);
    const out = fn(q);
    saveQueue(q, file);
    return out;
  });
}

export function entryFor(job: Job, fit: FitResult | null, preFilterReason: string | null, previous?: QueueEntry): QueueEntry {
  const now = new Date().toISOString();
  const fresh: QueueEntry = {
    job: job as QueueEntry["job"],
    fit: fit as QueueEntry["fit"],
    preFilterReason,
    status: fit?.decision === "apply" ? "queued" : "skipped",
    statusReason: preFilterReason ?? fit?.skipReason ?? (fit?.decision === "below_threshold" ? `score ${fit.score} below threshold` : null),
    attempts: 0,
    discoveredAt: now,
    updatedAt: now,
    appliedAt: null,
    notes: null,
    waitingFor: null,
    answers: [],
    replies: [],
    response: null,
  };
  if (!previous) return fresh;
  // Keep what a run or a person decided, and the history; refresh the job and rating.
  const keepStatus = KEPT_ON_REDISCOVERY.includes(previous.status) && !(previous.status === "skipped" && fresh.status === "queued" && previous.preFilterReason);
  return {
    ...fresh,
    status: keepStatus ? previous.status : fresh.status,
    statusReason: keepStatus ? previous.statusReason : fresh.statusReason,
    waitingFor: keepStatus ? previous.waitingFor : null,
    attempts: previous.attempts,
    discoveredAt: previous.discoveredAt,
    appliedAt: previous.appliedAt,
    notes: previous.notes,
    answers: previous.answers ?? [],
    replies: previous.replies ?? [],
    response: previous.response ?? null,
  };
}

/** Highest score first; ties go to the most recent posting. */
export function sortEntries(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => {
    const sa = a.fit?.score ?? -1;
    const sb = b.fit?.score ?? -1;
    if (sb !== sa) return sb - sa;
    return (b.job.postedAt ?? "").localeCompare(a.job.postedAt ?? "");
  });
}

export function updateEntry(q: QueueFile, id: string, patch: Partial<QueueEntry>): QueueEntry {
  const e = q.entries.find((x) => x.job.id === id);
  if (!e) throw new Error(`No queue entry with id ${id}`);
  Object.assign(e, patch, { updatedAt: new Date().toISOString() });
  return e;
}
