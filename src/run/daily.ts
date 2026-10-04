/**
 * The daily run: a few applications a day with nobody watching, inside the person's standing
 * policy and the limits in DAILY. One job at a time. It stops at the day's number, when nothing
 * suitable is left, at its limits of jobs, minutes and JEV spend, and at the first signs that
 * boards are asking whether a person is there. A board that asked is left alone until tomorrow.
 *
 * The loop itself touches no browser: `run` does one job and says what became of it, so every
 * rule here is tested offline.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DAILY, PATHS } from "../config.js";
import type { FillReport } from "../browser/report.js";
import { sortEntries, type QueueEntry } from "../jobs/queue.js";
import { withStore, writeAtomic } from "../util/store.js";
import { policyRefuses, type Policy } from "./policy.js";

/** The local calendar day of a moment: the day a person at this machine would call it. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The board a job is on, for the limits: the board's name, or the site for a company's own page. */
export function boardOf(job: { ats: string; url: string }): string {
  if (job.ats && job.ats !== "other") return job.ats;
  try {
    return new URL(job.url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "other";
  }
}
const employerOf = (job: { company: string }) => job.company.trim().toLowerCase();

const Pauses = z.record(z.object({ until: z.string(), why: z.string() }));
type Pauses = z.infer<typeof Pauses>;

export function loadPauses(file = PATHS.boardPauses): Pauses {
  if (!existsSync(file)) return {};
  try {
    return Pauses.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`${file} cannot be read. It records which boards the daily run must leave alone, so the run stops until it is fixed or removed by you.`);
  }
}

/** Leaves a board alone until the next local day begins. */
export function pauseBoard(board: string, why: string, now: Date, file = PATHS.boardPauses): void {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  withStore(() => {
    const p = loadPauses(file);
    p[board] = { until: tomorrow.toISOString(), why };
    writeAtomic(file, JSON.stringify(p, null, 2));
  });
}

export type Outcome = { status: QueueEntry["status"]; waitingFor: QueueEntry["waitingFor"]; reason: string | null; ready: boolean; report: FillReport | null };

export type DailyDeps = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** A number from 0 up to 1, for the pause between two submissions. */
  random: () => number;
  /** The queue as it is now. */
  queue: () => QueueEntry[];
  /** Fills one job and, in a real run, sends it when it is ready. Says what the job's record is afterwards. */
  run: (id: string) => Promise<Outcome>;
  /** Speaks for the boards that want an account: null when a job may be taken today. */
  gate: () => (url: string) => string | null;
  /** What JEV has cost since the local day began. */
  jevSpentToday: () => number;
  log: (line: string) => void;
  pausesFile?: string;
};

type Line = { id: string; company: string; title: string; board: string };
export type DailySummary = {
  date: string;
  startedAt: string;
  endedAt: string;
  dry: boolean;
  target: number;
  /** Applications sent today before this run began. */
  sentBefore: number;
  sent: Line[];
  /** Forms open for the person: a human check, a sign-in only they can finish. */
  waiting: (Line & { why: string })[];
  /** Submit was clicked and no confirmation was seen. These count towards the day's number until settled. */
  unconfirmed: Line[];
  /** Jobs the run opened and could not send, with the reason. */
  leftForYou: (Line & { status: string; why: string })[];
  /** Boards this run paused until tomorrow, and why. */
  paused: { board: string; why: string }[];
  stoppedBecause: string;
  jevUsd: number;
};

const line = (e: QueueEntry): Line => ({ id: e.job.id, company: e.job.company, title: e.job.title, board: boardOf(e.job) });
const OPEN: readonly string[] = ["in_progress", "awaiting_user_action", "awaiting_email_verification", "submission_unknown"];
const HUMAN: readonly (string | null)[] = ["human_code", "robot_check"];

/** What today already holds, from the queue: sent and unconfirmed per board and employer, and what is open per employer. */
export function countToday(entries: QueueEntry[], today: string) {
  const board = new Map<string, number>();
  const employer = new Map<string, number>();
  const open = new Map<string, number>();
  const last = new Map<string, number>();
  let sent = 0;
  let unconfirmed = 0;
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of entries) {
    if (OPEN.includes(e.status)) add(open, employerOf(e.job));
    const when = e.status === "applied" ? e.appliedAt : e.status === "submission_unknown" ? e.updatedAt : null;
    if (!when || localDay(new Date(when)) !== today) continue;
    if (e.status === "applied") sent++;
    else unconfirmed++;
    add(board, boardOf(e.job));
    add(employer, employerOf(e.job));
    last.set(boardOf(e.job), Math.max(last.get(boardOf(e.job)) ?? 0, Date.parse(when)));
  }
  return { sent, unconfirmed, board, employer, open, last };
}

export async function dailyRun(policy: Policy, o: { target?: number; maxAttempts?: number; maxMinutes?: number; dry: boolean }, deps: DailyDeps): Promise<DailySummary> {
  const started = deps.now();
  const today = localDay(started);
  const target = Math.min(o.target ?? policy.target, DAILY.maxTarget);
  const maxAttempts = o.maxAttempts ?? DAILY.maxAttempts;
  const deadline = started.getTime() + (o.maxMinutes ?? DAILY.maxMinutes) * 60_000;
  const before = countToday(deps.queue(), today);
  const summary: DailySummary = { date: today, startedAt: started.toISOString(), endedAt: "", dry: o.dry, target, sentBefore: before.sent, sent: [], waiting: [], unconfirmed: [], leftForYou: [], paused: [], stoppedBecause: "", jevUsd: 0 };
  const tried = new Set<string>();
  /** Boards that asked for a human check in this run. */
  const challenged = new Set<string>();
  /** The pause each board is owed before its next submission, drawn when the last one was made. */
  const gap = new Map<string, number>();
  const drawGap = () => DAILY.gapMs[0] + Math.floor(deps.random() * (DAILY.gapMs[1] - DAILY.gapMs[0]));
  const pause = (board: string, why: string) => {
    pauseBoard(board, why, deps.now(), deps.pausesFile);
    summary.paused.push({ board, why });
    deps.log(`  ${board} is left alone until tomorrow: ${why}`);
  };
  const end = (why: string): DailySummary => {
    summary.stoppedBecause = why;
    summary.endedAt = deps.now().toISOString();
    summary.jevUsd = deps.jevSpentToday();
    return summary;
  };

  for (let attempts = 0; ; ) {
    const entries = deps.queue();
    const day = countToday(entries, today);
    // In a rehearsal nothing is recorded, so what it would have sent is counted from the run itself.
    const done = o.dry ? before.sent + before.unconfirmed + summary.sent.length : day.sent + day.unconfirmed;
    if (done >= target) return end(`the day's ${target} applications are done`);
    if (challenged.size >= DAILY.challengesStopRun) return end(`${challenged.size} boards asked for a human check, so the run stopped for today`);
    if (attempts >= maxAttempts) return end(`the run opened ${attempts} jobs, its limit`);
    if (deps.now().getTime() >= deadline) return end("the run reached its time limit");
    if (deps.jevSpentToday() >= policy.jevBudgetUsd) return end(`JEV has cost $${deps.jevSpentToday().toFixed(2)} today, the limit in your policy`);

    const pauses = loadPauses(deps.pausesFile);
    const sentHere = (b: string) => (day.board.get(b) ?? 0) + (o.dry ? summary.sent.filter((s) => s.board === b).length : 0);
    const may = (e: QueueEntry): boolean => {
      const b = boardOf(e.job);
      const p = pauses[b];
      if (tried.has(e.job.id) || policyRefuses(e, policy)) return false;
      if (p && Date.parse(p.until) > deps.now().getTime()) return false;
      if (sentHere(b) >= DAILY.perBoard) return false;
      if ((day.employer.get(employerOf(e.job)) ?? 0) >= DAILY.perEmployerPerDay || summary.sent.some((s) => s.company.trim().toLowerCase() === employerOf(e.job))) return false;
      if ((day.open.get(employerOf(e.job)) ?? 0) >= DAILY.openPerEmployer) return false;
      // A fresh gate each time: it answers for this one job, with today's accounts as they are now.
      return deps.gate()(e.job.url) === null;
    };
    const suitable = sortEntries(entries.filter((e) => e.status === "queued")).filter(may);
    if (!suitable.length) return end("no suitable job is left in the queue");

    // Two submissions to one board are minutes apart. The best job whose board is free goes now; if none is, the run waits for the first.
    const freeAt = (e: QueueEntry) => (o.dry ? 0 : (day.last.get(boardOf(e.job)) ?? 0) + (gap.get(boardOf(e.job)) ?? (day.last.has(boardOf(e.job)) ? DAILY.gapMs[0] : 0)));
    const at = deps.now().getTime();
    let next = suitable.find((e) => freeAt(e) <= at);
    if (!next) {
      const soonest = suitable.reduce((a, b) => (freeAt(a) <= freeAt(b) ? a : b));
      if (freeAt(soonest) >= deadline) return end("the run reached its time limit");
      deps.log(`  waiting ${Math.ceil((freeAt(soonest) - at) / 60_000)} min before the next application to ${boardOf(soonest.job)}`);
      await deps.sleep(freeAt(soonest) - at);
      next = soonest;
    }

    const board = boardOf(next.job);
    tried.add(next.job.id);
    attempts++;
    deps.log(`${attempts}. ${next.job.company} | ${next.job.title} (${board})`);
    let out: Outcome;
    try {
      out = await deps.run(next.job.id);
    } catch (err) {
      out = { status: "failed", waitingFor: null, reason: err instanceof Error ? err.message : String(err), ready: false, report: null };
    }
    const why = out.reason ?? out.report?.reason ?? "";
    if (out.status === "applied" || (o.dry && out.ready)) {
      summary.sent.push(line(next));
      gap.set(board, drawGap());
    } else if (out.status === "submission_unknown") {
      summary.unconfirmed.push(line(next));
      gap.set(board, drawGap());
    } else if (out.status === "awaiting_user_action" || out.status === "awaiting_email_verification") {
      summary.waiting.push({ ...line(next), why });
      if (HUMAN.includes(out.waitingFor)) {
        challenged.add(board);
        pause(board, "it asked for a human check");
      }
    } else if (!o.dry || !out.ready) {
      summary.leftForYou.push({ ...line(next), status: out.status, why });
    }
    // A board that answers "too many requests" is telling the run to stop.
    const said = `${why} ${(out.report?.failed ?? []).map((f) => f.why).join(" ")}`;
    if (/\b429\b|too many requests|rate limit/i.test(said) && !summary.paused.some((p) => p.board === board)) pause(board, "it refused a burst of requests");
  }
}

const DailyFile = z.object({ runs: z.array(z.unknown()).default([]) });
export const dailyFile = (date: string) => path.join(PATHS.runs, `daily-${date}.json`);

/** Adds a run's summary to the day's file. */
export function saveDaily(s: DailySummary, file = dailyFile(s.date)): void {
  withStore(() => {
    let runs: unknown[] = [];
    try {
      if (existsSync(file)) runs = DailyFile.parse(JSON.parse(readFileSync(file, "utf8"))).runs;
    } catch {
      runs = [];
    }
    writeAtomic(file, JSON.stringify({ runs: [...runs, s] }, null, 2));
  });
}

/** A run in one line: "12 submitted. 3 need you. 5 could not be sent." */
export function resultLine(s: Pick<DailySummary, "sent" | "waiting" | "unconfirmed" | "leftForYou" | "dry">): string {
  const needYou = s.waiting.length + s.unconfirmed.length;
  return `${s.sent.length} ${s.dry ? "would be submitted" : "submitted"}. ${needYou} need${needYou === 1 ? "s" : ""} you. ${s.leftForYou.length} could not be sent.`;
}

/** Every run recorded for one day. */
export function loadDaily(date: string, file = dailyFile(date)): DailySummary[] {
  try {
    return existsSync(file) ? (DailyFile.parse(JSON.parse(readFileSync(file, "utf8"))).runs as DailySummary[]) : [];
  } catch {
    return [];
  }
}

export function formatDaily(s: DailySummary): string {
  const names = (list: Line[]) => list.map((l) => `    ${l.company} | ${l.title}`).join("\n");
  const out = [resultLine(s), `${s.dry ? "Rehearsal. Nothing was sent. " : ""}${s.dry ? "Would have sent" : "Sent"} ${s.sent.length}${s.sentBefore ? ` (${s.sentBefore} more earlier today)` : ""} of ${s.target}. Stopped because ${s.stoppedBecause}.`];
  if (s.sent.length) out.push(names(s.sent));
  if (s.waiting.length) out.push(`  Waiting for you (${s.waiting.length}), each open in the tool's window. Then run: npx jev resume --submit`, ...s.waiting.map((l) => `    ${l.company} | ${l.title}: ${l.why}`));
  if (s.unconfirmed.length) out.push(`  Clicked and not confirmed (${s.unconfirmed.length}). To settle them: npx jev reconcile`, names(s.unconfirmed));
  if (s.leftForYou.length) out.push(`  Not sent (${s.leftForYou.length}):`, ...s.leftForYou.map((l) => `    ${l.company} | ${l.title}: ${l.why || l.status}`));
  if (s.paused.length) out.push(...s.paused.map((p) => `  ${p.board} is left alone until tomorrow: ${p.why}`));
  out.push(`  JEV today: $${s.jevUsd.toFixed(4)}`);
  return out.join("\n");
}
