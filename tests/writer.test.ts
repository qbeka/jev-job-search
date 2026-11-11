import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writerBackend, writerModel, writerName } from "../src/config.js";
import { apiCostUsd, codexArgs, codexPrompt } from "../src/answers/resolve.js";

describe("how Claude is reached", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, backend: process.env.WRITER_BACKEND };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.backend === undefined) delete process.env.WRITER_BACKEND;
    else process.env.WRITER_BACKEND = saved.backend;
  });
  it("is Claude Code unless a Claude API key is given", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WRITER_BACKEND;
    expect(writerBackend()).toBe("claude-code");
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    expect(writerBackend()).toBe("api");
  });
  it("can be pinned to Claude Code even with a key", () => {
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    process.env.WRITER_BACKEND = "claude-code";
    expect(writerBackend()).toBe("claude-code");
  });
  it("prices an API call from its token counts", () => {
    expect(apiCostUsd({ input_tokens: 1_000_000 })).toBeCloseTo(3, 5);
    expect(apiCostUsd({ cache_read_input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(0.3 + 1.5, 5);
    expect(apiCostUsd({})).toBe(0);
  });
});

describe("the Claude API call", () => {
  it("sends the system prompt cached, reads the text back, and records the usage", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "{\"verdict\":\"ready\"}" }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake as typeof fetch;
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    process.env.WRITER_BACKEND = "api";
    try {
      const { askWriter, writerUsage } = await import("../src/answers/resolve.js");
      const before = writerUsage.calls;
      const text = await askWriter("hello", "Reply as JSON.");
      expect(text).toBe("{\"verdict\":\"ready\"}");
      expect(seen).toHaveLength(1);
      const headers = seen[0]?.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(process.env.ANTHROPIC_API_KEY);
      expect(headers["anthropic-version"]).toBeTruthy();
      const body = JSON.parse(String(seen[0]?.init.body)) as { system: { text: string; cache_control?: { type: string } }[]; messages: { role: string; content: string }[]; max_tokens: number };
      expect(body.system[0]?.text).toBe("Reply as JSON.");
      expect(body.system[0]?.cache_control?.type).toBe("ephemeral");
      expect(body.messages[0]).toEqual({ role: "user", content: "hello" });
      expect(writerUsage.calls).toBe(before + 1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.WRITER_BACKEND;
    }
  });
  it("explains a refusal without the key", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })) as typeof fetch;
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    process.env.WRITER_BACKEND = "api";
    try {
      const { askWriter } = await import("../src/answers/resolve.js");
      await expect(askWriter("hello", "x")).rejects.toThrow(/401: invalid x-api-key/);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.WRITER_BACKEND;
    }
  });
});

describe("another writer, when the person names one", () => {
  const names = ["WRITER_BACKEND", "WRITER_MODEL", "WRITER_BASE_URL", "WRITER_API_KEY", "ANTHROPIC_API_KEY", "PATH"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it("takes a backend it knows and refuses a name it does not, instead of guessing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.WRITER_BACKEND = "codex";
    expect(writerBackend()).toBe("codex");
    expect(writerName().billed).toBe(false);
    process.env.WRITER_BACKEND = "OpenAI";
    expect(writerBackend()).toBe("openai");
    process.env.WRITER_BACKEND = "gpt";
    expect(() => writerBackend()).toThrow(/WRITER_BACKEND/);
  });

  it("has no model of its own for another service, and leaves Codex on the model it is set to", () => {
    delete process.env.WRITER_MODEL;
    expect(() => writerModel("openai")).toThrow(/WRITER_MODEL/);
    expect(writerModel("codex")).toBe("");
    expect(writerModel("claude-code")).toMatch(/^claude-/);
    process.env.WRITER_MODEL = "some-model";
    expect(writerModel("openai")).toBe("some-model");
    expect(writerModel("claude-code")).toBe("some-model");
  });

  it("starts Codex with everything that could act turned off", () => {
    const args = codexArgs("low", "");
    expect(args.slice(0, 2)).toEqual(["exec", "-"]);
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).not.toContain("--model");
    expect(codexArgs("high", "m1").slice(-2)).toEqual(["--model", "m1"]);
    expect(codexPrompt("FORM", "RULES").indexOf("RULES")).toBeLessThan(codexPrompt("FORM", "RULES").indexOf("FORM"));
  });

  it.skipIf(process.platform === "win32")("runs Codex headless: the prompt on standard input, no key in its environment, the answer read from what it prints", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-codex-"));
    const seen = path.join(dir, "seen.txt");
    // A stand-in for the codex command: it writes down what it was given and answers like the real one, with its last message.
    writeFileSync(path.join(dir, "codex"), `#!/bin/sh\n{ echo "ARGS $*"; echo "KEY [$WRITER_API_KEY$ANTHROPIC_API_KEY$OPENROUTER_API_KEY]"; cat; } > "${seen}"\nprintf '{"verdict":"ready"}\\n'\n`);
    chmodSync(path.join(dir, "codex"), 0o755);
    process.env.PATH = `${dir}${path.delimiter}${saved.PATH ?? ""}`;
    process.env.WRITER_BACKEND = "codex";
    process.env.WRITER_API_KEY = "not-for-a-child";
    process.env.ANTHROPIC_API_KEY = "not-for-a-child";
    const { askWriter, writerUsage } = await import("../src/answers/resolve.js");
    const before = writerUsage.calls;
    expect(await askWriter("the form", "the rules")).toBe('{"verdict":"ready"}');
    const text = readFileSync(seen, "utf8");
    expect(text).toMatch(/^ARGS exec - /);
    expect(text).toContain("KEY []");
    expect(text).toContain("the rules");
    expect(text).toContain("the form");
    expect(writerUsage.calls).toBe(before + 1);
  });

  it("calls a service that speaks chat completions with the key as a bearer token and no tools", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"verdict\":\"ready\"}" } }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 } }), { status: 200 });
    }) as typeof fetch;
    process.env.WRITER_BACKEND = "openai";
    process.env.WRITER_MODEL = "some-model";
    process.env.WRITER_BASE_URL = "https://example.test/v1/";
    process.env.WRITER_API_KEY = ["wk", "test"].join("-");
    try {
      const { askWriter, writerUsage } = await import("../src/answers/resolve.js");
      const before = { ...writerUsage };
      expect(await askWriter("hello", "Reply as JSON.")).toBe("{\"verdict\":\"ready\"}");
      expect(seen[0]?.url).toBe("https://example.test/v1/chat/completions");
      expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${process.env.WRITER_API_KEY}`);
      const body = JSON.parse(String(seen[0]?.init.body)) as { model: string; messages: { role: string; content: string }[]; tools?: unknown };
      expect(body.model).toBe("some-model");
      expect(body.messages).toEqual([{ role: "system", content: "Reply as JSON." }, { role: "user", content: "hello" }]);
      expect(body.tools).toBeUndefined();
      expect(writerUsage.calls).toBe(before.calls + 1);
      expect(writerUsage.costUsd).toBeCloseTo(before.costUsd + 0.0004, 6);
      // A model on this machine has no key, and none is sent.
      delete process.env.WRITER_API_KEY;
      await askWriter("hello", "x");
      expect((seen[1]?.init.headers as Record<string, string>).authorization).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("explains a refusal from that service without the key", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 })) as typeof fetch;
    process.env.WRITER_BACKEND = "openai";
    process.env.WRITER_MODEL = "some-model";
    process.env.WRITER_API_KEY = ["wk", "test"].join("-");
    try {
      const { askWriter } = await import("../src/answers/resolve.js");
      const err = await askWriter("hello", "x").then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/404: model not found/);
      expect(err?.message).not.toContain("wk-test");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
