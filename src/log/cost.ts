/**
 * What the tool spends. Two usage logs feed it: data/runs/jev-usage.jsonl
 * (every JEV call, written by JevClient) and data/runs/writer-usage.jsonl
 * (every headless Claude Code call, written by the writer). The summary is
 * pure, so the same numbers can be printed after a run or over all time.
 */
import { existsSync, readFileSync } from "node:fs";
import { PATHS, writerName } from "../config.js";

export type JevLine = { at: string; label: string; input_tokens?: number; output_tokens?: number; cost?: number };
export type WriterLine = { at: string; purpose: string; jobId: string; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number };

export type Bucket = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
export type CostSummary = {
  /** JEV calls by purpose: rate (discovery), map-form (filling), page-state (reading a page). */
  jev: Record<string, Bucket>;
  /** Claude calls by purpose: resolve (open fields), log (the two sheet cells after a submission). */
  claude: Record<string, Bucket>;
  /** Forms that were mapped in the period. */
  forms: number;
  /** Everything except discovery, divided by the number of forms. */
  perForm: { jevUsd: number; claudeUsd: number; totalUsd: number };
  discoveryUsd: number;
  totalUsd: number;
};

const empty = (): Bucket => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
const add = (into: Record<string, Bucket>, key: string, input: number, output: number, cost: number) => {
  const b = (into[key] ??= empty());
  b.calls += 1;
  b.inputTokens += input;
  b.outputTokens += output;
  b.costUsd += cost;
};

export function summarizeCost(jevLines: JevLine[], writerLines: WriterLine[], since = ""): CostSummary {
  const jev: Record<string, Bucket> = {};
  const claude: Record<string, Bucket> = {};
  const forms = new Set<string>();
  for (const l of jevLines) {
    if (since && l.at < since) continue;
    const [purpose = "other", id = ""] = l.label.split(":");
    add(jev, purpose, l.input_tokens ?? 0, l.output_tokens ?? 0, l.cost ?? 0);
    if (purpose === "map-form" && id) forms.add(id);
  }
  for (const l of writerLines) {
    if (since && l.at < since) continue;
    add(claude, l.purpose, l.inputTokens + l.cacheWriteTokens + l.cacheReadTokens, l.outputTokens, l.costUsd);
    if (l.purpose === "resolve" && l.jobId) forms.add(l.jobId);
  }
  const sum = (buckets: Record<string, Bucket>, skip = "") => Object.entries(buckets).reduce((t, [k, b]) => (k === skip ? t : t + b.costUsd), 0);
  const discoveryUsd = jev.rate?.costUsd ?? 0;
  const jevForms = sum(jev, "rate");
  const claudeForms = sum(claude);
  const n = Math.max(1, forms.size);
  return {
    jev,
    claude,
    forms: forms.size,
    perForm: { jevUsd: jevForms / n, claudeUsd: claudeForms / n, totalUsd: (jevForms + claudeForms) / n },
    discoveryUsd,
    totalUsd: discoveryUsd + jevForms + claudeForms,
  };
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn line from an interrupted run */
    }
  }
  return out;
}

export function loadCost(since = ""): CostSummary {
  return summarizeCost(readLines<JevLine>(PATHS.jevUsage), readLines<WriterLine>(PATHS.writerUsage), since);
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : n < 1 ? 4 : 2)}`;

export function formatCost(c: CostSummary): string {
  const row = (name: string, b: Bucket) => `  ${name.padEnd(12)} ${String(b.calls).padStart(5)} calls  ${String(b.inputTokens).padStart(9)} in  ${String(b.outputTokens).padStart(8)} out  ${usd(b.costUsd)}`;
  const w = writerName();
  const api = w.billed;
  const lines = ["JEV (billed to your OpenRouter key)"];
  for (const [k, b] of Object.entries(c.jev)) lines.push(row(k, b));
  const claudeCalls = Object.values(c.claude).reduce((n, b) => n + b.calls, 0);
  if (api) {
    lines.push(`${w.name} (${w.how})`);
    for (const [k, b] of Object.entries(c.claude)) lines.push(row(k, b));
    if (!claudeCalls) lines.push("  no calls recorded");
  } else {
    lines.push(`${w.name}: ${claudeCalls} call(s) through ${w.how}, no separate bill`);
  }
  lines.push(`Forms: ${c.forms}`);
  if (c.forms) {
    lines.push(api ? `Per form: JEV ${usd(c.perForm.jevUsd)} + ${w.name === "Claude" ? "Claude" : "writer"} ${usd(c.perForm.claudeUsd)} = ${usd(c.perForm.totalUsd)}` : `Per form: JEV ${usd(c.perForm.jevUsd)}`);
    lines.push(api ? `Per 10 forms: JEV ${usd(c.perForm.jevUsd * 10)} + ${w.name === "Claude" ? "Claude" : "writer"} ${usd(c.perForm.claudeUsd * 10)} = ${usd(c.perForm.totalUsd * 10)}` : `Per 10 forms: JEV ${usd(c.perForm.jevUsd * 10)}`);
  }
  const jevTotal = c.discoveryUsd + Object.entries(c.jev).reduce((t, [k, b]) => (k === "rate" ? t : t + b.costUsd), 0);
  lines.push(api ? `Discovery (rating): ${usd(c.discoveryUsd)}   Total: ${usd(c.totalUsd)}` : `Discovery (rating): ${usd(c.discoveryUsd)}   Total billed (JEV): ${usd(jevTotal)}`);
  return lines.join("\n");
}
