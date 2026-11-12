import { describe, expect, it, vi } from "vitest";
import { JevClient, JevError } from "../src/jev/client.js";
import { choice, noul, score, scoreToUnit } from "../src/jev/questions.js";

const okBody = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    a: { type: "noul", noul: 0.9 },
    b: { type: "choice", choice: "x", probabilities: { x: 0.8, y: 0.2 }, confidence: 0.6 },
    c: { type: "score", score: 1.5, legend: { "0": "lo", "1": "mid", "2": "hi" }, probabilities: { "0": 0, "1": 0.5, "2": 0.5 }, confidence: 0.5 },
  },
  usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 },
};
const questions = { a: noul("a?"), b: choice("b?", { x: "X", y: "Y" }), c: score("c?", ["lo", "mid", "hi"]) };
const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("JevClient", () => {
  it("posts model, state and questions with a bearer token and validates the answers", async () => {
    const fetchImpl = vi.fn(async () => res(200, okBody));
    const jev = new JevClient({ provider: "openrouter", apiKey: "sk-or-v1-test", fetchImpl, usageLog: null });
    const answers = await jev.decide({ hello: "world" }, questions);
    expect(answers.a).toEqual({ type: "noul", noul: 0.9 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/alpha/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-v1-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state).toEqual({ hello: "world" });
    expect(Object.keys(body.questions)).toEqual(["a", "b", "c"]);
    expect(jev.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.0000042 });
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429, "slow down")).mockResolvedValueOnce(res(502, "bad")).mockResolvedValueOnce(res(200, okBody));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx and redacts keys from the error", async () => {
    const fetchImpl = vi.fn(async () => res(400, "bad key sk-or-v1-abcdef123"));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).rejects.toThrow(/sk-or-v1-\[redacted\]/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an answer whose type does not match the question", async () => {
    const bad = { ...okBody, answers: { ...okBody.answers, a: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } } };
    const jev = new JevClient({ apiKey: "k", fetchImpl: async () => res(200, bad), usageLog: null });
    await expect(jev.decide("s", questions)).rejects.toBeInstanceOf(JevError);
  });

  it("refuses to spend past the cap", async () => {
    const jev = new JevClient({ apiKey: "k", fetchImpl: async () => res(200, okBody), usageLog: null, spendCapUsd: 0.000001 });
    await jev.decide("s", questions);
    await expect(jev.decide("s", questions)).rejects.toThrow(/spend cap/);
  });

  it("requires an api key", () => {
    const names = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_PROVIDER"] as const;
    const saved = names.map((n) => process.env[n]);
    for (const n of names) delete process.env[n];
    expect(() => new JevClient({ usageLog: null })).toThrow(/OPENROUTER_API_KEY/);
    names.forEach((n, i) => { if (saved[i] !== undefined) process.env[n] = saved[i]; });
  });
});

describe("question builders", () => {
  it("normalizes a score to the unit interval", () => {
    expect(scoreToUnit(0, 5)).toBe(0);
    expect(scoreToUnit(4, 5)).toBe(1);
    expect(scoreToUnit(2, 5)).toBe(0.5);
    expect(scoreToUnit(9, 5)).toBe(1);
  });
  it("rejects a score with one level", () => {
    expect(() => score("x", ["only"])).toThrow();
  });
});
