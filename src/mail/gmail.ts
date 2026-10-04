/**
 * The person's Gmail, read only, with their consent. The connection is Google's own sign-in for
 * installed apps: the person approves in their browser, the answer comes back to this machine on
 * a loopback address, and the long-lived token goes into the Keychain. The tool asks for one
 * permission, to read mail. It cannot send, change or delete anything.
 *
 * Tokens are Secrets from the moment they arrive. Nothing here prints a reply from Google.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { childEnv, GMAIL, PATHS } from "../config.js";
import type { SecretStore } from "../accounts/secrets.js";
import { Secret } from "../util/redact.js";
import { writeAtomic } from "../util/store.js";
import type { Mail, MailClient } from "./verification.js";
import type { BriefClient } from "./status.js";

const GmailFile = z.object({ clientId: z.string().min(10), email: z.string().email(), connectedAt: z.string() });
export type GmailFile = z.infer<typeof GmailFile>;

/** The file Google Cloud gives for a "Desktop app" OAuth client. */
const ClientFile = z.object({ installed: z.object({ client_id: z.string().min(10), client_secret: z.string().min(6) }) });
const TokenReply = z.object({ access_token: z.string().min(10), expires_in: z.number(), refresh_token: z.string().min(10).optional() });

type Fetch = typeof fetch;

export function loadGmail(file = PATHS.gmail): GmailFile | null {
  if (!existsSync(file)) return null;
  const parsed = GmailFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}

const b64url = (b: Buffer) => b.toString("base64url");

async function token(fetcher: Fetch, body: Record<string, string>): Promise<z.infer<typeof TokenReply>> {
  const res = await fetcher(GMAIL.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(GMAIL.timeoutMs) });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(json);
    if (code.success && code.data.error === "invalid_grant") throw new Error("Gmail access has expired or was withdrawn. Connect again: npx jev gmail connect");
    throw new Error(`Google refused the request (${res.status}${code.success ? ` ${code.data.error}` : ""})`);
  }
  return TokenReply.parse(json);
}

/** Opens a link in the person's own browser. */
const openLink = (url: string) => {
  if (process.platform === "darwin") spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true, env: childEnv() }).unref();
};

/**
 * Connects a Gmail mailbox. `clientFile` is the JSON Google Cloud gives for a Desktop app OAuth
 * client: its secret goes to the Keychain and the file is no longer needed. The person approves
 * in their own browser. Returns the address of the mailbox that was connected.
 */
export async function connect(store: SecretStore, opts: { clientFile?: string; file?: string; fetcher?: Fetch; open?: (url: string) => void; say?: (line: string) => void } = {}): Promise<string> {
  const file = opts.file ?? PATHS.gmail;
  const fetcher = opts.fetcher ?? fetch;
  const say = opts.say ?? ((line: string) => console.log(line));
  let clientId = loadGmail(file)?.clientId ?? "";
  if (opts.clientFile) {
    const parsed = ClientFile.safeParse(JSON.parse(readFileSync(opts.clientFile, "utf8")));
    if (!parsed.success) throw new Error("that file is not a Desktop app OAuth client from Google Cloud (it has no \"installed\" section)");
    clientId = parsed.data.installed.client_id;
    store.set(GMAIL.clientSecretItem, new Secret(parsed.data.installed.client_secret));
  }
  const clientSecret = store.get(GMAIL.clientSecretItem);
  if (!clientId || !clientSecret) throw new Error("no Google client yet. Give the file Google Cloud gave you: npx jev gmail connect --client <path to client_secret.json>. docs/ACCOUNTS.md has the steps");

  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(24));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer from Google's consent page in time. Run the command again")), GMAIL.consentWaitMs);
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirect);
        const got = u.searchParams.get("code");
        const failed = u.searchParams.get("error");
        if (!got && !failed) {
          res.writeHead(404).end();
          return;
        }
        const ok = !!got && u.searchParams.get("state") === state;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(ok ? "Gmail is connected. You can close this tab." : "Gmail was not connected. You can close this tab.");
        clearTimeout(timer);
        if (ok) resolve(got);
        else reject(new Error(failed === "access_denied" ? "you declined on Google's consent page, so nothing was connected" : "Google's answer did not match this request, so nothing was connected"));
      });
      const ask = new URL(GMAIL.authUrl);
      ask.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: GMAIL.scope,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
      }).toString();
      say("Your browser is opening Google's consent page. Approve read-only access to Gmail there.");
      (opts.open ?? openLink)(ask.href);
    });
    const reply = await token(fetcher, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret.reveal(), redirect_uri: redirect });
    if (!reply.refresh_token) throw new Error("Google gave no long-lived token. Remove the tool's access at myaccount.google.com/permissions and connect again");
    const access = new Secret(reply.access_token);
    store.set(GMAIL.refreshTokenItem, new Secret(reply.refresh_token));
    const who = await fetcher(`${GMAIL.apiUrl}/profile`, { headers: { authorization: `Bearer ${access.reveal()}` }, signal: AbortSignal.timeout(GMAIL.timeoutMs) });
    if (!who.ok) throw new Error(`Gmail did not answer (${who.status}). Is the Gmail API enabled for your Google Cloud project?`);
    const email = z.object({ emailAddress: z.string().email() }).parse(await who.json()).emailAddress.toLowerCase();
    writeAtomic(file, JSON.stringify({ clientId, email, connectedAt: new Date().toISOString() } satisfies GmailFile, null, 2) + "\n");
    return email;
  } finally {
    server.close();
  }
}

/** Withdraws the tool's access at Google and forgets the tokens. */
export async function disconnect(store: SecretStore, opts: { file?: string; fetcher?: Fetch } = {}): Promise<void> {
  const refresh = store.get(GMAIL.refreshTokenItem);
  if (refresh) {
    await (opts.fetcher ?? fetch)(GMAIL.revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh.reveal() }).toString(), signal: AbortSignal.timeout(GMAIL.timeoutMs) }).catch(() => undefined);
  }
  store.delete(GMAIL.refreshTokenItem);
  store.delete(GMAIL.clientSecretItem);
  rmSync(opts.file ?? PATHS.gmail, { force: true });
}

const Part: z.ZodType<{ mimeType?: string | undefined; body?: { data?: string | undefined } | undefined; parts?: unknown[] | undefined; headers?: { name: string; value: string }[] | undefined }> = z.object({
  mimeType: z.string().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(z.unknown()).optional(),
});
const Message = z.object({ id: z.string(), internalDate: z.string(), payload: Part });

const addresses = (value: string): string[] => [...value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());

/**
 * The one address a From header names. A display name may hold anything, another address included,
 * so quoted text is dropped first, and a header that still names more than one address names none.
 */
export function senderOf(from: string): string {
  const bare = from.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  const found = addresses(bare);
  return found.length === 1 ? (found[0] as string) : "";
}

/** Turns Gmail's message into the few facts the verification needs. */
export function toMail(raw: unknown): Mail {
  const m = Message.parse(raw);
  const headers = m.payload.headers ?? [];
  const all = (name: string) => headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value);
  let text = "";
  let html = "";
  const walk = (part: z.infer<typeof Part>, depth: number) => {
    const data = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
    if (part.mimeType === "text/plain") text += data;
    else if (part.mimeType === "text/html") html += data;
    if (depth < 6) for (const p of part.parts ?? []) walk(Part.parse(p), depth + 1);
  };
  walk(m.payload, 0);
  return {
    id: m.id,
    // A message with two From headers is not one the check can speak for.
    from: all("from").length === 1 ? senderOf(all("from")[0] as string) : "",
    to: [...new Set([...all("to"), ...all("delivered-to")].flatMap(addresses))],
    subject: all("subject")[0] ?? "",
    receivedAt: Number(m.internalDate),
    // Only what Google's own server recorded counts, and it writes its line above every other: a line
    // further down, whatever name it carries, came with the message and proves nothing.
    auth: all("authentication-results").slice(0, 1).filter((v) => /^\s*mx\.google\.com\s*;/i.test(v)),
    text,
    html,
  };
}

/** A read-only Gmail client for the connected mailbox, or null when none is connected. */
export function gmailClient(store: SecretStore, opts: { file?: string; fetcher?: Fetch } = {}): (MailClient & BriefClient) | null {
  const gmail = loadGmail(opts.file ?? PATHS.gmail);
  const fetcher = opts.fetcher ?? fetch;
  if (!gmail) return null;
  let access: { token: Secret; until: number } | null = null;
  const bearer = async (): Promise<string> => {
    if (!access || Date.now() > access.until) {
      const refresh = store.get(GMAIL.refreshTokenItem);
      const secret = store.get(GMAIL.clientSecretItem);
      if (!refresh || !secret) throw new Error("Gmail is not connected on this machine. Connect it: npx jev gmail connect");
      const reply = await token(fetcher, { grant_type: "refresh_token", refresh_token: refresh.reveal(), client_id: gmail.clientId, client_secret: secret.reveal() });
      access = { token: new Secret(reply.access_token), until: Date.now() + (reply.expires_in - 60) * 1000 };
    }
    return `Bearer ${access.token.reveal()}`;
  };
  const get = async (path: string): Promise<unknown> => {
    const res = await fetcher(`${GMAIL.apiUrl}${path}`, { headers: { authorization: await bearer() }, signal: AbortSignal.timeout(GMAIL.timeoutMs) });
    if (!res.ok) throw new Error(`Gmail did not answer (${res.status})`);
    return res.json();
  };
  return {
    async brief(id) {
      const m = z.object({ id: z.string(), internalDate: z.string(), snippet: z.string().default(""), payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }) }).parse(await get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`));
      const header = (name: string) => m.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      const from = header("from");
      return { id: m.id, from: senderOf(from), fromName: from.replace(/<[^>]*>/g, " ").replace(/"/g, "").trim(), subject: header("subject"), snippet: m.snippet, receivedAt: Number(m.internalDate) };
    },
    async search(query, max) {
      const list = z.object({ messages: z.array(z.object({ id: z.string() })).optional() }).parse(await get(`/messages?maxResults=${max}&q=${encodeURIComponent(query)}`));
      return (list.messages ?? []).map((m) => m.id);
    },
    async get(id) {
      return toMail(await get(`/messages/${encodeURIComponent(id)}?format=full`));
    },
  };
}
