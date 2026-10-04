import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APPLIED_COLUMNS, COLUMNS, MANUAL_COLUMNS, SHEET_COLUMNS, appliedRecords, compactRows, emptyRow, localDate, manualRecords, parseCsv, saveRows, toCsv, upsertEntry } from "../src/log/csv.js";
import type { QueueEntry } from "../src/jobs/queue.js";

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  job: { id: "abc", source: "simplify-internships", company: "Acme", title: "SWE Intern", url: "https://x/1", ats: "greenhouse", locations: ["Toronto, ON"], postedAt: "2026-10-01", terms: ["Summer 2027"], sponsorship: "unknown", degrees: [], category: null },
  fit: { score: 0.61, decision: "apply", skipReason: null, reasons: ["stack strong"], components: {}, locationTier: "canada", answers: { work_auth: { type: "choice", choice: "canada_ok", probabilities: {}, confidence: 0.9 }, term: { type: "choice", choice: "summer", probabilities: {}, confidence: 1 }, level: { type: "choice", choice: "internship", probabilities: {}, confidence: 1 } } },
  preFilterReason: null, status: "queued", statusReason: null, attempts: 0, discoveredAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", appliedAt: null, notes: null, waitingFor: null, answers: [], replies: [], response: null, ...over,
});

describe("csv", () => {
  it("round-trips quotes, commas and newlines", () => {
    const rows = [["a", 'he said "hi"', "x,y", "line1\nline2"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it("keeps the sheet's fifteen columns first, in order", () => {
    expect(COLUMNS.slice(0, 15)).toEqual([...SHEET_COLUMNS]);
    expect(SHEET_COLUMNS[0]).toBe("Company");
    expect(SHEET_COLUMNS[13]).toBe("App. Status");
  });
  it("upserts by job link and preserves hand-filled columns", () => {
    let rows = upsertEntry([], entry());
    expect(rows[0]).toMatchObject({ Company: "Acme", "App. Status": "Queued", "Fit Score": "0.610", "Visa / Work Auth": "Canada. No visa needed.", Term: "Summer 2027" });
    rows[0]!["Contact #1 (Name / Role / LinkedIn)"] = "Jane / Recruiter / url";
    rows = upsertEntry(rows, entry({ status: "applied", appliedAt: "2026-10-02T15:00:00Z" }), { "Why You're a Fit": "fits" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "App. Status": "Applied", "Applied On": "2026-10-02", "Contact #1 (Name / Role / LinkedIn)": "Jane / Recruiter / url", "Why You're a Fit": "fits" });
  });
  it("writes skip reasons only for non-applied rows", () => {
    const rows = upsertEntry([], entry({ status: "skipped", statusReason: "workday" }));
    expect(rows[0]?.["Skip Reason"]).toBe("workday");
    expect(rows[0]?.["App. Status"]).toBe("Skipped: workday");
    expect(emptyRow()["Job ID"]).toBe("");
  });
  it("keeps one row per posting however the job was linked", () => {
    const board = "https://jobs.ashbyhq.com/acme/134c282c-2837-44a8-9f7c-74ca39486490";
    let rows = upsertEntry([], entry({ job: { ...entry().job, id: "old", url: `${board}/application?embed=true` } }));
    rows = upsertEntry(rows, entry({ job: { ...entry().job, id: "new", url: board }, status: "applied", appliedAt: "2026-10-02T15:00:00Z" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "Job ID": "new", "Job Link": board, "App. Status": "Applied" });
  });
  it("dates an application by the local calendar day", () => {
    const late = new Date(2026, 9, 1, 23, 30).toISOString();
    expect(localDate(late)).toBe("2026-10-01");
    expect(localDate("not a date")).toBe("not a date");
  });
  it("compacts rows that name one posting, keeping the furthest status and hand-filled cells", () => {
    const board = "https://jobs.ashbyhq.com/acme/134c282c-2837-44a8-9f7c-74ca39486490";
    const queued = { ...emptyRow(), Company: "Acme", "Job Link": `${board}/application?embed=true`, "App. Status": "Queued", "Contact #1 (Name / Role / LinkedIn)": "Jane" };
    const applied = { ...emptyRow(), Company: "Acme", "Job Link": board, "App. Status": "Applied", "Applied On": "2026-10-01" };
    const other = { ...emptyRow(), Company: "Beta", "Job Link": "https://example.com/jobs/1", "App. Status": "Skipped: old" };
    const rows = compactRows([queued, other, applied]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ "App. Status": "Applied", "Applied On": "2026-10-01", "Contact #1 (Name / Role / LinkedIn)": "Jane", "Job Link": board });
    expect(rows[1]?.Company).toBe("Beta");
  });
  it("lists only the applications that were sent, newest first, under plain column names", () => {
    let rows = upsertEntry([], entry({ status: "applied", appliedAt: "2026-10-01T15:00:00Z" }), { "What They Do": "Builds rockets." });
    rows = upsertEntry(rows, entry({ job: { ...entry().job, id: "b", url: "https://x/2", company: "Beta" }, status: "skipped", statusReason: "workday" }));
    rows = upsertEntry(rows, entry({ job: { ...entry().job, id: "c", url: "https://x/3", company: "Gamma" }, status: "applied", appliedAt: "2026-10-02T15:00:00Z" }));
    const sent = appliedRecords(rows);
    expect(sent.map((r) => r.company)).toEqual(["Gamma", "Acme"]);
    expect(sent[1]).toMatchObject({ applied_on: "2026-10-01", role: "SWE Intern", job_link: "https://x/1", what_they_do: "Builds rockets.", job_id: "abc" });
  });
  it("writes applied.csv next to the full record, with one header a script can rely on", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "awj-csv-"));
    const rows = upsertEntry([], entry({ status: "applied", appliedAt: "2026-10-01T15:00:00Z" }));
    saveRows(rows, path.join(dir, "applications.csv"), path.join(dir, "applied.csv"), path.join(dir, "manual.csv"));
    expect(parseCsv(readFileSync(path.join(dir, "manual.csv"), "utf8"))[0]).toEqual([...MANUAL_COLUMNS]);
    const [header, first] = parseCsv(readFileSync(path.join(dir, "applied.csv"), "utf8"));
    expect(header).toEqual([...APPLIED_COLUMNS]);
    expect(header?.every((h) => /^[a-z_]+$/.test(h))).toBe(true);
    expect(first?.[1]).toBe("Acme");
  });
  it("lists the jobs left for the person, best fit first, each with its reason and its link", () => {
    let rows = upsertEntry([], entry({ status: "needs_review", statusReason: "asks for a signature: Type your name to agree to the NDA" }));
    rows = upsertEntry(rows, entry({ job: { ...entry().job, id: "b", url: "https://x/2", company: "Beta" }, fit: { ...entry().fit!, score: 0.9 }, status: "blocked", statusReason: "the site wants a sign-in or an account" }));
    rows = upsertEntry(rows, entry({ job: { ...entry().job, id: "c", url: "https://x/3", company: "Gamma" }, status: "applied", appliedAt: "2026-10-02T15:00:00Z" }));
    rows = upsertEntry(rows, entry({ job: { ...entry().job, id: "d", url: "https://x/4", company: "Delta" }, status: "skipped", statusReason: "workday" }));
    const todo = manualRecords(rows);
    expect(todo.map((r) => r.company)).toEqual(["Beta", "Acme"]);
    expect(todo[0]).toMatchObject({ reason: "the site wants a sign-in or an account", job_link: "https://x/2", job_id: "b" });
    expect(todo[1]?.reason).toMatch(/asks for a signature/);
  });
});

