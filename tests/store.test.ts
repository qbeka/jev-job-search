import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRun, currentRun, withLock, writeAtomic } from "../src/util/store.js";
import { entryFor, KEPT_ON_REDISCOVERY, loadQueue, mutateQueue, QueueStatus, saveQueue, updateEntry, type QueueEntry } from "../src/jobs/queue.js";
import { statusKeyOf, statusLabel } from "../src/log/csv.js";
import { pickJobs } from "../src/run/pipeline.js";
import { mergeDecided, writeDecided } from "../src/discover.js";
import type { Job } from "../src/jobs/normalize.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "jev-store-"));
const job = (n: number): Job => ({ id: `id${n}`, source: "t", company: `Co${n}`, title: "Intern", url: `https://boards.greenhouse.io/co${n}/jobs/${n}`, ats: "greenhouse", locations: [], postedAt: "2026-10-01", terms: [], sponsorship: "unknown", degrees: [], category: null });
const fit = { score: 0.5, decision: "apply" as const, skipReason: null, reasons: [], components: {}, locationTier: "canada" as const, answers: {} };
const entry = (n: number, over: Partial<QueueEntry> = {}): QueueEntry => ({ ...entryFor(job(n), fit as never, null), ...over });

describe("writing files", () => {
  it("replaces a file whole and leaves no temp file behind", () => {
    const d = dir();
    const f = path.join(d, "a.json");
    writeAtomic(f, "one");
    writeAtomic(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(readdirSync(d)).toEqual(["a.json"]);
  });
});

describe("the write lock", () => {
  it("runs the work, nests in one process, and is gone afterwards", () => {
    const d = dir();
    const out = withLock("t", () => withLock("t", () => 7, d), d);
    expect(out).toBe(7);
    expect(existsSync(path.join(d, "t.lock"))).toBe(false);
  });
  it("takes over a lock left by a process that is gone", () => {
    const d = dir();
    writeFileSync(path.join(d, "t.lock"), JSON.stringify({ pid: 999_999_99, at: Date.now() }));
    expect(withLock("t", () => "ok", d)).toBe("ok");
  });
  it("is released when the work throws", () => {
    const d = dir();
    expect(() => withLock("t", () => { throw new Error("boom"); }, d)).toThrow("boom");
    expect(existsSync(path.join(d, "t.lock"))).toBe(false);
  });
});

describe("the run lock", () => {
  it("names the run that holds the browser and refuses a second one from another process", () => {
    const f = path.join(dir(), "run.lock");
    expect(currentRun(f)).toBeNull();
    const release = acquireRun("apply --count 5", f);
    expect(currentRun(f)?.command).toBe("apply --count 5");
    release();
    expect(currentRun(f)).toBeNull();
    // Another live process (this test's parent) holds it.
    writeFileSync(f, JSON.stringify({ pid: process.ppid, command: "daily", startedAt: new Date().toISOString() }));
    expect(() => acquireRun("apply", f)).toThrow(/another run is using the browser: "daily"/);
    // A lock whose process is gone does not count.
    writeFileSync(f, JSON.stringify({ pid: 999_999_99, command: "apply", startedAt: new Date().toISOString() }));
    expect(currentRun(f)).toBeNull();
  });
});

describe("the queue file", () => {
  it("is changed by a fresh read and a whole write, keeps a backup, and refuses a file it cannot read", () => {
    const f = path.join(dir(), "queue.json");
    saveQueue({ version: 1, generatedAt: "x", entries: [entry(1)] }, f);
    mutateQueue((q) => { q.entries[0]!.status = "applied"; }, f);
    expect(loadQueue(f).entries[0]?.status).toBe("applied");
    expect(existsSync(`${f}.bak`)).toBe(true);
    writeFileSync(f, "{ not json");
    expect(() => loadQueue(f)).toThrow(/cannot be read.*\.bak/);
  });
  it("reads a queue written before the new fields existed", () => {
    const f = path.join(dir(), "queue.json");
    const old = entry(1) as Record<string, unknown>;
    delete old.waitingFor;
    writeFileSync(f, JSON.stringify({ version: 1, generatedAt: "x", entries: [old] }));
    expect(loadQueue(f).entries[0]?.waitingFor).toBeNull();
  });
});

describe("statuses", () => {
  it("round-trip through the words in the record", () => {
    for (const status of QueueStatus.options) expect(statusKeyOf(statusLabel({ status, statusReason: "because: of this" }))).toBe(status);
    expect(statusKeyOf("Needs review")).toBe("needs_review");
    expect(statusKeyOf("something typed by hand")).toBeNull();
  });
  it("only a sent application is labelled as applied", () => {
    for (const status of QueueStatus.options) if (status !== "applied") expect(statusLabel({ status, statusReason: null }).startsWith("Applied")).toBe(false);
  });
});

describe("which jobs a run may take", () => {
  const entries = [entry(1), entry(2, { status: "applied", appliedAt: "2026-10-02T10:00:00Z" }), entry(3, { status: "submission_unknown" }), entry(4, { status: "needs_review" })];
  it("takes queued jobs by default", () => {
    expect(pickJobs(entries, [], { count: 5, dry: false }).picked.map((e) => e.job.company)).toEqual(["Co1"]);
  });
  it("refuses a sent job and an unconfirmed one by id, and takes a held one", () => {
    const ids = entries.map((e) => e.job.id);
    const r = pickJobs(entries, ids, { count: 1, dry: false });
    expect(r.picked.map((e) => e.job.company)).toEqual(["Co1", "Co4"]);
    expect(r.refused.map((x) => x.why.slice(0, 15))).toEqual(["already applied", "Submit was clic"]);
  });
  it("lets a sent job through only with resubmit, and never an unconfirmed one", () => {
    const ids = entries.map((e) => e.job.id);
    const r = pickJobs(entries, ids, { count: 1, dry: false, resubmit: true });
    expect(r.picked.map((e) => e.job.company)).toEqual(["Co1", "Co2", "Co4"]);
  });
  it("a rehearsal may take anything, since it sends nothing", () => {
    expect(pickJobs(entries, entries.map((e) => e.job.id), { count: 1, dry: true }).picked).toHaveLength(4);
  });
});

describe("a search merged into the queue", () => {
  it("keeps what a run decided, and keeps a sent job whose posting is gone", () => {
    const current = [entry(1, { status: "applied" }), entry(2, { status: "awaiting_user_action", statusReason: "robot check", waitingFor: "robot_check" }), entry(3), entry(4, { status: "skipped" }), entry(5, { status: "submission_unknown" })];
    const merged = mergeDecided(current, [{ job: job(2), fit: fit as never, reason: null }, { job: job(6), fit: fit as never, reason: null }, { job: job(5), fit: null, reason: null, failed: "rating failed" }]);
    const by = new Map(merged.map((e) => [e.job.company, e]));
    expect(by.get("Co1")?.status).toBe("applied");
    expect(by.get("Co2")?.status).toBe("awaiting_user_action");
    expect(by.get("Co2")?.waitingFor).toBe("robot_check");
    expect(by.has("Co3")).toBe(false);
    expect(by.has("Co4")).toBe(false);
    expect(by.get("Co5")?.status).toBe("submission_unknown");
    expect(by.get("Co6")?.status).toBe("queued");
    // A posting text read on an earlier search is kept when this search did not read it again.
    const kept = mergeDecided([entry(7, { status: "applied", job: { ...entry(7).job, description: "what the job is" } })], [{ job: job(7), fit: fit as never, reason: null }]);
    expect(kept[0]?.job.description).toBe("what the job is");
    expect(KEPT_ON_REDISCOVERY).not.toContain("queued");
  });

  it("decides again what a search itself skipped, and shows the reason that holds today", () => {
    const skip = { ...fit, decision: "skip" as const, skipReason: "not a software role" };
    // Skipped once because its board wanted an account. Now the account is there.
    const walled = entryFor(job(8), null, "workday (needs an account per company)");
    expect(walled).toMatchObject({ status: "skipped", statusReason: "workday (needs an account per company)" });
    // Rated and wanted: it is queued, with no reason left on it.
    expect(entryFor(job(8), fit as never, null, walled)).toMatchObject({ status: "queued", statusReason: null });
    // Rated and skipped for another reason: the record says that reason, not the old one.
    expect(entryFor(job(8), skip as never, null, walled)).toMatchObject({ status: "skipped", statusReason: "not a software role" });
    // The same for a job JEV skipped before and rates differently now.
    expect(entryFor(job(8), fit as never, null, entryFor(job(8), skip as never, null)).status).toBe("queued");
    // A skip a run or the person decided is theirs: the search leaves it and its reason alone.
    const refused = { ...walled, statusReason: "the board refused a second application: you recently applied to this company" };
    expect(entryFor(job(8), fit as never, null, refused)).toMatchObject({ status: "skipped", statusReason: refused.statusReason });
  });
});

describe("a search that ends while another process is working on the queue", () => {
  it("writes back nothing it read at its start: what the others changed meanwhile is all still there", () => {
    const d = dir();
    const files = { queue: path.join(d, "queue.json"), rows: path.join(d, "all.csv") };
    const stale = entry(8, { updatedAt: "2026-09-01T00:00:00.000Z" });
    saveQueue({ version: 1, generatedAt: "2026-10-01T00:00:00.000Z", entries: [entry(1), entry(2), entry(3), entry(4), stale] }, files.queue);

    // The search reads the queue, then goes off to read boards and rate for minutes. It holds no lock while it does.
    const atStart = loadQueue(files.queue);
    const since = new Date(Date.now() - 1000).toISOString();
    const idOf = (n: number) => atStart.entries.find((e) => e.job.company === `Co${n}`)?.job.id as string;

    // Meanwhile an apply run sends one job and is in the middle of a second, the dashboard saves an answer on a third,
    // and a link the person pasted adds a job the search never sees.
    mutateQueue((q) => {
      updateEntry(q, idOf(1), { status: "applied", appliedAt: "2026-10-04T12:00:00.000Z" });
      updateEntry(q, idOf(2), { status: "in_progress" });
      updateEntry(q, idOf(3), { answers: [{ question: "Why us?", answer: "Because." }] });
      q.entries.push(entry(9));
    }, files.queue);

    // The search ends. It found the four jobs it knew, all still wanted, and neither the pasted one nor the stale one.
    const decided = [1, 2, 3, 4].map((n) => ({ job: { ...job(n), id: idOf(n) }, fit: fit as never, reason: null }));
    const merged = writeDecided(decided, new Date(), since, files);

    for (const entries of [merged.entries, loadQueue(files.queue).entries]) {
      const by = new Map(entries.map((e) => [e.job.company, e]));
      expect(by.get("Co1")).toMatchObject({ status: "applied", appliedAt: "2026-10-04T12:00:00.000Z" });
      expect(by.get("Co2")?.status).toBe("in_progress");
      expect(by.get("Co3")).toMatchObject({ status: "queued", answers: [{ question: "Why us?", answer: "Because." }] });
      expect(by.get("Co4")?.status).toBe("queued");
      // Added while the search ran: kept, though the search did not see it.
      expect(by.get("Co9")?.status).toBe("queued");
      // Untouched since long before the search, and no longer posted: dropped, as before.
      expect(by.has("Co8")).toBe(false);
    }
    // The record on disk was written from the merged queue, not from what the search read at its start.
    expect(readFileSync(files.rows, "utf8")).toMatch(/Co1[^\n]*Applied/);
  });

  it("drops a job nobody touched during the search when the search no longer finds it", () => {
    const old = entry(8, { updatedAt: "2026-09-01T00:00:00.000Z" });
    expect(mergeDecided([old], [], "2026-10-04T00:00:00.000Z")).toEqual([]);
    expect(mergeDecided([{ ...old, updatedAt: "2026-10-04T00:05:00.000Z" }], [], "2026-10-04T00:00:00.000Z")).toHaveLength(1);
  });
});
