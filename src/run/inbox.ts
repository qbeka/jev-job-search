/**
 * Writing down what the mailbox said. A reply the tool is sure of goes on the application's
 * record; a confirmation also settles an application whose Submit was clicked with no
 * confirmation seen. A reply it is not sure of is kept for the person to confirm.
 */
import { mutateQueue, updateEntry, type QueueEntry, type Response } from "../jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { dayOfMail, mutateInbox, outcomeOf, type Placed } from "../mail/status.js";
import { withStore } from "../util/store.js";

type Reply = { id: string; kind: Response; receivedAt: number; subject: string };
/** Where the records are. Only a test names other files. */
export type RecordFiles = { queue?: string; rows?: string; inbox?: string };

/**
 * Adds one reply to an application's history and works out where the application stands now.
 * The history only grows. An email already recorded is not recorded again. Null when there is no
 * such application, or nothing changed.
 */
export function recordReply(jobId: string, r: Reply, files: RecordFiles = {}): QueueEntry | null {
  return withStore(() => {
    const e = mutateQueue((q) => {
      const was = q.entries.find((x) => x.job.id === jobId);
      if (!was || (was.replies ?? []).some((x) => x.id === r.id)) return null;
      const replies = [...(was.replies ?? []), { id: r.id, kind: r.kind, at: r.receivedAt, subject: r.subject.slice(0, 200) }];
      const now = outcomeOf(replies);
      // Any reply from the employer proves the application reached them.
      const settles = was.status === "submission_unknown";
      return updateEntry(q, jobId, { replies, response: now ? { kind: now.kind, on: dayOfMail(now.at), subject: now.subject } : null, ...(settles ? { status: "applied" as const, statusReason: null, waitingFor: null, appliedAt: was.appliedAt ?? was.updatedAt } : {}) });
    }, files.queue);
    if (e) saveRows(upsertEntry(loadRows(files.rows), e), files.rows);
    return e;
  });
}

export type InboxSummary = { recorded: { company: string; title: string; kind: Response; settled: boolean }[]; toConfirm: number; ignored: number };

/** Records every reply the tool is sure of, keeps the unsure ones for the person, and remembers each email so it is read once. */
export function recordReplies(placed: Placed[], files: RecordFiles = {}): InboxSummary {
  const out: InboxSummary = { recorded: [], toConfirm: 0, ignored: 0 };
  for (const p of placed) {
    if (p.sure && p.entry && p.kind) {
      const wasUnknown = p.entry.status === "submission_unknown";
      const e = recordReply(p.entry.job.id, { id: p.mail.id, kind: p.kind, receivedAt: p.mail.receivedAt, subject: p.mail.subject }, files);
      if (e) out.recorded.push({ company: e.job.company, title: e.job.title, kind: p.kind, settled: wasUnknown });
    } else if (p.sure) {
      out.ignored++;
    } else {
      out.toConfirm++;
    }
  }
  mutateInbox((f) => {
    for (const p of placed) {
      f.seen[p.mail.id] = new Date().toISOString();
      if (!p.sure && !f.review.some((r) => r.id === p.mail.id)) f.review.push({ id: p.mail.id, from: p.mail.fromName || p.mail.from, subject: p.mail.subject.slice(0, 200), receivedAt: p.mail.receivedAt, kind: p.kind, jobIds: p.entry ? [p.entry.job.id] : [], why: p.why });
    }
  }, files.inbox);
  return out;
}

/** The person's answer about an email the tool was unsure of: which application and what kind, or neither when it is not a reply. */
export function settleReview(messageId: string, answer: { jobId: string; kind: Response } | null, files: RecordFiles = {}): boolean {
  const item = mutateInbox((f) => {
    const at = f.review.findIndex((r) => r.id === messageId);
    return at < 0 ? null : (f.review.splice(at, 1)[0] ?? null);
  }, files.inbox);
  if (!item) return false;
  if (answer) recordReply(answer.jobId, { id: item.id, kind: answer.kind, receivedAt: item.receivedAt, subject: item.subject }, files);
  return true;
}

export function formatInbox(s: InboxSummary): string {
  const words: Record<Response, string> = { confirmation: "received your application", rejection: "said no", assessment: "sent an assessment", interview: "asked for an interview", offer: "made an offer" };
  const lines = s.recorded.map((r) => `  ${r.company} | ${r.title}: ${words[r.kind]}${r.settled ? " (this settles an application that was clicked and not confirmed)" : ""}`);
  return [`${s.recorded.length} repl${s.recorded.length === 1 ? "y" : "ies"} recorded, ${s.toConfirm} for you to confirm, ${s.ignored} not about your applications.`, ...lines, ...(s.toConfirm ? ["  Confirm the unsure ones in the dashboard: /report"] : [])].join("\n");
}
