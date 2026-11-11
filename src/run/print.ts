/** How a run shows its work on the terminal: one block per form, one line per field. */
import type { FillReport } from "../browser/report.js";
import { writerName } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";

const headline = (r: FillReport) => {
  if (r.sent) return "SENT by its last Next";
  if (r.state !== "filled") return "blocked";
  if (r.ready) return "READY";
  return r.hasNext ? `page ${r.page} filled, form goes on` : "filled, not ready";
};

export function printFill(r: FillReport): void {
  console.log(`\n== ${r.company} | ${r.title} [${r.jobId}] ${headline(r)} in ${r.seconds.toFixed(1)}s${r.page > 1 ? `, ${r.page} pages` : ""}, JEV $${r.jevCostUsd.toFixed(4)}`);
  if (r.resolution) console.log(`   ${r.writerCalled === false ? "Memory" : writerName().name}: ${r.resolution.verdict}${r.resolution.reason ? `, ${r.resolution.reason}` : ""} (${r.resolution.answers.length} answers${r.recalled ? `, ${r.recalled} from memory` : ""}${r.writerCalled === false ? ", Claude was not asked" : ""})`);
  console.log(`   ${r.url}`);
  if (r.reason) console.log(`   ${r.reason}`);
  for (const f of [...r.earlier, ...r.fields]) console.log(`   ${f.required ? "*" : " "} ${f.action.padEnd(6)} ${f.label.slice(0, 80).padEnd(80)} ${f.shown.slice(0, 70)}${f.note ? `  (${f.note})` : ""}`);
  for (const d of r.drafts) console.log(`   DRAFT  ${d.selector}  intent=${d.intent} max=${d.maxLength ?? "-"}  ${d.label.slice(0, 200)}`);
  for (const v of r.reviews) console.log(`   REVIEW ${v.selector}  [${v.kind}] ${v.label.slice(0, 160)}  why=${v.why}  options=${v.options.slice(0, 15).join(" | ")}`);
  for (const f of r.failed) console.log(`   FAILED ${f.selector}  ${f.label.slice(0, 60)}: ${f.why}`);
  for (const f of r.leftBlank) console.log(`   LEFT BLANK (optional) ${f.label.slice(0, 60)}: ${f.why}`);
  if (r.missingRequired.length) console.log(`   EMPTY REQUIRED: ${r.missingRequired.map((l) => l.slice(0, 60)).join(" | ")}`);
}

/** A queue entry as the commands print it with --json. */
export function brief(e: QueueEntry) {
  return {
    id: e.job.id,
    company: e.job.company,
    title: e.job.title,
    url: e.job.url,
    ats: e.job.ats,
    locations: e.job.locations,
    postedAt: e.job.postedAt,
    score: e.fit?.score ?? null,
    status: e.status,
    reason: e.statusReason,
    notes: e.fit?.reasons ?? [],
  };
}

export function printTable(entries: QueueEntry[]): void {
  for (const e of entries) {
    const score = e.fit ? e.fit.score.toFixed(2) : "  -  ";
    console.log(`${score}  ${e.job.postedAt ?? "          "}  ${e.job.ats.padEnd(13)} ${e.job.company.slice(0, 28).padEnd(28)} ${e.job.title.slice(0, 60).padEnd(60)} ${e.job.locations.join(" / ").slice(0, 40)}  [${e.job.id}]`);
  }
}
