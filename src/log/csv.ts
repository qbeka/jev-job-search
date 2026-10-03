/**
 * Two files, written together.
 *
 * applications/all.csv is the record of every job considered and what
 * happened. Its first fifteen columns match the user's tracking sheet so the
 * file pastes straight into it; the rest are the tool's own.
 *
 * applied.csv, at the top of the project folder, holds only the applications
 * that were sent, newest first, under plain column names that a script can
 * read without a mapping.
 *
 * manual.csv, beside it, holds the jobs the tool set aside for the person:
 * each with the reason and the link.
 *
 * Both are rebuilt from the full record on every save.
 */
import { existsSync, readFileSync } from "node:fs";
import { PATHS } from "../config.js";
import { postingKey } from "../jobs/normalize.js";
import type { QueueEntry, QueueStatus } from "../jobs/queue.js";
import { withStore, writeAtomic } from "../util/store.js";

export const SHEET_COLUMNS = [
  "Company", "What They Do", "Role / Title", "Location", "Visa / Work Auth", "Job Link",
  "Contact #1 (Name / Role / LinkedIn)", "Contact #2 (Name / Role / LinkedIn)", "Contact #3 (Name / Role / LinkedIn)",
  "What to Build / Pitch Idea", "Why You're a Fit", "Response from Ref.", "Deadline", "App. Status", "Notes",
] as const;

export const EXTRA_COLUMNS = [
  "Applied On", "Fit Score", "JEV Confidence", "ATS", "Source", "Term", "Level", "Posted On", "Skip Reason", "Job ID", "Take-home",
] as const;

export const COLUMNS = [...SHEET_COLUMNS, ...EXTRA_COLUMNS] as const;
export type Column = (typeof COLUMNS)[number];
export type Row = Record<Column, string>;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export function emptyRow(): Row {
  return Object.fromEntries(COLUMNS.map((c) => [c, ""])) as Row;
}

export function loadRows(file = PATHS.applications): Row[] {
  if (!existsSync(file)) return [];
  const [header, ...body] = parseCsv(readFileSync(file, "utf8"));
  if (!header) return [];
  return body.map((cells) => {
    const row = emptyRow();
    header.forEach((h, i) => {
      if ((COLUMNS as readonly string[]).includes(h)) row[h as Column] = cells[i] ?? "";
    });
    return row;
  });
}

export function saveRows(rows: Row[], file = PATHS.applications, appliedFile: string | null = file === PATHS.applications ? PATHS.applied : null, manualFile: string | null = file === PATHS.applications ? PATHS.manual : null): void {
  const kept = compactRows(rows);
  writeAtomic(file, toCsv([[...COLUMNS], ...kept.map((r) => COLUMNS.map((c) => r[c] ?? ""))]));
  if (appliedFile) writeAtomic(appliedFile, toCsv([[...APPLIED_COLUMNS], ...appliedRecords(kept).map((r) => APPLIED_COLUMNS.map((c) => r[c]))]));
  if (manualFile) writeAtomic(manualFile, toCsv([[...MANUAL_COLUMNS], ...manualRecords(kept).map((r) => MANUAL_COLUMNS.map((c) => r[c]))]));
  if (file === PATHS.applications) writeAtomic(PATHS.takehome, toCsv([[...TAKEHOME_COLUMNS], ...takehomeRecords(kept).map((r) => TAKEHOME_COLUMNS.map((c) => r[c]))]));
}

/** Changes the record files: a fresh read, the change, whole-file writes, under the store lock. */
export function mutateRows(fn: (rows: Row[]) => Row[]): void {
  withStore(() => saveRows(fn(loadRows())));
}

/** The columns of takehome.csv: applications that went out to a company that also wants a take-home assignment. */
export const TAKEHOME_COLUMNS = ["applied_on", "company", "role", "takehome_link", "instructions", "job_link", "job_id"] as const;
export type TakehomeRecord = Record<(typeof TAKEHOME_COLUMNS)[number], string>;

/** A take-home is kept in the record as "link | what the form said". */
export const takeHomeCell = (url: string, text: string) => `${url} | ${text.replace(/\s+/g, " ").trim()}`;

export function takehomeRecords(rows: Row[]): TakehomeRecord[] {
  return rows
    .filter((r) => r["App. Status"] === "Applied" && r["Take-home"])
    .map((r) => {
      const [link = "", ...rest] = r["Take-home"].split(" | ");
      return { applied_on: r["Applied On"], company: r.Company, role: r["Role / Title"], takehome_link: link, instructions: rest.join(" | "), job_link: r["Job Link"], job_id: r["Job ID"] };
    });
}

/** The columns of manual.csv: the jobs the tool set aside for the person, with why and where. */
export const MANUAL_COLUMNS = ["company", "role", "location", "reason", "job_link", "fit_score", "ats", "posted_on", "job_id"] as const;
export type ManualRecord = Record<(typeof MANUAL_COLUMNS)[number], string>;

/**
 * Jobs the tool opened and could not finish, best fit first: a site that wants a sign-in, a form
 * that asks for a signature or for something the profile does not say, a form waiting on an
 * emailed code. Each has its reason and its link, so the person can apply by hand.
 */
export function manualRecords(rows: Row[]): ManualRecord[] {
  return rows
    .filter((r) => MANUAL_STATUSES.includes(statusKeyOf(r["App. Status"])))
    .map((r) => ({ company: r.Company, role: r["Role / Title"], location: r.Location, reason: r["Skip Reason"] || r["App. Status"].replace(/^[^:]*:\s*/, ""), job_link: r["Job Link"], fit_score: r["Fit Score"], ats: r.ATS, posted_on: r["Posted On"], job_id: r["Job ID"] }))
    .sort((a, b) => Number(b.fit_score || 0) - Number(a.fit_score || 0));
}

/** The columns of applied.csv: lower case, no spaces, one meaning each. */
export const APPLIED_COLUMNS = ["applied_on", "company", "role", "location", "job_link", "work_auth", "term", "level", "ats", "source", "fit_score", "what_they_do", "why_fit", "notes", "job_id"] as const;
export type AppliedRecord = Record<(typeof APPLIED_COLUMNS)[number], string>;

/** One plain record per row of the full file. */
export function toRecord(r: Row): AppliedRecord & { status: string; skip_reason: string } {
  return {
    applied_on: r["Applied On"],
    company: r.Company,
    role: r["Role / Title"],
    location: r.Location,
    job_link: r["Job Link"],
    work_auth: r["Visa / Work Auth"],
    term: r.Term,
    level: r.Level,
    ats: r.ATS,
    source: r.Source,
    fit_score: r["Fit Score"],
    what_they_do: r["What They Do"],
    why_fit: r["Why You're a Fit"],
    notes: r.Notes,
    job_id: r["Job ID"],
    status: r["App. Status"],
    skip_reason: r["Skip Reason"],
  };
}

/** The applications that were sent, newest first. */
export function appliedRecords(rows: Row[]): AppliedRecord[] {
  return rows
    .filter((r) => r["App. Status"].startsWith("Applied"))
    .map(toRecord)
    .sort((a, b) => b.applied_on.localeCompare(a.applied_on) || a.company.localeCompare(b.company));
}

const STATUS_RANK = ["Applied", "Unconfirmed", "Waiting for you", "Needs you", "Needs review", "Sign-in needed", "Blocked", "Verifying email", "Registering", "Signed in", "In progress", "Queued", "Failed", "Skipped"];
const rank = (r: Row) => {
  const i = STATUS_RANK.findIndex((s) => r["App. Status"].startsWith(s));
  return i < 0 ? STATUS_RANK.length : i;
};

/**
 * One row per posting. Rows that name the same posting by different links (a list's link and the
 * board's own) are merged: the row that got furthest wins, and cells a person filled in by hand
 * are kept from whichever row has them. Order is preserved.
 */
export function compactRows(rows: Row[]): Row[] {
  const kept = new Map<string, Row>();
  const order: string[] = [];
  rows.forEach((row, i) => {
    const key = row["Job Link"] ? postingKey(row["Job Link"]) : row["Job ID"] || `row:${i}`;
    const seen = kept.get(key);
    if (!seen) {
      kept.set(key, row);
      order.push(key);
      return;
    }
    const [winner, other] = rank(row) < rank(seen) ? [row, seen] : [seen, row];
    const merged = { ...winner };
    for (const c of COLUMNS) if (!merged[c] && other[c] && (SHEET_COLUMNS as readonly string[]).includes(c)) merged[c] = other[c];
    kept.set(key, merged);
  });
  return order.map((k) => kept.get(k) as Row);
}

/** Inserts or updates the row for a queue entry, keyed by Job Link, then Job ID. Hand-filled columns are preserved. */
export function upsertEntry(rows: Row[], e: QueueEntry, extra: Partial<Row> = {}): Row[] {
  // One row per posting: the same job reached by another link updates its row instead of adding one.
  const key = postingKey(e.job.url);
  const idx = rows.findIndex((r) => r["Job Link"] === e.job.url || (r["Job ID"] && r["Job ID"] === e.job.id) || (r["Job Link"] !== "" && postingKey(r["Job Link"]) === key));
  const existing = idx >= 0 ? (rows[idx] as Row) : emptyRow();
  const status = statusLabel(e);
  const fit = e.fit;
  const next: Row = {
    ...existing,
    Company: e.job.company,
    "Role / Title": e.job.title,
    Location: e.job.locations.join(" / "),
    "Visa / Work Auth": existing["Visa / Work Auth"] || workAuthLabel(e),
    "Job Link": e.job.url,
    "App. Status": status,
    Notes: existing.Notes || (fit ? fit.reasons.join("; ") : ""),
    "Applied On": e.appliedAt ? localDate(e.appliedAt) : existing["Applied On"],
    "Fit Score": fit ? fit.score.toFixed(3) : "",
    "JEV Confidence": fit ? avgConfidence(fit).toFixed(2) : "",
    ATS: e.job.ats,
    Source: e.job.source,
    Term: termLabel(e),
    Level: fit ? ((fit.answers.level as { choice?: string } | undefined)?.choice ?? "") : "",
    "Posted On": e.job.postedAt ?? "",
    "Skip Reason": e.status === "applied" || e.status === "queued" || e.status === "in_progress" ? "" : (e.statusReason ?? ""),
    "Job ID": e.job.id,
    ...extra,
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return rows;
}

/** The calendar day where the candidate is, not the UTC day: an application sent at 10pm belongs to today. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** What the status column says for each status. Only "Applied" may start with that word: the sent list is found by it. */
const STATUS_WORDS: Record<QueueStatus, string> = {
  applied: "Applied",
  queued: "Queued",
  in_progress: "In progress",
  needs_review: "Needs you",
  blocked: "Blocked",
  failed: "Failed",
  skipped: "Skipped",
  login_required: "Sign-in needed",
  registering: "Registering",
  awaiting_email_verification: "Verifying email",
  authenticated: "Signed in",
  awaiting_user_action: "Waiting for you",
  submission_unknown: "Unconfirmed",
};
/** Statuses that carry their reason in the status column itself. */
const WITH_REASON: readonly QueueStatus[] = ["blocked", "failed", "skipped", "awaiting_user_action", "submission_unknown"];
/** Statuses that put a job on the by-hand list. */
const MANUAL_STATUSES: readonly (QueueStatus | null)[] = ["needs_review", "blocked", "login_required", "awaiting_user_action", "submission_unknown"];

export function statusLabel(e: Pick<QueueEntry, "status" | "statusReason">): string {
  const word = STATUS_WORDS[e.status];
  return WITH_REASON.includes(e.status) ? `${word}: ${e.statusReason ?? ""}`.trim() : word;
}

/** The status a status-column value stands for, or null for a value written by hand. "Needs review" is what older files say. */
export function statusKeyOf(label: string): QueueStatus | null {
  const word = label.replace(/:.*$/s, "").trim();
  if (word === "Needs review") return "needs_review";
  const hit = (Object.entries(STATUS_WORDS) as [QueueStatus, string][]).find(([, w]) => w === word);
  return hit ? hit[0] : null;
}

function workAuthLabel(e: QueueEntry): string {
  const a = e.fit?.answers.work_auth as { choice?: string } | undefined;
  switch (a?.choice) {
    case "canada_ok": return "Canada. No visa needed.";
    case "us_sponsors": return "US. Sponsorship offered.";
    case "us_no_sponsorship": return "US. No sponsorship.";
    case "us_citizenship_required": return "US citizenship required.";
    case "remote_global": return "Remote, any country.";
    default: return e.fit ? "Not stated." : "";
  }
}

function termLabel(e: QueueEntry): string {
  // What the source list says (Summer 2027) reads better than the rating's own key (summer).
  if (e.job.terms.length) return e.job.terms.join(", ");
  const a = e.fit?.answers.term as { choice?: string } | undefined;
  return (a?.choice ?? "").replace(/_/g, " ");
}

function avgConfidence(fit: NonNullable<QueueEntry["fit"]>): number {
  const vals = Object.values(fit.answers)
    .map((a) => ("confidence" in a ? a.confidence : null))
    .filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
