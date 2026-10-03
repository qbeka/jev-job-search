import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRun, currentRun, withLock, writeAtomic } from "../src/util/store.js";
import { entryFor, KEPT_ON_REDISCOVERY, loadQueue, mutateQueue, QueueStatus, saveQueue, type QueueEntry } from "../src/jobs/queue.js";
import { statusKeyOf, statusLabel } from "../src/log/csv.js";
import { pickJobs } from "../src/run/pipeline.js";
import { mergeDecided } from "../src/discover.js";
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
});
