/**
 * Finds the one email a job board sent to prove an inbox belongs to the person who just made or
 * used an account there. This is only for an account the person set up and allowed. It is never
 * used for a code a board sends because it suspects a robot: that check is the person's.
 *
 * An email is used only when everything about it fits the request: who sent it, that the sender
 * was verified by the mail server, who it was sent to, that it is newer than the request, and
 * that it was not used before. Exactly one must fit. Its content is data: it goes to the small
 * parser here and nowhere else, never to a model, a log or a record.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { GMAIL, PATHS } from "../config.js";
import type { VerificationFound, VerificationRequest, Verifier } from "../accounts/provider.js";
import { Secret } from "../util/redact.js";
import { withStore, writeAtomic } from "../util/store.js";

export type Mail = {
  id: string;
  /** The sender's address, lower case. */
  from: string;
  /** Every address the message was addressed and delivered to, lower case. */
  to: string[];
  subject: string;
  /** When the mailbox received it, in milliseconds. */
  receivedAt: number;
  /** What the receiving mail server recorded about the sender (Authentication-Results). */
  auth: string[];
  text: string;
  html: string;
};

export interface MailClient {
  /** Ids of the newest messages that match a search. */
  search(query: string, max: number): Promise<string[]>;
  get(id: string): Promise<Mail>;
}

const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";
const under = (domain: string, parents: string[]) => parents.some((p) => domain === p || domain.endsWith(`.${p}`));

/**
 * The results a mail server recorded, one per method: "dkim=pass header.i=@x", "dmarc=pass header.from=x".
 * Comments and quoted text are dropped first. They can echo what the sender chose (the envelope
 * address is one), and nothing inside them is a result.
 */
function results(line: string): string[] {
  let bare = line.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  for (let before = ""; before !== bare; ) {
    before = bare;
    bare = bare.replace(/\([^()]*\)/g, " ");
  }
  return bare.split(";").slice(1).map((r) => r.trim().toLowerCase());
}

/** True when the receiving server verified that the message really comes from the sender's domain. */
export function senderVerified(mail: Mail, senders: string[]): boolean {
  const from = domainOf(mail.from);
  if (!from) return false;
  const aligned = (domain: string) => !!domain && (from === domain || from.endsWith(`.${domain}`)) && under(domain, senders);
  return mail.auth.some((line) =>
    results(line).some((r) => {
      // A result counts only where it starts its own clause, and its domain only as a property of that clause.
      if (/^dmarc=pass(\s|$)/.test(r)) return aligned(/(?:^|\s)header\.from=([a-z0-9.-]+)(?=\s|$)/.exec(r)?.[1] ?? "");
      if (/^dkim=pass(\s|$)/.test(r)) return aligned(/(?:^|\s)header\.(?:i=[^@\s]*@|d=)([a-z0-9.-]+)(?=\s|$)/.exec(r)?.[1] ?? "");
      return false;
    }),
  );
}

/** Why an email is not the one a request asked for, or null when it fits. */
export function whyNot(mail: Mail, req: VerificationRequest, now: Date): string | null {
  if (!under(domainOf(mail.from), req.shape.senders)) return "it is not from the board";
  if (!senderVerified(mail, req.shape.senders)) return "its sender could not be verified";
  if (!mail.to.includes(req.recipient.toLowerCase())) return "it was sent to another address";
  if (mail.receivedAt < req.since.getTime() - GMAIL.clockSkewMs) return "it is older than the request";
  if (mail.receivedAt > now.getTime() + GMAIL.clockSkewMs) return "its date is in the future";
  if (!req.shape.subject.test(mail.subject)) return "it is not a verification email";
  return null;
}

/** Every link an email holds, from its HTML and its plain words. */
function linksIn(mail: Mail): string[] {
  const out = new Set<string>();
  for (const m of mail.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) if (m[1]) out.add(m[1].replace(/&amp;/g, "&").trim());
  for (const m of mail.text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) out.add(m[0].replace(/[.,;]+$/, ""));
  return [...out];
}

/**
 * The link or code an email carries, or the reason it carries none the tool will use. A link
 * counts only when it is HTTPS, names no user, is on an origin the account allows and has a
 * verification path. Two different such links are one too many.
 */
export function usable(mail: Mail, req: VerificationRequest): { link: string | null; code: Secret | null } | string {
  const good = new Set<string>();
  let elsewhere = false;
  for (const raw of linksIn(mail)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!req.shape.linkPath.test(u.pathname)) continue;
    if (u.protocol === "https:" && !u.username && !u.password && req.allowedOrigins.includes(u.origin)) good.add(u.href);
    else elsewhere = true;
  }
  if (good.size > 1) return "the email holds more than one verification link";
  const [link] = [...good];
  if (link) return { link, code: null };
  const code = req.shape.code?.exec(mail.text)?.[1];
  if (code) return { link: null, code: new Secret(code) };
  return elsewhere ? "the email's link does not lead to the employer's own site" : "the email holds no verification link";
}

/** The mailbox search for a request: the board's senders, the last day. Who it was sent to is checked on the message itself. */
export const queryFor = (req: VerificationRequest) => `from:(${req.shape.senders.join(" OR ")}) newer_than:1d`;

const Used = z.object({
  /** Message ids already used, with when. */
  consumed: z.record(z.string()).default({}),
  /** Requests under way, by account: when the board was asked, and when the tool stops waiting. */
  requests: z.record(z.object({ requestedAt: z.string(), expiresAt: z.string() })).default({}),
});
type Used = z.infer<typeof Used>;

export function loadUsed(file = PATHS.verifications): Used {
  if (!existsSync(file)) return Used.parse({});
  try {
    return Used.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // It records which emails were used. Starting over silently would let one be used twice.
    throw new Error(`${file} cannot be read. It records which verification emails were used, so none is read until it is fixed or removed by you.`);
  }
}

const mutateUsed = (fn: (u: Used) => void, file: string) =>
  withStore(() => {
    const u = loadUsed(file);
    fn(u);
    writeAtomic(file, JSON.stringify(u, null, 2));
  });

/** Requests for one account take turns, so two forms never race for one email. */
const turns = new Map<string, Promise<unknown>>();

export function mailVerifier(client: MailClient, opts: { file?: string; pollMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}): Verifier {
  const file = opts.file ?? PATHS.verifications;
  const waits = opts.pollMs ?? GMAIL.pollMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());

  const look = async (req: VerificationRequest): Promise<VerificationFound> => {
    const started = now();
    mutateUsed((u) => {
      u.requests[req.accountId] = { requestedAt: req.since.toISOString(), expiresAt: new Date(started.getTime() + GMAIL.requestTtlMs).toISOString() };
    }, file);
    let last = "";
    try {
      for (const wait of [0, ...waits]) {
        if (wait) await sleep(wait);
        const used = loadUsed(file).consumed;
        const fits: Mail[] = [];
        for (const id of await client.search(queryFor(req), GMAIL.maxResults)) {
          if (used[id]) continue;
          const mail = await client.get(id);
          const why = whyNot(mail, req, now());
          if (why) last = why;
          else fits.push(mail);
        }
        if (fits.length > 1) return { ok: false, why: "more than one verification email arrived and the tool will not guess between them" };
        const [mail] = fits;
        if (mail) {
          const got = usable(mail, req);
          return typeof got === "string" ? { ok: false, why: got } : { ok: true, messageId: mail.id, ...got };
        }
      }
      const seconds = Math.round(waits.reduce((a, b) => a + b, 0) / 1000);
      return { ok: false, why: last ? `no usable verification email arrived in ${seconds} seconds (one was set aside: ${last})` : `no verification email arrived in ${seconds} seconds` };
    } finally {
      mutateUsed((u) => {
        delete u.requests[req.accountId];
      }, file);
    }
  };

  return {
    find(req) {
      const before = turns.get(req.accountId) ?? Promise.resolve();
      const mine = before.then(() => look(req), () => look(req));
      turns.set(req.accountId, mine.catch(() => undefined));
      return mine;
    },
    consume(messageId) {
      mutateUsed((u) => {
        const cutoff = now().getTime() - 30 * 24 * 3_600_000;
        for (const [id, at] of Object.entries(u.consumed)) if (Date.parse(at) < cutoff) delete u.consumed[id];
        u.consumed[messageId] = now().toISOString();
      }, file);
    },
  };
}
