/**
 * What JEV leaves open goes to the writer: questions that need writing, fields it
 * was unsure of, and values the page refused. By default that is Claude Code, run
 * headless with no tools; `writerBackend` in the config names the others. The writer
 * reads the candidate's facts and the open fields, and returns one JSON object. It
 * may also say the job should not be applied to, with a reason.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { childEnv, DOCUMENTS, PATHS, WRITER, writerApi, writerBackend, writerModel } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import { BANK_DRAFTS, BANK_INTENTS } from "./bank.js";
import { answerContext, jobContext } from "./context.js";
import { fingerprintOf, Resolution, type OpenField } from "./memory.js";
import { registerSecret } from "../util/redact.js";

export { Resolution, type OpenField };

const SYSTEM = [
  "You finish job application forms for one candidate. You are given the candidate's facts, the job, what is already filled in, and the fields still open.",
  "Reply with one JSON object and nothing else: {\"verdict\": \"ready\" | \"needs_review\" | \"skip\", \"reason\": string, \"answers\": [{\"selector\": string, \"value\": string, \"reusable\": boolean}], \"note\": {\"what_they_do\": string, \"why_fit\": string}}.",
  "",
  "Truth comes first.",
  "- Use only the candidate's facts, experience, projects, standing answers and the job posting. Never invent a fact, a number, a skill level, a date or a credential.",
  "- Work authorization, citizenship, education and dates are exactly as given. The candidate is authorized without sponsorship only in authorizedCountries. In authorizedWithSponsorshipLater, if any, they may work now but will need sponsorship in the future. They need sponsorship everywhere else.",
  "- If a required field cannot be answered truthfully from the facts (a residence the candidate does not have, a self-rating of a skill the facts do not mention, a quiz or take-home, a clearance, a reference's contact details), do not guess: set verdict to \"needs_review\" and say which field in reason.",
  "- needs_review is only for that. When the facts or a standing answer reasonably settle a field, answer it and keep the verdict \"ready\". A person who is not employed has no notice period, so the shortest option is true.",
  "- Never sign for the candidate. A field that asks them to type their name to agree to an NDA or any other contract, and any NDA, is left unanswered and the verdict is \"needs_review\". A checkbox that acknowledges an agreement, a notice or terms follows the standing answers.",
  "- Never choose a date, a time slot or a venue for an interview, an assessment or an event on the candidate's behalf. That field is left unanswered and the verdict is \"needs_review\".",
  "- If the form requires a cover letter or references, set verdict to \"skip\" with the reason.",
  "- Whether to apply is the candidate's decision, already made. A posting that prefers another graduation date, location or visa status is not a reason to stop: answer every question truthfully, follow the standing answers, and note the mismatch in reason while keeping the verdict \"ready\".",
  "",
  "How to answer each kind of field.",
  "- select, radio, combobox with options: value is one option copied exactly. With no options listed for a combobox, value is the text to search for.",
  "- calendar: one date as YYYY-MM-DD, taken from the facts. When the facts give only a month, use its first day.",
  "- checkbox: \"true\" or \"false\". Consent that is needed to submit the application is \"true\". Optional marketing, job alerts, text messages and keeping data for future roles are \"false\".",
  "- text and textarea: write in the candidate's voice, following the voice rules exactly, inside maxLength. Match the length to the question: one line for a one-line box, 60 to 140 words for an open question unless it asks for more or less.",
  "- A checkbox or radio option comes with its question. Decide the whole group together from the question: tick the options that are true for the candidate, and for a yes/no pair tick exactly one.",
  "- A group of checkboxes where none applies: tick \"None of the above\" only if the facts settle every item in the group, otherwise tick \"I prefer not to answer\" when that exists.",
  "- Salary: use the standing wording unless a number is forced, which is needs_review.",
  "- Answer what is asked and no more. Sponsorship, visa status, GPA and anything else that counts against the candidate are stated truthfully wherever a field asks for them, and are not volunteered in free text that did not ask.",
  "- An optional field gets a value whenever the facts give a true one. Leave it out of answers only when nothing true applies to it.",
  "- A field listed with a reason like \"the page did not keep the value\" needs the value in the format the field wants (for a date box, a real date such as 2027-05-03 or 05/03/2027 as the hint or placeholder shows).",
  "",
  "Answer every open field you can, even when the verdict is needs_review, so a person only has to finish what is left.",
  "",
  "Two things that are not part of the form.",
  "- reusable, on each answer: true only when this exact value is the right answer to the same question on any other company's application form. It is false whenever the question or the value names or depends on this company, this role, its team, its product, its office or location, its pay or its dates, and false when you are not sure.",
  "- note is for the candidate's own tracking sheet. what_they_do: one plain sentence on what the company builds, from the posting, or empty if the posting does not say. why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\". Under 30 words each, no em dashes, no hype words. Leave note out when no job is given.",
].join("\n");

/** Everything about the candidate that is the same for every job: the voice guide, the facts and the starting drafts. */
export function candidateContext(profile: Profile): Record<string, unknown> {
  const ctx = answerContext(profile, null, "");
  return {
    voice_rules: ctx.voice,
    candidate: {
      ...ctx.candidate,
      email: profile.email,
      phone: `${profile.phone.countryCode} ${profile.phone.national}`,
      education: profile.education,
      address: `${profile.address.city}, ${profile.address.region}, ${profile.address.country}`,
      spokenLanguages: profile.spokenLanguages,
      demographics: profile.demographics,
      preferences: profile.preferences,
      workAuthorization: profile.workAuthorization,
    },
    /** Starting drafts for common questions. Adapt one to the question and the company; text in braces is for you to write. */
    bank: Object.fromEntries(Object.keys(BANK_INTENTS).map((k) => [k, { asks: BANK_INTENTS[k], draft: BANK_DRAFTS[k] }])),
  };
}

/**
 * The system prompt: the rules, then the candidate. It is identical for every job in a run, so the
 * model provider can cache it and each further form pays full price only for its own posting and fields.
 */
export function buildSystem(profile: Profile): string {
  return `${SYSTEM}\n\nThe candidate, the same for every form:\n${JSON.stringify(candidateContext(profile), null, 1)}`;
}

/** Changes whenever anything the writer is told about the candidate changes. Remembered answers are tied to it. */
export const contextFingerprint = (profile: Profile) => fingerprintOf(buildSystem(profile));

/** The part that changes per form: the job, what is already filled, and the open fields. */
export function buildPrompt(entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): string {
  return JSON.stringify({ job: jobContext(entry), already_filled: filled, open_fields: open }, null, 1);
}

/** Pulls the JSON object out of the writer's reply, whether or not it wrapped it in a code fence. */
export function parseResolution(text: string): Resolution {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the writer did not return JSON");
  return Resolution.parse(JSON.parse(text.slice(start, end + 1)));
}

const LOG_SYSTEM = [
  "You write two short cells per job for a job-application tracking sheet. You are given several jobs and one candidate.",
  "Reply with one JSON object and nothing else: {\"notes\": [{\"id\": string, \"what_they_do\": string, \"why_fit\": string}]}, one entry per job, with the job's own id.",
  "what_they_do: one plain sentence on what the company builds, from the posting. If the posting says nothing about it, leave it empty.",
  "why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\".",
  "Use only the postings and the candidate's facts. No em dashes, no hype words, under 30 words each.",
].join("\n");

const LogNotes = z.object({ notes: z.array(z.object({ id: z.string(), what_they_do: z.string().default(""), why_fit: z.string().default("") })).default([]) });
export type LogNote = { whatTheyDo: string; whyFit: string };

/**
 * The sheet's "What They Do" and "Why You're a Fit" cells for jobs that were just applied to,
 * all in one writer call: one call for ten jobs costs a fraction of ten calls.
 * Returns nothing for a job the writer skipped, and an empty map if it fails: the log must not block on it.
 */
export async function logNotes(profile: Profile, entries: QueueEntry[]): Promise<Map<string, LogNote>> {
  const out = new Map<string, LogNote>();
  if (!entries.length) return out;
  try {
    const jobs = entries.map((e) => ({ id: e.job.id, company: e.job.company, title: e.job.title, posting: (e.job.description ?? "").slice(0, WRITER.maxNoteChars) }));
    const text = await runWriter(JSON.stringify({ candidate: { summary: profile.summary, facts: profile.facts }, jobs }, null, 1), LOG_SYSTEM, { purpose: "log", jobId: `batch of ${entries.length}` });
    const parsed = LogNotes.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    for (const n of parsed.notes) out.set(n.id, { whatTheyDo: n.what_they_do, whyFit: n.why_fit });
  } catch {
    /* the notes are a convenience */
  }
  return out;
}

export type WriterCall = { at: string; purpose: "resolve" | "log" | "tailor"; jobId: string; model: string; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number; ms: number };

/** What the writer has used in this process. costUsd is what the calls would cost at API prices; on a subscription they draw on the plan instead. */
export const writerUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

type Usage = { input_tokens?: number | undefined; cache_creation_input_tokens?: number | undefined; cache_read_input_tokens?: number | undefined; output_tokens?: number | undefined };
type Envelope = { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; usage?: Usage | undefined };

/** The writer as it is written in the usage log and in a cache key. For Claude this is the model's name, as it always was. */
export function writerLabel(): string {
  const backend = writerBackend();
  if (backend === "codex") return `codex:${writerModel(backend) || "default"}`;
  if (backend === "openai") return `openai:${writerModel(backend)}`;
  return writerModel(backend);
}

function recordWriterCall(envelope: Envelope, meta: { purpose: WriterCall["purpose"]; jobId: string }): void {
  const u = envelope.usage ?? {};
  const call: WriterCall = {
    at: new Date().toISOString(),
    ...meta,
    model: writerLabel(),
    inputTokens: u.input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    costUsd: envelope.total_cost_usd ?? 0,
    ms: envelope.duration_ms ?? 0,
  };
  writerUsage.calls += 1;
  writerUsage.inputTokens += call.inputTokens + call.cacheWriteTokens + call.cacheReadTokens;
  writerUsage.outputTokens += call.outputTokens;
  writerUsage.costUsd += call.costUsd;
  if (process.env.NODE_ENV === "test") return; // a test's fake call is not spend
  try {
    mkdirSync(PATHS.runs, { recursive: true });
    appendFileSync(PATHS.writerUsage, JSON.stringify(call) + "\n");
  } catch {
    /* usage logging is best effort */
  }
}

/**
 * The first call of a process stores the system prompt in the provider's cache. Calls that start
 * while it is still running would each pay to store it again, so they wait for it and then read it.
 */
let warming: Promise<unknown> | null = null;
export async function runWriter(prompt: string, system: string, meta: { purpose: WriterCall["purpose"]; jobId: string }): Promise<string> {
  if (meta.purpose !== "resolve") return callWriter(prompt, system, meta);
  if (warming) {
    await warming;
    return callWriter(prompt, system, meta);
  }
  const first = callWriter(prompt, system, meta);
  warming = first.catch(() => undefined);
  return first;
}

/** Finishing a form field is quick work; writing a resume is not. */
const effortFor = (purpose: WriterCall["purpose"]): string => (purpose === "tailor" ? DOCUMENTS.effort : WRITER.effort);

/** The shape of a Claude API reply, as far as the writer reads it. */
const ApiReply = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
});

/** What one API call cost, from its token counts and the prices in WRITER. */
export function apiCostUsd(u: Usage): number {
  const p = WRITER.apiPricesPerMillion;
  return ((u.input_tokens ?? 0) * p.input + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.output_tokens ?? 0) * p.output) / 1_000_000;
}

/** The Claude API, billed to ANTHROPIC_API_KEY. The system prompt is cached by the provider, as with Claude Code. */
async function callApi(prompt: string, system: string, meta: { purpose: WriterCall["purpose"]; jobId: string }): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env, or remove WRITER_BACKEND=api to use Claude Code.");
  const started = Date.now();
  const res = await fetch(WRITER.apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": WRITER.apiVersion },
    body: JSON.stringify({
      model: writerModel("api"),
      max_tokens: WRITER.maxOutputTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(WRITER.timeoutMs),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The error body never carries the key; the message is enough and nothing else is shown.
    const message = typeof body === "object" && body && "error" in body ? String((body as { error?: { message?: string } }).error?.message ?? "") : "";
    throw new Error(`the Claude API answered ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
  }
  const reply = ApiReply.parse(body);
  const text = reply.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  recordWriterCall({ result: text, usage: reply.usage, total_cost_usd: apiCostUsd(reply.usage ?? {}), duration_ms: Date.now() - started }, meta);
  return text;
}

/** The shape of a chat completions reply, as far as the writer reads it. OpenRouter adds what the call cost. */
const ChatReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), cost: z.number().optional() }).optional(),
});

/** Any service that speaks OpenAI's chat completions, at WRITER_BASE_URL, billed to WRITER_API_KEY. The model has no tools: none are offered. */
async function callOpenAi(prompt: string, system: string, meta: { purpose: WriterCall["purpose"]; jobId: string }): Promise<string> {
  const { baseUrl, key } = writerApi();
  if (key) registerSecret(key); // a key of any shape, so nothing the tool prints can carry it
  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: writerModel("openai"), messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(WRITER.timeoutMs),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The error body never carries the key; the message is enough and nothing else is shown.
    const error = typeof body === "object" && body && "error" in body ? (body as { error?: unknown }).error : undefined;
    const message = typeof error === "string" ? error : typeof error === "object" && error ? String((error as { message?: unknown }).message ?? "") : "";
    throw new Error(`the writer's API answered ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
  }
  const reply = ChatReply.parse(body);
  const text = reply.choices[0]?.message.content ?? "";
  if (!text) throw new Error("the writer's API returned no text");
  recordWriterCall({ result: text, usage: { input_tokens: reply.usage?.prompt_tokens, output_tokens: reply.usage?.completion_tokens }, total_cost_usd: reply.usage?.cost ?? 0, duration_ms: Date.now() - started }, meta);
  return text;
}

/** One headless command: the prompt goes in on standard input, and what it printed comes back. */
function runHeadless(command: string, args: string[], input: string, env: Record<string, string>, installed: string): Promise<{ out: string; ms: number }> {
  return new Promise((resolve, reject) => {
    mkdirSync(WRITER.cwd, { recursive: true });
    const started = Date.now();
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: WRITER.cwd, env: childEnv(env) });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the writer did not answer in ${WRITER.timeoutMs / 1000}s`));
    }, WRITER.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${command}: ${e.message}. ${installed}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`the writer exited with ${code}: ${err.slice(0, 300)}`));
      resolve({ out, ms: Date.now() - started });
    });
    child.stdin.on("error", () => undefined); // a command that died early is reported by its exit, not by the closed pipe
    child.stdin.end(input);
  });
}

/**
 * The arguments for one headless Codex call. Codex has no switch for "no tools", so everything that
 * could act is turned off one by one: its shell tool and web search are off, the person's own config
 * (and with it their MCP servers) and rules are not loaded, no AGENTS.md is read, nothing is kept,
 * and what is left runs in a read-only sandbox in an empty folder.
 */
export function codexArgs(effort: string, model: string): string[] {
  return [
    "exec", "-", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--color", "never",
    "-c", "features.shell_tool=false", "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", `model_reasoning_effort="${effort}"`,
    ...(model ? ["--model", model] : []),
  ];
}

/** Codex takes one prompt and no separate system prompt, so the rules and the candidate come first and the form after them. */
export const codexPrompt = (prompt: string, system: string): string => `${system}\n\nThe form to finish. Reply with the JSON object and nothing else.\n${prompt}`;

async function callCodex(prompt: string, system: string, meta: { purpose: WriterCall["purpose"]; jobId: string }): Promise<string> {
  const { out, ms } = await runHeadless(WRITER.codex.command, codexArgs(effortFor(meta.purpose), writerModel("codex")), codexPrompt(prompt, system), {}, "The Codex CLI must be installed and signed in (run `codex` once).");
  const text = out.trim();
  if (!text) throw new Error("the writer printed nothing");
  // Codex prints its answer and no token counts; the call is on the person's plan.
  recordWriterCall({ result: text, duration_ms: ms }, meta);
  return text;
}

async function callClaudeCode(prompt: string, system: string, meta: { purpose: WriterCall["purpose"]; jobId: string }): Promise<string> {
  const args = ["-p", "--model", writerModel("claude-code"), "--effort", effortFor(meta.purpose), "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--system-prompt", system];
  const { out } = await runHeadless(WRITER.command, args, prompt, WRITER.env, "Claude Code must be installed and logged in.");
  let envelope: Envelope;
  try {
    envelope = JSON.parse(out) as Envelope;
  } catch {
    throw new Error("the writer's output was not JSON");
  }
  recordWriterCall(envelope, meta);
  if (envelope.is_error || typeof envelope.result !== "string") throw new Error(`the writer failed: ${String(envelope.result).slice(0, 300)}`);
  return envelope.result;
}

function callWriter(prompt: string, system: string, meta: { purpose: WriterCall["purpose"]; jobId: string }): Promise<string> {
  const backend = writerBackend();
  if (backend === "api") return callApi(prompt, system, meta);
  if (backend === "openai") return callOpenAi(prompt, system, meta);
  if (backend === "codex") return callCodex(prompt, system, meta);
  return callClaudeCode(prompt, system, meta);
}

/** One plain writer call with a system prompt, for checks. Recorded like any other call. */
export const askWriter = (prompt: string, system: string): Promise<string> => callWriter(prompt, system, { purpose: "log", jobId: "doctor" });

export async function resolveOpenFields(profile: Profile, entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): Promise<Resolution> {
  if (!open.length) return { verdict: "ready", reason: "", answers: [] };
  const res = parseResolution(await runWriter(buildPrompt(entry, filled, open), buildSystem(profile), { purpose: "resolve", jobId: entry?.job.id ?? "" }));
  const known = new Set(open.map((f) => f.selector));
  return { ...res, answers: res.answers.filter((a) => known.has(a.selector)) };
}
