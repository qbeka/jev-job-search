import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DAILY } from "../src/config.js";
import type { QueueEntry } from "../src/jobs/queue.js";
import { boardOf, clearStop, countToday, dailyRun, formatDaily, loadPauses, localDay, pauseBoard, requestStop, saveDaily, stopRequested, type DailyDeps, type Outcome } from "../src/run/daily.js";
import { loadPolicy, Policy, policyRefuses } from "../src/run/policy.js";
import { agentPlist, installSchedule, removeSchedule, scheduleStatus, timeOfDay } from "../src/run/schedule.js";

const START = new Date(2026, 9, 5, 9, 0, 0);
const TODAY = localDay(START);

let n = 0;
function job(over: { ats?: string; company?: string; score?: number; tier?: string; level?: string; status?: QueueEntry["status"]; appliedAt?: string | null; updatedAt?: string; url?: string } = {}): QueueEntry {
  const id = `j${++n}`;
  return {
    job: { id, source: "test", company: over.company ?? `Company ${id}`, title: "Software Intern", url: over.url ?? `https://jobs.example.com/${id}`, ats: over.ats ?? "greenhouse", locations: ["Toronto, ON"], postedAt: "2026-10-01", terms: [], sponsorship: "unknown", degrees: [], category: null },
    fit: { score: over.score ?? 0.8, decision: "apply", skipReason: null, reasons: [], components: {}, locationTier: over.tier ?? "canada", answers: { level: { type: "choice", choice: over.level ?? "internship", probabilities: {}, confidence: 1 } } },
    preFilterReason: null,
    status: over.status ?? "queued",
    statusReason: null,
    waitingFor: null, answers: [], replies: [], response: null,
    attempts: 0,
    discoveredAt: START.toISOString(),
    updatedAt: over.updatedAt ?? START.toISOString(),
    appliedAt: over.appliedAt ?? null,
    notes: "",
  } as unknown as QueueEntry;
}

/** A queue and a clock that only moves when the run sleeps. `answer` says what becomes of each job. */
function world(entries: QueueEntry[], answer: (e: QueueEntry) => Partial<Outcome> = () => ({ status: "applied" })) {
  let now = START.getTime();
  const slept: number[] = [];
  const ran: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "jev-daily-"));
  const deps: DailyDeps = {
    now: () => new Date(now),
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    random: () => 0.5,
    queue: () => entries,
    run: async (id) => {
      const e = entries.find((x) => x.job.id === id) as QueueEntry;
      ran.push(id);
      const out: Outcome = { status: "applied", waitingFor: null, reason: null, ready: true, report: null, ...answer(e) };
      // What the pipeline would have recorded.
      e.status = out.status;
      e.waitingFor = out.waitingFor;
      e.updatedAt = new Date(now).toISOString();
      if (out.status === "applied") e.appliedAt = new Date(now).toISOString();
      now += 30_000;
      return out;
    },
    gate: () => () => null,
    jevSpentToday: () => ran.length * 0.002,
    log: () => undefined,
    pausesFile: path.join(dir, "pauses.json"),
  };
  return { deps, slept, ran, dir, at: () => new Date(now) };
}
const policy = (over: Partial<Policy> = {}) => Policy.parse(over);

beforeEach(() => {
  n = 0;
});

describe("the standing policy", () => {
  it("is absent until the person writes one, and is never guessed from a broken file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-policy-"));
    const file = path.join(dir, "policy.json");
    expect(loadPolicy(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ target: 500 }));
    expect(() => loadPolicy(file)).toThrow(/target/);
    writeFileSync(file, JSON.stringify({ target: 5 }));
    expect(loadPolicy(file)).toMatchObject({ target: 5, where: [], jevBudgetUsd: DAILY.jevBudgetUsd });
  });

  it("ships an example that is valid", () => {
    const example = Policy.parse(JSON.parse(readFileSync(path.join(__dirname, "..", "data", "policy.example.json"), "utf8")));
    expect(example.target).toBeLessThanOrEqual(DAILY.maxTarget);
  });

  it("keeps out what the person excluded, in code", () => {
    const p = policy({ where: ["canada"], levels: ["internship"], minScore: 0.5, boards: ["greenhouse", "lever"], excludeEmployers: ["acme"] });
    expect(policyRefuses(job(), p)).toBeNull();
    expect(policyRefuses(job({ company: "ACME Robotics Inc." }), p)).toMatch(/excluded acme/);
    expect(policyRefuses(job({ tier: "us" }), p)).toMatch(/not in canada/);
    expect(policyRefuses(job({ level: "new_grad" }), p)).toMatch(/not internship/);
    expect(policyRefuses(job({ score: 0.4 }), p)).toMatch(/under 0.5/);
    expect(policyRefuses(job({ ats: "workday" }), p)).toMatch(/not one of your boards/);
    // An empty list is no restriction.
    expect(policyRefuses(job({ tier: "us", level: "new_grad", ats: "workday" }), policy())).toBeNull();
  });
});

describe("the daily run", () => {
  it("stops at the day's number, one job per employer, best first", async () => {
    const entries = [job({ score: 0.6 }), job({ score: 0.9, ats: "lever" }), job({ score: 0.7, ats: "ashby" }), job({ score: 0.5, ats: "rippling" })];
    const w = world(entries);
    const s = await dailyRun(policy({ target: 3 }), { dry: false }, w.deps);
    expect(w.ran).toEqual(["j2", "j3", "j1"]);
    expect(s.sent.map((l) => l.id)).toEqual(["j2", "j3", "j1"]);
    expect(s.stoppedBecause).toMatch(/3 applications are done/);
    expect(entries[3]?.status).toBe("queued");
  });

  it("counts what was already sent today, and stops when nothing suitable is left", async () => {
    const earlier = new Date(2026, 9, 5, 7, 0, 0).toISOString();
    const yesterday = new Date(2026, 9, 4, 12, 0, 0).toISOString();
    const entries = [job({ status: "applied", appliedAt: earlier, ats: "lever" }), job({ status: "applied", appliedAt: yesterday }), job({ status: "submission_unknown", updatedAt: earlier, ats: "ashby" }), job({ ats: "rippling" })];
    expect(countToday(entries, TODAY)).toMatchObject({ sent: 1, unconfirmed: 1 });
    const w = world(entries);
    // Two of three are taken by this morning's work: one sent, one clicked and not confirmed.
    const s = await dailyRun(policy({ target: 3 }), { dry: false }, w.deps);
    expect(w.ran).toEqual(["j4"]);
    expect(s.sentBefore).toBe(1);
    const none = await dailyRun(policy({ target: 10 }), { dry: false }, world([job({ status: "applied", appliedAt: earlier })]).deps);
    expect(none.stoppedBecause).toMatch(/no suitable job/);
  });

  it("applies to one employer once a day, and leaves an employer with open forms alone", async () => {
    const entries = [job({ company: "Acme", score: 0.9 }), job({ company: "acme ", score: 0.8, ats: "lever" }), job({ company: "Globex", status: "awaiting_user_action" }), job({ company: "Globex", status: "submission_unknown", updatedAt: new Date(2026, 9, 1).toISOString() }), job({ company: "Globex", ats: "ashby" })];
    const w = world(entries);
    await dailyRun(policy({ target: 5 }), { dry: false }, w.deps);
    expect(w.ran).toEqual(["j1"]);
  });

  it("puts minutes between two applications to one board, and uses another board meanwhile", async () => {
    const entries = [job({ score: 0.9 }), job({ score: 0.8 }), job({ score: 0.7, ats: "lever" })];
    const w = world(entries);
    await dailyRun(policy({ target: 3 }), { dry: false }, w.deps);
    // The second Greenhouse job is the better one, and the Lever job goes first because its board is free.
    expect(w.ran).toEqual(["j1", "j3", "j2"]);
    expect(w.slept).toHaveLength(1);
    expect(w.slept[0]).toBeGreaterThan(DAILY.gapMs[0] - 61_000);
    expect(w.slept[0]).toBeLessThanOrEqual(DAILY.gapMs[1]);
  });

  it("holds each board to its number for the day", async () => {
    const entries = Array.from({ length: DAILY.perBoard + 3 }, () => job());
    const w = world(entries);
    const s = await dailyRun(policy({ target: 20 }), { dry: false, maxMinutes: 600 }, w.deps);
    expect(s.sent).toHaveLength(DAILY.perBoard);
    expect(s.stoppedBecause).toMatch(/no suitable job/);
  });

  it("leaves a board alone until tomorrow once it asks for a human check, and stops the run at the second board", async () => {
    const entries = [job({ score: 0.9 }), job({ score: 0.8 }), job({ score: 0.7, ats: "lever" }), job({ score: 0.6, ats: "ashby" })];
    const w = world(entries, (e) => (e.job.ats === "ashby" ? {} : { status: "awaiting_user_action", waitingFor: e.job.ats === "greenhouse" ? "human_code" : "robot_check", reason: "the board emailed you a code" }));
    const s = await dailyRun(policy({ target: 4 }), { dry: false }, w.deps);
    expect(w.ran).toEqual(["j1", "j3"]);
    expect(s.waiting.map((l) => l.id)).toEqual(["j1", "j3"]);
    expect(s.paused.map((p) => p.board)).toEqual(["greenhouse", "lever"]);
    expect(s.stoppedBecause).toMatch(/2 boards asked for a human check/);
    const pauses = loadPauses(w.deps.pausesFile);
    expect(new Date(pauses.greenhouse?.until ?? "").getTime()).toBe(new Date(2026, 9, 6).getTime());
    // The next run on the same day does not touch those boards.
    const later = world(entries, () => ({}));
    later.deps.pausesFile = w.deps.pausesFile as string;
    await dailyRun(policy({ target: 4 }), { dry: false }, later.deps);
    expect(later.ran).toEqual(["j4"]);
  });

  it("does not count a sign-in the person has to finish as a human check on the form", async () => {
    const entries = [job({ ats: "workday" }), job({ ats: "lever" })];
    const w = world(entries, (e) => (e.job.ats === "workday" ? { status: "awaiting_user_action", waitingFor: "login", reason: "the board refused the stored password" } : {}));
    const s = await dailyRun(policy({ target: 2 }), { dry: false }, w.deps);
    expect(s.paused).toEqual([]);
    expect(s.waiting).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });

  it("pauses a board that says it is getting too many requests", async () => {
    const entries = [job(), job({ ats: "lever" })];
    const w = world(entries, (e) => (e.job.ats === "greenhouse" ? { status: "needs_review", ready: false, reason: "not sent: 429 https://boards.example/api" } : {}));
    const s = await dailyRun(policy({ target: 2 }), { dry: false }, w.deps);
    expect(s.paused).toEqual([{ board: "greenhouse", why: "it refused a burst of requests" }]);
    expect(s.leftForYou[0]).toMatchObject({ id: "j1", status: "needs_review" });
  });

  it("stops at its limits of jobs, time and JEV spend", async () => {
    const many = () => Array.from({ length: 12 }, (_, i) => job({ ats: ["greenhouse", "lever", "ashby", "rippling"][i % 4] as string }));
    const failing = (): Partial<Outcome> => ({ status: "needs_review", ready: false, reason: "a required question has no answer" });
    const attempts = await dailyRun(policy(), { dry: false, maxAttempts: 3 }, world(many(), failing).deps);
    expect(attempts.stoppedBecause).toMatch(/opened 3 jobs/);
    expect(attempts.leftForYou).toHaveLength(3);
    const time = await dailyRun(policy(), { dry: false, maxMinutes: 1 }, world(many()).deps);
    expect(time.stoppedBecause).toMatch(/time limit/);
    expect(time.sent.length).toBeLessThan(4);
    const w = world(many());
    const budget = await dailyRun(policy({ jevBudgetUsd: 0.004 }), { dry: false }, w.deps);
    expect(budget.stoppedBecause).toMatch(/JEV has cost/);
    expect(w.ran).toHaveLength(2);
  });

  it("stops when asked, after the application it is on and before the next", async () => {
    const entries = [job({ score: 0.9 }), job({ score: 0.8, ats: "lever" }), job({ score: 0.7, ats: "ashby" })];
    const w = world(entries);
    // The person asks while the first application is being filled.
    w.deps.stop = () => w.ran.length >= 1;
    const s = await dailyRun(policy({ target: 3 }), { dry: false }, w.deps);
    expect(w.ran).toEqual(["j1"]);
    expect(s.sent).toHaveLength(1);
    expect(s.stoppedBecause).toBe("you asked it to stop");
    const file = path.join(w.dir, "daily.stop");
    expect(stopRequested(file)).toBe(false);
    requestStop(file);
    expect(stopRequested(file)).toBe(true);
    clearStop(file);
    expect(stopRequested(file)).toBe(false);
  });

  it("never asks for more than the hard limit, whatever the flag says", async () => {
    const s = await dailyRun(policy(), { dry: false, target: 500 }, world([job()]).deps);
    expect(s.target).toBe(DAILY.maxTarget);
  });

  it("takes a job on an account board only when the tool may sign in today", async () => {
    const entries = [job({ ats: "workday", url: "https://acme.wd5.myworkdayjobs.com/Careers/job/x/Intern_R1", score: 0.9 }), job({ ats: "lever" })];
    const w = world(entries);
    w.deps.gate = () => (url) => (url.includes("myworkdayjobs") ? "today's limit of 3 new accounts is reached" : null);
    await dailyRun(policy({ target: 2 }), { dry: false }, w.deps);
    expect(w.ran).toEqual(["j2"]);
  });

  it("rehearses without waiting and without counting on records", async () => {
    const entries = [job({ score: 0.9 }), job({ score: 0.8 }), job({ score: 0.7 })];
    const w = world(entries, (e) => ({ status: "queued", ready: e.job.id !== "j2", reason: e.job.id === "j2" ? "empty: Why us?" : null }));
    const s = await dailyRun(policy({ target: 2 }), { dry: true }, w.deps);
    expect(w.slept).toEqual([]);
    expect(s.sent.map((l) => l.id)).toEqual(["j1", "j3"]);
    expect(s.leftForYou.map((l) => l.id)).toEqual(["j2"]);
    expect(formatDaily(s)).toMatch(/Rehearsal\. Nothing was sent\. Would have sent 2 of 2/);
  });

  it("keeps a run that throws from stopping the day", async () => {
    const entries = [job(), job({ ats: "lever" })];
    const w = world(entries);
    const run = w.deps.run;
    w.deps.run = async (id) => {
      if (id === "j1") throw new Error("the tab was closed");
      return run(id);
    };
    const s = await dailyRun(policy({ target: 2 }), { dry: false }, w.deps);
    expect(s.leftForYou[0]).toMatchObject({ id: "j1", why: "the tab was closed" });
    expect(s.sent.map((l) => l.id)).toEqual(["j2"]);
  });

  it("names a company's own site as its board, and writes each run into the day's file", async () => {
    expect(boardOf({ ats: "other", url: "https://careers.acme.com/jobs/1" })).toBe("acme.com");
    expect(boardOf({ ats: "ashby", url: "https://jobs.ashbyhq.com/acme/1" })).toBe("ashby");
    const w = world([job()]);
    const s = await dailyRun(policy({ target: 1 }), { dry: false }, w.deps);
    const file = path.join(w.dir, "daily.json");
    saveDaily(s, file);
    saveDaily(s, file);
    expect((JSON.parse(readFileSync(file, "utf8")) as { runs: unknown[] }).runs).toHaveLength(2);
    expect(formatDaily(s)).toMatch(/Sent 1 of 1\. Stopped because the day's 1 applications are done/);
    pauseBoard("lever", "it asked for a human check", START, path.join(w.dir, "p.json"));
    writeFileSync(path.join(w.dir, "bad.json"), "{");
    expect(() => loadPauses(path.join(w.dir, "bad.json"))).toThrow(/cannot be read/);
  });
});

describe("the schedule", () => {
  it("reads a time of day and nothing else", () => {
    expect(timeOfDay("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(timeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    for (const bad of ["24:00", "9", "09:60", "morning", "09:00; rm -rf /"]) expect(timeOfDay(bad), bad).toBeNull();
  });

  it("writes a LaunchAgent that runs `jev daily` in the project folder, and nothing more", () => {
    const text = agentPlist({ node: "/usr/local/bin/node", root: "/Users/someone/jev & co", hour: 9, minute: 5, searchPath: "/usr/bin:/bin", log: "/tmp/daily.log" });
    expect(text).toContain("<string>/usr/local/bin/node</string><string>/Users/someone/jev &amp; co/bin/jev.js</string><string>daily</string>");
    expect(text).toContain("<key>Hour</key><integer>9</integer><key>Minute</key><integer>5</integer>");
    expect(text).toContain("<key>RunAtLoad</key><false/>");
    expect(text).not.toMatch(/--submit|KEY|TOKEN|PASSWORD/);
  });

  it("is installed only when asked, replaced by a new time, and removed again", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-agent-"));
    const file = path.join(dir, "LaunchAgents", "agent.plist");
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0 };
    };
    expect(scheduleStatus({ file, run })).toMatchObject({ installed: false, loaded: false });
    expect(() => installSchedule("soon", { file, run })).toThrow(/not a time of day/);
    expect(existsSync(file)).toBe(false);
    expect(installSchedule("7:30", { file, run, node: "/n", root: "/r", searchPath: "/usr/bin" })).toMatchObject({ at: "07:30" });
    expect(readFileSync(file, "utf8")).toContain("<integer>30</integer>");
    expect(calls.map((c) => c[0])).toEqual(["print", "bootout", "bootstrap"].slice(1));
    expect(scheduleStatus({ file, run })).toMatchObject({ installed: true, loaded: true });
    expect(removeSchedule({ file, run })).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(removeSchedule({ file, run })).toBe(false);
  });
});
