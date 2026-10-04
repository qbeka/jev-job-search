import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { VerificationRequest } from "../src/accounts/provider.js";
import { MemoryStore } from "../src/accounts/secrets.js";
import { workday } from "../src/accounts/workday.js";
import { GMAIL } from "../src/config.js";
import { connect, disconnect, gmailClient, loadGmail, senderOf, toMail } from "../src/mail/gmail.js";
import { loadUsed, mailVerifier, queryFor, senderVerified, usable, whyNot, type Mail, type MailClient } from "../src/mail/verification.js";
import { scrub } from "../src/util/redact.js";

// Made-up addresses and tokens. No mailbox is read.
const ME = "candidate@example.com";
const ORIGIN = "https://acme.wd5.myworkdayjobs.com";
const NOW = new Date("2026-10-03T15:00:00Z");
const LINK = `${ORIGIN}/Careers/activate/abc123?redirect=%2FCareers`;
const PASSED = "mx.google.com; dkim=pass header.i=@myworkday.com header.s=s1; spf=pass smtp.mailfrom=acme@myworkday.com; dmarc=pass (p=REJECT) header.from=myworkday.com";

const req = (over: Partial<VerificationRequest> = {}): VerificationRequest => ({ accountId: "workday:acme", recipient: ME, allowedOrigins: [ORIGIN], since: new Date(NOW.getTime() - 60_000), shape: workday.mail, ...over });
const mail = (over: Partial<Mail> = {}): Mail => ({ id: "m1", from: "acme@myworkday.com", to: [ME], subject: "Verify your candidate account", receivedAt: NOW.getTime() - 20_000, auth: [PASSED], text: `Click to verify: ${LINK}`, html: `<a href="${LINK.replace(/&/g, "&amp;")}">Verify</a>`, ...over });

let file: string;
beforeEach(() => {
  file = path.join(mkdtempSync(path.join(tmpdir(), "jev-mail-")), "verifications.json");
});

describe("which email is the one that was asked for", () => {
  it("takes the board's fresh, verified email to the right address", () => {
    expect(whyNot(mail(), req(), NOW)).toBeNull();
  });

  it("refuses another sender, and a sender that only looks alike", () => {
    expect(whyNot(mail({ from: "security@evil.example" }), req(), NOW)).toMatch(/not from the board/);
    expect(whyNot(mail({ from: "acme@myworkday.com.evil.example" }), req(), NOW)).toMatch(/not from the board/);
  });

  it("refuses a sender the mail server did not verify", () => {
    expect(whyNot(mail({ auth: [] }), req(), NOW)).toMatch(/could not be verified/);
    expect(whyNot(mail({ auth: ["mx.google.com; dkim=fail header.i=@myworkday.com; dmarc=fail header.from=myworkday.com"] }), req(), NOW)).toMatch(/could not be verified/);
    // A pass for some other domain says nothing about this sender.
    expect(senderVerified(mail({ auth: ["mx.google.com; dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example"] }), workday.mail.senders)).toBe(false);
  });

  it("is not fooled by a result written where the sender controls the words", () => {
    // The envelope address is echoed in a comment and in the SPF clause. Neither is a DKIM result.
    const crafted = "mx.google.com; spf=pass (google.com: domain of a-dkim=pass-header.d=myworkday.com@evil.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=a-dkim=pass-header.d=myworkday.com@evil.example; dmarc=pass (p=NONE) header.from=evil.example";
    expect(senderVerified(mail({ auth: [crafted] }), workday.mail.senders)).toBe(false);
    expect(senderVerified(mail({ auth: ['mx.google.com; spf=pass smtp.mailfrom="x; dkim=pass header.d=myworkday.com"@evil.example'] }), workday.mail.senders)).toBe(false);
    expect(senderVerified(mail({ auth: ["mx.google.com; dkim=pass header.i=@myworkday.com.evil.example"] }), workday.mail.senders)).toBe(false);
    // The real thing, with a comment in the middle, still counts.
    expect(senderVerified(mail({ auth: ["mx.google.com; dkim=pass (2048-bit key) header.i=@myworkday.com header.s=s1"] }), workday.mail.senders)).toBe(true);
    expect(senderVerified(mail({ from: "" }), workday.mail.senders)).toBe(false);
  });

  it("takes the sender from the address itself, never from the name beside it", () => {
    expect(senderOf("Acme Careers <acme@myworkday.com>")).toBe("acme@myworkday.com");
    expect(senderOf("acme@myworkday.com")).toBe("acme@myworkday.com");
    expect(senderOf('"x <no-reply@myworkday.com>" <a@evil.example>')).toBe("a@evil.example");
    // A name that is itself an address, unquoted, leaves two: that is no sender the check will speak for.
    expect(senderOf("no-reply@myworkday.com <a@evil.example>")).toBe("");
  });

  it("refuses an email to another address, an old one, and one that is not a verification", () => {
    expect(whyNot(mail({ to: ["someone.else@example.com"] }), req(), NOW)).toMatch(/another address/);
    expect(whyNot(mail({ receivedAt: NOW.getTime() - 3 * 3_600_000 }), req(), NOW)).toMatch(/older than the request/);
    expect(whyNot(mail({ receivedAt: NOW.getTime() + 3 * 3_600_000 }), req(), NOW)).toMatch(/future/);
    expect(whyNot(mail({ subject: "New jobs for you" }), req(), NOW)).toMatch(/not a verification/);
  });

  it("asks the mailbox only for the board's senders, with no address in the search", () => {
    expect(queryFor(req())).toBe("from:(myworkday.com OR workday.com OR myworkdayjobs.com) newer_than:1d");
    expect(queryFor(req())).not.toContain(ME);
  });
});

describe("what an email's link may be", () => {
  it("uses the one link on the employer's own site", () => {
    expect(usable(mail(), req())).toEqual({ link: LINK, code: null });
  });

  it("refuses a link that leads anywhere else", () => {
    const evil = "https://evil.example/Careers/activate/abc123";
    expect(usable(mail({ text: evil, html: `<a href="${evil}">Verify</a>` }), req())).toMatch(/does not lead to the employer/);
    expect(usable(mail({ text: "", html: `<a href="http://acme.wd5.myworkdayjobs.com/Careers/activate/abc">x</a>` }), req())).toMatch(/does not lead/);
    expect(usable(mail({ text: "", html: `<a href="https://acme.wd5.myworkdayjobs.com@evil.example/activate/abc">x</a>` }), req())).toMatch(/does not lead/);
    expect(usable(mail({ text: "", html: `<a href="https://user:pw@acme.wd5.myworkdayjobs.com/Careers/activate/abc">x</a>` }), req())).toMatch(/does not lead/);
  });

  it("refuses two different links, and an email with none", () => {
    expect(usable(mail({ text: `${LINK} or ${ORIGIN}/Careers/activate/zzz999` }), req())).toMatch(/more than one/);
    expect(usable(mail({ text: "Welcome.", html: `<a href="${ORIGIN}/Careers/job/1">See the job</a>` }), req())).toMatch(/no verification link/);
  });

  it("reads a code only where the board is known to send one", () => {
    const shape = { ...workday.mail, code: /code is (\d{6})/ };
    const got = usable(mail({ text: "Your code is 482913", html: "" }), req({ shape }));
    expect(typeof got !== "string" && got.code?.reveal()).toBe("482913");
    expect(JSON.stringify(got)).not.toContain("482913");
    expect(scrub("the code 482913 was used")).not.toContain("482913");
  });
});

describe("waiting for the email", () => {
  const client = (rounds: Mail[][]): MailClient & { searches: number } => {
    const all = new Map<string, Mail>();
    const c = {
      searches: 0,
      search: async () => {
        const now = rounds[Math.min(c.searches++, rounds.length - 1)] ?? [];
        for (const m of now) all.set(m.id, m);
        return now.map((m) => m.id);
      },
      get: async (id: string) => all.get(id) as Mail,
    };
    return c;
  };
  const opts = () => ({ file, pollMs: [1, 1, 1], sleep: async () => undefined, now: () => NOW });

  it("finds it once it arrives", async () => {
    const c = client([[], [], [mail()]]);
    const found = await mailVerifier(c, opts()).find(req());
    expect(found).toMatchObject({ ok: true, messageId: "m1", link: LINK });
    expect(c.searches).toBe(3);
    expect(loadUsed(file).requests).toEqual({});
  });

  it("gives up after its polls, and says what it set aside", async () => {
    const found = await mailVerifier(client([[mail({ to: ["someone.else@example.com"] })]]), opts()).find(req());
    expect(found).toMatchObject({ ok: false });
    expect(!found.ok && found.why).toMatch(/sent to another address/);
    expect(await mailVerifier(client([[]]), opts()).find(req())).toMatchObject({ ok: false, why: expect.stringMatching(/no verification email arrived/) });
  });

  it("will not guess between two", async () => {
    const found = await mailVerifier(client([[mail(), mail({ id: "m2" })]]), opts()).find(req());
    expect(!found.ok && found.why).toMatch(/more than one/);
  });

  it("never uses one message twice", async () => {
    const v = mailVerifier(client([[mail()]]), opts());
    const first = await v.find(req());
    expect(first.ok).toBe(true);
    v.consume("m1");
    expect((await v.find(req())).ok).toBe(false);
    expect(Object.keys(loadUsed(file).consumed)).toEqual(["m1"]);
    expect(readFileSync(file, "utf8")).not.toContain("abc123");
  });

  it("takes requests for one account in turn", async () => {
    const order: string[] = [];
    const slow: MailClient = {
      search: async () => {
        order.push("search");
        await new Promise((r) => setTimeout(r, 5));
        order.push("done");
        return [];
      },
      get: async () => mail(),
    };
    const v = mailVerifier(slow, { ...opts(), pollMs: [] });
    await Promise.all([v.find(req()), v.find(req())]);
    expect(order).toEqual(["search", "done", "search", "done"]);
  });
});

describe("Gmail", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const raw = {
    id: "m9",
    internalDate: String(NOW.getTime()),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Acme Careers <acme@myworkday.com>" },
        { name: "To", value: `Candidate <${ME}>` },
        { name: "Delivered-To", value: ME },
        { name: "Subject", value: "Verify your account" },
        { name: "Authentication-Results", value: PASSED },
        { name: "Authentication-Results", value: "evil.example; dkim=pass header.i=@myworkday.com" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64(`Verify: ${LINK}`) } },
        { mimeType: "text/html", body: { data: b64(`<a href="${LINK}">Verify</a>`) } },
      ],
    },
  };

  it("reads a message into the few facts the check needs", () => {
    const m = toMail(raw);
    expect(m).toMatchObject({ id: "m9", from: "acme@myworkday.com", to: [ME], subject: "Verify your account", receivedAt: NOW.getTime() });
    // Only what Google's own server recorded counts.
    expect(m.auth).toEqual([PASSED]);
    // Its line is the top one. A line further down that carries its name came with the message.
    const forged = { ...raw, payload: { ...raw.payload, headers: [{ name: "Authentication-Results", value: "mx.google.com; dkim=fail header.i=@myworkday.com" }, ...raw.payload.headers] } };
    expect(toMail(forged).auth).toEqual(["mx.google.com; dkim=fail header.i=@myworkday.com"]);
    expect(whyNot(toMail(forged), req(), NOW)).toMatch(/could not be verified/);
    const two = { ...raw, payload: { ...raw.payload, headers: [...raw.payload.headers, { name: "From", value: "a@evil.example" }] } };
    expect(toMail(two).from).toBe("");
    expect(whyNot(m, req(), NOW)).toBeNull();
    expect(usable(m, req())).toEqual({ link: LINK, code: null });
  });

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("connects with the person's consent and keeps the tokens out of files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-gmail-"));
    const gmailFile = path.join(dir, "gmail.json");
    const clientFile = path.join(dir, "client.json");
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "1234567890-fake.apps.googleusercontent.com", client_secret: "FAKE-client-secret" } }));
    const store = new MemoryStore();
    const sent: { url: string; body: string }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url) === GMAIL.tokenUrl) return json({ access_token: "ya29.fake-access-token", expires_in: 3600, refresh_token: "1//fake-refresh-token-0123456789" });
      return json({ emailAddress: ME });
    }) as typeof fetch;
    // The person's browser: it follows Google's consent page back to the loopback address.
    const open = (link: string) => {
      const u = new URL(link);
      expect(u.origin + u.pathname).toBe(GMAIL.authUrl);
      expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      void fetch(`${u.searchParams.get("redirect_uri")}/?code=fake-auth-code&state=${u.searchParams.get("state")}`);
    };
    const email = await connect(store, { clientFile, file: gmailFile, fetcher, open, say: () => undefined });
    expect(email).toBe(ME);
    expect(store.values.get(GMAIL.refreshTokenItem)).toBe("1//fake-refresh-token-0123456789");
    expect(sent[0]?.body).toContain("code_verifier=");
    const saved = readFileSync(gmailFile, "utf8");
    expect(saved).not.toMatch(/fake-refresh|fake-access|FAKE-client-secret/);
    expect(loadGmail(gmailFile)?.email).toBe(ME);

    // Reading: a fresh access token from the stored one, then the search and the message.
    const reads: string[] = [];
    const reader = (async (url: string | URL | Request, init?: RequestInit) => {
      reads.push(String(url));
      if (String(url) === GMAIL.tokenUrl) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return json({ access_token: "ya29.fake-access-token-2", expires_in: 3600 });
      }
      return String(url).includes("/messages?") ? json({ messages: [{ id: "m9" }] }) : json(raw);
    }) as typeof fetch;
    const c = gmailClient(store, { file: gmailFile, fetcher: reader });
    expect(await c?.search(queryFor(req()), 5)).toEqual(["m9"]);
    expect((await c?.get("m9"))?.from).toBe("acme@myworkday.com");
    expect(reads.filter((u) => u === GMAIL.tokenUrl)).toHaveLength(1);

    await disconnect(store, { file: gmailFile, fetcher });
    expect(store.values.size).toBe(0);
    expect(loadGmail(gmailFile)).toBeNull();
  });

  it("connects nothing when the answer does not match the request", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-gmail-"));
    const clientFile = path.join(dir, "client.json");
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "1234567890-fake.apps.googleusercontent.com", client_secret: "FAKE-client-secret" } }));
    const store = new MemoryStore();
    const open = (link: string) => void fetch(`${new URL(link).searchParams.get("redirect_uri")}/?code=fake-auth-code&state=forged`);
    await expect(connect(store, { clientFile, file: path.join(dir, "gmail.json"), fetcher: (async () => json({})) as typeof fetch, open, say: () => undefined })).rejects.toThrow(/did not match/);
    expect(store.values.has(GMAIL.refreshTokenItem)).toBe(false);
  });

  it("says to connect again when Google has withdrawn access", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-gmail-"));
    const gmailFile = path.join(dir, "gmail.json");
    writeFileSync(gmailFile, JSON.stringify({ clientId: "1234567890-fake.apps.googleusercontent.com", email: ME, connectedAt: NOW.toISOString() }));
    const store = new MemoryStore();
    store.values.set(GMAIL.refreshTokenItem, "1//fake-refresh-token-0123456789");
    store.values.set(GMAIL.clientSecretItem, "FAKE-client-secret");
    const c = gmailClient(store, { file: gmailFile, fetcher: (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch });
    await expect(c?.search("x", 1)).rejects.toThrow(/gmail connect/);
    expect(gmailClient(new MemoryStore(), { file: path.join(dir, "none.json") })).toBeNull();
  });
});
