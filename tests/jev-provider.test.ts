import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childEnv, JEV, jevProvider } from "../src/config.js";
import { checkKey } from "../src/doctor.js";
import { JevClient } from "../src/jev/client.js";
import { choice, noul, score } from "../src/jev/questions.js";
import { scrub } from "../src/util/redact.js";

// TypeSafe's documented response (api.typesafe.ai/openapi.json, POST /v1/systemone), with the question names used here.
const typesafeBody = JSON.parse(readFileSync(new URL("./fixtures/typesafe-systemone.json", import.meta.url), "utf8")) as unknown;
const questions = { a: noul("a?"), b: choice("b?", { x: "X", y: "Y" }), c: score("c?", ["lo", "mid", "hi"]) };
const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
// Built at run time, so no key-shaped text sits in the repository. Not a real key.
const madeKey = () => `ts-test-${"q".repeat(16)}`;

const NAMES = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_PROVIDER", "OPENROUTER_SITE_URL", "OPENROUTER_SITE_NAME"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("which provider JEV is reached through", () => {
  it("is TypeSafe when its key is set, OpenRouter when only that key is, and none without a key", () => {
    expect(jevProvider()).toBeNull();
    process.env.OPENROUTER_API_KEY = "or";
    expect(jevProvider()).toBe("openrouter");
    process.env.TYPESAFE_API_KEY = "ts";
    expect(jevProvider()).toBe("typesafe");
    process.env.TYPESAFE_API_KEY = "  ";
    expect(jevProvider()).toBe("openrouter");
  });
  it("follows JEV_PROVIDER when it names one, and ignores anything else in it", () => {
    process.env.TYPESAFE_API_KEY = "ts";
    process.env.OPENROUTER_API_KEY = "or";
    process.env.JEV_PROVIDER = "openrouter";
    expect(jevProvider()).toBe("openrouter");
    process.env.JEV_PROVIDER = "typesafe";
    expect(jevProvider()).toBe("typesafe");
    process.env.JEV_PROVIDER = "somewhere-else";
    expect(jevProvider()).toBe("typesafe");
  });
});

describe("JevClient through TypeSafe", () => {
  it("posts the same body to TypeSafe's endpoint with the pinned model, and no OpenRouter headers", async () => {
    process.env.TYPESAFE_API_KEY = madeKey();
    process.env.OPENROUTER_SITE_URL = "https://example.test";
    process.env.OPENROUTER_SITE_NAME = "jev-job-search";
    const fetchImpl = vi.fn(async () => res(200, typesafeBody));
    const jev = new JevClient({ fetchImpl, usageLog: null });
    expect(jev.provider).toBe("typesafe");
    const answers = await jev.decide({ hello: "world" }, questions);
    expect(answers.b).toMatchObject({ type: "choice", choice: "x" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${madeKey()}`);
    expect(headers).not.toHaveProperty("HTTP-Referer");
    expect(headers).not.toHaveProperty("X-OpenRouter-Title");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: "jev-1.13.0", state: { hello: "world" }, questions: JSON.parse(JSON.stringify(questions)) });
  });

  it("works the cost out from input tokens at the list price, and logs it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-provider-"));
    try {
      const log = path.join(dir, "jev-usage.jsonl");
      const jev = new JevClient({ provider: "typesafe", apiKey: madeKey(), fetchImpl: async () => res(200, typesafeBody), usageLog: log });
      await jev.decide("s", questions, "rate:Acme:Intern");
      expect(jev.usage).toEqual({ calls: 1, inputTokens: 120, outputTokens: 12, costUsd: 120 * JEV.inputUsdPerToken });
      const line = JSON.parse(readFileSync(log, "utf8").trim()) as Record<string, unknown>;
      expect(line).toMatchObject({ label: "rate:Acme:Intern", model: "jev-1.13.0", provider: "typesafe", input_tokens: 120, cost: 120 * JEV.inputUsdPerToken, cost_estimated: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the spend cap, counted from the worked-out cost", async () => {
    const jev = new JevClient({ provider: "typesafe", apiKey: madeKey(), fetchImpl: async () => res(200, typesafeBody), usageLog: null, spendCapUsd: 100 * JEV.inputUsdPerToken });
    await jev.decide("s", questions);
    await expect(jev.decide("s", questions)).rejects.toThrow(/spend cap/);
  });

  it("keeps the key out of an error and out of anything printed", async () => {
    const key = madeKey();
    const jev = new JevClient({ provider: "typesafe", apiKey: key, fetchImpl: async () => res(401, `invalid key ${key}`), usageLog: null });
    const err = await jev.decide("s", questions).catch((e: unknown) => e as Error);
    expect(String(err)).not.toContain(key);
    expect(String(err)).toContain("[redacted]");
    expect(scrub(`echo ${key}`)).toBe("echo [redacted]");
  });

  it("names both keys when neither is set, and the asked-for one when JEV_PROVIDER names it", () => {
    expect(() => new JevClient({ usageLog: null })).toThrow(/TYPESAFE_API_KEY nor OPENROUTER_API_KEY/);
    process.env.JEV_PROVIDER = "typesafe";
    process.env.OPENROUTER_API_KEY = "or";
    expect(() => new JevClient({ usageLog: null })).toThrow(/TYPESAFE_API_KEY is not set, and JEV_PROVIDER asks for TypeSafe/);
  });

  it("never hands the key to a child process", () => {
    process.env.TYPESAFE_API_KEY = madeKey();
    expect(childEnv().TYPESAFE_API_KEY).toBeUndefined();
  });
});

describe("doctor's key check", () => {
  it("names the provider in use and never prints the key", () => {
    const key = madeKey();
    const c = checkKey(key, "typesafe");
    expect(c).toMatchObject({ ok: true, detail: "TypeSafe, TYPESAFE_API_KEY set in .env" });
    expect(JSON.stringify(c)).not.toContain(key);
    expect(checkKey("x", "openrouter").detail).toBe("OpenRouter, OPENROUTER_API_KEY set in .env");
    process.env.TYPESAFE_API_KEY = key;
    expect(checkKey().detail).toMatch(/^TypeSafe/);
    expect(checkKey("", null).fix).toMatch(/console\.typesafe\.ai\/keys.*openrouter\.ai\/keys.*Do not paste the key into a chat/);
  });
});
