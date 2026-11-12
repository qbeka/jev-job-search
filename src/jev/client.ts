/**
 * HTTP client for JEV, through TypeSafe's own API or OpenRouter's Decisions API (`jevProvider()`).
 *
 * One call = one state + many typed questions. Answers come back under the
 * same keys. The client validates the response, retries transient failures,
 * tracks spend, and refuses to exceed a per-run spend cap.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { JEV, jevProvider, PATHS, type JevProvider } from "../config.js";
import { registerSecret } from "../util/redact.js";
import { DecisionResponse, type Answer, type Questions, type State, type Usage } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type JevClientOptions = {
  /** Defaults to `jevProvider()`, and to OpenRouter when a key is given and .env names no provider. */
  provider?: JevProvider;
  apiKey?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
  model?: string;
  spendCapUsd?: number;
  /** When set, every call's usage is appended as JSON lines here. */
  usageLog?: string | null;
  siteUrl?: string;
  siteName?: string;
};

export class JevError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  readonly provider: JevProvider;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly spendCapUsd: number;
  private readonly usageLog: string | null;
  private readonly siteUrl: string | undefined;
  private readonly siteName: string | undefined;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  constructor(opts: JevClientOptions = {}) {
    const chosen = opts.provider ?? jevProvider();
    this.provider = chosen ?? "openrouter";
    const p = JEV.providers[this.provider];
    const key = opts.apiKey ?? process.env[p.keyEnv]?.trim();
    if (!key) {
      throw new JevError(chosen
        ? `${p.keyEnv} is not set, and JEV_PROVIDER asks for ${p.name}. Add the key to .env or change JEV_PROVIDER.`
        : `Neither ${JEV.providers.typesafe.keyEnv} nor ${JEV.providers.openrouter.keyEnv} is set. Copy .env.example to .env and add one key.`);
    }
    this.apiKey = key;
    // A TypeSafe key has no fixed shape for the patterns in scrub to catch, so the value itself is kept out of every log.
    registerSecret(key);
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = opts.endpoint ?? p.endpoint;
    this.model = opts.model ?? p.model;
    this.spendCapUsd = opts.spendCapUsd ?? JEV.runSpendCapUsd;
    this.usageLog = opts.usageLog === undefined ? PATHS.jevUsage : opts.usageLog;
    this.siteUrl = opts.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.siteName = opts.siteName ?? process.env.OPENROUTER_SITE_NAME;
  }

  /** Asks every question against one state. Throws JevError on a non-recoverable failure. */
  async decide(state: State, questions: Questions, label = "decide"): Promise<Record<string, Answer>> {
    if (Object.keys(questions).length === 0) return {};
    if (this.usage.costUsd >= this.spendCapUsd) {
      throw new JevError(`JEV spend cap of $${this.spendCapUsd} reached for this run`);
    }
    const body = JSON.stringify({ model: this.model, state, questions });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.provider === "openrouter" && this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
    if (this.provider === "openrouter" && this.siteName) headers["X-OpenRouter-Title"] = this.siteName;

    let lastError: JevError | undefined;
    for (let attempt = 0; attempt <= JEV.maxRetries; attempt++) {
      if (attempt > 0) await sleep(JEV.retryBaseMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JEV.timeoutMs);
      try {
        const res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body, signal: controller.signal });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastError = new JevError(`JEV ${res.status} on ${label}`, res.status, this.redact(text));
          continue;
        }
        if (!res.ok) throw new JevError(`JEV ${res.status} on ${label}: ${this.redact(text)}`, res.status, this.redact(text));
        const parsed = DecisionResponse.safeParse(JSON.parse(text));
        if (!parsed.success) throw new JevError(`JEV returned an unexpected shape on ${label}: ${parsed.error.message}`);
        this.record(parsed.data, label);
        this.assertAllAnswered(questions, parsed.data.answers, label);
        return parsed.data.answers;
      } catch (err) {
        if (err instanceof JevError) {
          if (err.status === undefined || (err.status !== 429 && err.status < 500)) throw err;
          lastError = err;
          continue;
        }
        const name = (err as { name?: string }).name;
        lastError = new JevError(`${name === "AbortError" ? "JEV timeout" : "JEV network error"} on ${label}: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new JevError(`JEV failed on ${label}`);
  }

  private record(res: DecisionResponse, label: string): void {
    const u = res.usage ?? {};
    // TypeSafe reports tokens and no cost, so the cost is worked out at the list price. Logged
    // either way, since the daily spend limit is read from the usage log.
    const cost = u.cost ?? (u.input_tokens ?? 0) * JEV.inputUsdPerToken;
    this.usage.calls += 1;
    this.usage.inputTokens += u.input_tokens ?? 0;
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.costUsd += cost;
    if (!this.usageLog) return;
    try {
      mkdirSync(path.dirname(this.usageLog), { recursive: true });
      appendFileSync(
        this.usageLog,
        JSON.stringify({ at: new Date().toISOString(), label, id: res.id, model: res.model, provider: this.provider, ...u, cost, ...(u.cost === undefined ? { cost_estimated: true } : {}) }) + "\n",
      );
    } catch {
      /* usage logging is best effort */
    }
  }

  /** Strips the key in use, and anything that looks like an OpenRouter key, from an error body before it is surfaced. */
  private redact(text: string): string {
    // A value under six characters is not a real key, and replacing it would blank out ordinary words (as registerSecret).
    const own = this.apiKey.length >= 6 ? text.split(this.apiKey).join("[redacted]") : text;
    return own.replace(/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1-[redacted]").slice(0, 500);
  }

  private assertAllAnswered(questions: Questions, answers: Record<string, Answer>, label: string): void {
    const missing = Object.keys(questions).filter((k) => !(k in answers));
    if (missing.length) throw new JevError(`JEV left questions unanswered on ${label}: ${missing.join(", ")}`);
    for (const [key, q] of Object.entries(questions)) {
      const a = answers[key];
      if (a && a.type !== q.type) throw new JevError(`JEV answered ${key} as ${a.type}, expected ${q.type}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


