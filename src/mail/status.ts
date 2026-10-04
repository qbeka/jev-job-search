/**
 * What came back by email. With the person's Gmail connected, read-only, this looks for replies
 * to applications they sent: a confirmation, a rejection, an assessment, an interview request, an
 * offer. Rules decide first, from the sender, the subject and the short preview Gmail itself
 * shows. An email the rules cannot place goes to JEV as one typed question, with the subject and
 * that preview only. Whatever is still unsure is held for the person to confirm, never guessed.
 *
 * An email's words are data. They are matched and shown, never followed, and the body is not read.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { INBOX, PATHS } from "../config.js";
import type { JevClient } from "../jev/client.js";
import { choice } from "../jev/questions.js";
import type { ChoiceAnswer } from "../jev/types.js";
import { Response, type QueueEntry } from "../jobs/queue.js";
import { withStore, writeAtomic } from "../util/store.js";

/** The few facts of an email this needs: who sent it, its subject, Gmail's own short preview, and when. */
export type MailBrief = { id: string; from: string; fromName: string; subject: string; snippet: string; receivedAt: number };

export interface BriefClient {
  search(query: string, max: number): Promise<string[]>;
  brief(id: string): Promise<MailBrief>;
}

const RULES: [Response, RegExp][] = [
  // Each of these says no in so many words. "We have decided to proceed" and "we are reviewing other candidates" do not.
  ["rejection", /unfortunately|regret to inform|\bnot (?:be )?(?:moving|proceeding|going) forward|decided (?:not to|to not|against) (?:mov|proceed|continu|go|pursu)|(?:move|moving|proceed|proceeding|go|going) (?:forward|ahead) with (?:an)?other (?:candidate|applicant)s?|pursu(?:e|ing) other (?:candidate|applicant)s|\b(?:not|n['’]t) (?:been )?selected\b|will not be (?:moving|proceeding|continuing)|no longer (?:under consideration|being considered)|position has been filled|unable to offer/i],
  ["offer", /(pleased|delighted|excited|happy) to (offer|extend)|offer letter|your offer\b|offer of employment/i],
  ["interview", /(schedule|book|set up|arrange)\b[^.]{0,40}\b(interview|call|chat|conversation)|invit(e|ed|ation)\b[^.]{0,40}\binterview|interview (invitation|request|availability)|your availability|phone screen|would like to (speak|talk|meet) with you/i],
  ["assessment", /assessment|coding (challenge|test|exercise)|online (test|assessment)|hackerrank|codesignal|codility|take[- ]home|technical (test|exercise|challenge)/i],
  ["confirmation", /thank(s| you) for (applying|your (application|interest))|application (has been |was |is )?(received|submitted)|(received|got) your application|we('ve| have) received|successfully (applied|submitted)|application confirmation/i],
];

/** The kind of reply the words point to. Null when no rule fits, "unclear" when two kinds do. */
export function kindByRules(subject: string, snippet: string): Response | "unclear" | null {
  const words = `${subject} ${snippet}`;
  const hits = RULES.filter(([, re]) => re.test(words)).map(([k]) => k);
  if (!hits.length) return null;
  // Nearly every reply thanks the person for applying. That alone is a confirmation, and beside anything else it is manners.
  const real = hits.filter((k) => k !== "confirmation");
  if (!real.length) return "confirmation";
  return real.length === 1 ? (real[0] as Response) : "unclear";
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|gmbh|ulc|plc|technologies|technology|labs|group|holdings)\b/g;
/** A company's name as it would be recognised in an email: lower case, without the legal ending. */
export const companyKey = (name: string) => norm(name).replace(SUFFIX, " ").replace(/\s+/g, " ").trim();

/**
 * The applications an email could be about: those whose company is named by the sender's name,
 * the sender's own domain, or the subject, and that were sent before the email came. A company
 * whose name is one short common word is matched only as a whole word.
 */
export function candidatesFor(mail: MailBrief, applied: QueueEntry[]): QueueEntry[] {
  const said = ` ${norm(`${mail.fromName} ${mail.subject} ${mail.snippet}`)} `;
  const domain = mail.from.split("@")[1]?.split(".").slice(-2, -1)[0] ?? "";
  return applied.filter((e) => {
    const key = companyKey(e.job.company);
    if (key.length < INBOX.minCompanyChars) return false;
    const sent = e.appliedAt ?? e.updatedAt;
    if (Date.parse(sent) - INBOX.clockSkewMs > mail.receivedAt) return false;
    return said.includes(` ${key} `) || (domain.length >= INBOX.minCompanyChars && key.replace(/ /g, "") === domain);
  });
}

/** One application among several at the same company: the one whose title the email names. */
function byTitle(mail: MailBrief, entries: QueueEntry[]): QueueEntry | null {
  const said = norm(`${mail.subject} ${mail.snippet}`);
  const named = entries.filter((e) => said.includes(norm(e.job.title)));
  return named.length === 1 ? (named[0] as QueueEntry) : null;
}

export type Placed = { mail: MailBrief; kind: Response | null; entry: QueueEntry | null; sure: boolean; why: string };

const Seen = z.object({
  /** Emails already looked at, so each is read once. */
  seen: z.record(z.string()).default({}),
  /** Emails the tool could not place with certainty, for the person to confirm. */
  review: z.array(z.object({ id: z.string(), from: z.string(), subject: z.string(), receivedAt: z.number(), kind: Response.nullable(), jobIds: z.array(z.string()), why: z.string() })).default([]),
});
export type InboxFile = z.infer<typeof Seen>;

export function loadInbox(file = PATHS.inbox): InboxFile {
  if (!existsSync(file)) return Seen.parse({});
  try {
    return Seen.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return Seen.parse({});
  }
}
export const mutateInbox = <T>(fn: (f: InboxFile) => T, file = PATHS.inbox): T =>
  withStore(() => {
    const f = loadInbox(file);
    const out = fn(f);
    writeAtomic(file, JSON.stringify(f, null, 2));
    return out;
  });

/** The mailbox search: mail from the last days that speaks of an application. Nothing about the person is in it. */
export const inboxQuery = (days: number) => `newer_than:${days}d -category:promotions -category:social (application OR applying OR applied OR interview OR assessment OR candidate OR "your interest" OR offer)`;

/**
 * Reads the mailbox for replies and places each one. `jev` is asked only about an email the rules
 * could not name, and only with its subject and Gmail's preview.
 */
export async function readInbox(client: BriefClient, jev: JevClient | null, entries: QueueEntry[], o: { days?: number; file?: string } = {}): Promise<Placed[]> {
  const applied = entries.filter((e) => e.status === "applied" || e.status === "submission_unknown");
  const before = loadInbox(o.file).seen;
  const out: Placed[] = [];
  for (const id of await client.search(inboxQuery(o.days ?? INBOX.days), INBOX.maxMessages)) {
    if (before[id]) continue;
    const mail = await client.brief(id);
    const candidates = candidatesFor(mail, applied);
    // An email that names no company the person applied to is not about an application of theirs.
    if (!candidates.length) {
      out.push({ mail, kind: null, entry: null, sure: true, why: "it names no company you applied to" });
      continue;
    }
    let kind = kindByRules(mail.subject, mail.snippet);
    let sure = kind !== null && kind !== "unclear";
    if (!sure && jev) {
      const a = (await jev.decide(
        { subject: mail.subject.slice(0, INBOX.subjectChars), preview: mail.snippet.slice(0, INBOX.snippetChars) },
        {
          kind: choice("What is this email from an employer about a job application?", {
            confirmation: "It only confirms that the application was received",
            rejection: "It says the candidate will not move forward",
            assessment: "It asks the candidate to take a test, an assessment or a take-home exercise",
            interview: "It asks to schedule an interview, a call or a conversation",
            offer: "It makes a job offer",
            other: "None of these: a newsletter, a job alert, an account notice, or anything else",
          }),
        },
        "inbox",
      )).kind as ChoiceAnswer;
      kind = a.choice === "other" ? null : (a.choice as Response);
      sure = a.confidence >= INBOX.jevConfidence;
      if (a.choice === "other" && sure) {
        out.push({ mail, kind: null, entry: null, sure: true, why: "it is not a reply to an application" });
        continue;
      }
    }
    const entry = candidates.length === 1 ? (candidates[0] as QueueEntry) : byTitle(mail, candidates);
    const named: Response | null = kind === "unclear" ? null : kind;
    out.push({ mail, kind: named, entry, sure: sure && !!entry && named !== null, why: !entry ? `you applied to ${candidates.length} jobs at that company and the email names none` : !sure ? "the tool could not tell what it says" : "" });
  }
  return out;
}

export type ReplyEvent = { id: string; kind: Response; at: number; subject: string };

/**
 * Where an application stands, from every reply it got: the latest one counts, by the time the
 * mailbox received it and not by the order the tool read them in. So an old rejection read late
 * does not undo a newer interview, and a rejection after an offer does replace it. One exception:
 * a note that the application was received says nothing new once the employer has said more, so
 * it counts only when it is all there is.
 */
export function outcomeOf(replies: ReplyEvent[]): ReplyEvent | null {
  const inOrder = [...replies].sort((a, b) => a.at - b.at);
  const said = inOrder.filter((r) => r.kind !== "confirmation");
  return said.at(-1) ?? inOrder.at(-1) ?? null;
}

export const dayOfMail = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
