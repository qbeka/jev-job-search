#!/usr/bin/env -S npx tsx
/**
 * jev-job-search command line. Each command is a thin wrapper: the work is in
 * discover.ts, run/pipeline.ts and browser/. Commands that list things take
 * --json so their output can be read by a program.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { contextFingerprint } from "./answers/resolve.js";
import { loadMemory, prune, saveMemory } from "./answers/memory.js";
import { inspect, setValues } from "./browser/formRunner.js";
import { loadReport, type Fill, type FillReport } from "./browser/report.js";
import { closeJobTab, loadSession } from "./browser/session.js";
import { clearBrowsingData, ensureBrowser } from "./browser/cdp.js";
import { acquireRun } from "./util/store.js";
import { waitingWords } from "./run/assist.js";
import { withStore } from "./util/store.js";
import { checkJob } from "./browser/submit.js";
import { childEnv, loadEnv, DISCOVER, PATHS, REPORT, RUN } from "./config.js";
import { installRedaction } from "./util/redact.js";
import { discover } from "./discover.js";
import { formatChecks, isReadyToRun, nextStep, runChecks } from "./doctor.js";
import { JevClient } from "./jev/client.js";
import { loadKnowledge, shareKnowledge } from "./knowledge/sites.js";
import { loadQueue, mutateQueue, sortEntries, updateEntry, QueueStatus } from "./jobs/queue.js";
import { formatCost, loadCost } from "./log/cost.js";
import { appliedRecords, loadRows, manualRecords, saveRows, toRecord, upsertEntry } from "./log/csv.js";
import { loadProfile } from "./profile/schema.js";
import { setDocumentPolicy, tailorJob } from "./documents/tailor.js";
import { activeTemplate, addTemplate, listTemplates, useTemplate } from "./documents/templates.js";
import { addJob, looksLikeUrl } from "./jobs/addJob.js";
import { buildReport } from "./report/data.js";
import { reportPage } from "./report/page.js";
import { startReportServer } from "./report/server.js";
import { endIfAbandoned, noteApplied, pipeline, reconcile, recordApplied, resolvePage, resume, submitAndRecord, sweep, takeJobs } from "./run/pipeline.js";
import { brief, printFill, printTable } from "./run/print.js";
import { limiter } from "./util/pace.js";

loadEnv();
installRedaction();
// Output piped into a command that stops reading early (head, a pager) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
const program = new Command();
program.name("jev-job-search").description("Find and rate software jobs with JEV, fill and check each application form in Chrome, and let Claude write what needs writing.").version("1.2.1");

const int = (v: string) => parseInt(v, 10);
const whereTheRecordIs = () => `Applications you sent: ${PATHS.applied}\nJobs left for you to do by hand: ${PATHS.manual}\nTake-home assignments to do: ${PATHS.takehome}\nEvery job considered: ${PATHS.applications}`;

// ---------------------------------------------------------------- find jobs

program
  .command("discover")
  .description("Find jobs: read every source, filter, rate with JEV, and write the queue and the record")
  .option("--no-boards", "skip polling company boards directly")
  .option("--limit <n>", "rate at most n new jobs (for a quick test)", int)
  .option("--max-age <days>", `consider postings up to this many days old (default ${DISCOVER.maxAgeDays})`, int)
  .option("--json", "print the summary as JSON")
  .action(async (o: { boards: boolean; limit?: number; maxAge?: number; json?: boolean }) => {
    const { queue, summary } = await discover(loadProfile(), new JevClient(), { boards: o.boards, ...(o.limit !== undefined ? { limit: o.limit } : {}), ...(o.maxAge !== undefined ? { maxAgeDays: o.maxAge } : {}), log: (l) => console.error(l) });
    const top = sortEntries(queue.entries.filter((e) => e.status === "queued")).slice(0, RUN.listed);
    if (o.json) return console.log(JSON.stringify({ summary, top: top.map(brief) }, null, 2));
    console.log(`\n${summary.unique} unique postings, ${summary.preFiltered} removed by code filters, ${summary.rated} rated by JEV (${summary.reused} of them from earlier ratings).`);
    console.log(`${summary.queued} queued (score ≥ ${DISCOVER.applyThreshold}), ${summary.belowThreshold} below threshold, ${summary.skippedByJev} skipped by JEV.`);
    console.log(`JEV: ${summary.jevCalls} calls, $${summary.jevCostUsd.toFixed(4)}.\n`);
    printTable(top);
  });

program
  .command("queue")
  .description("List the ranked jobs")
  .option("--all", "include skipped and applied entries")
  .option("--limit <n>", "rows to show", int, 50)
  .option("--json")
  .action((o: { all?: boolean; limit: number; json?: boolean }) => {
    const q = loadQueue();
    const entries = sortEntries(o.all ? q.entries : q.entries.filter((e) => e.status === "queued")).slice(0, o.limit);
    if (o.json) console.log(JSON.stringify(entries.map(brief), null, 2));
    else printTable(entries);
  });

// ------------------------------------------------------------------- apply

type ApplyOptions = { count: number; dry?: boolean; submit?: boolean; fresh?: boolean; json?: boolean; tailor?: boolean; cover?: boolean; plain?: boolean; resubmit?: boolean };

/** Takes the browser for a command that drives it, tidies what an interrupted run left, and gives the lock back when the work ends. */
async function inRun<T>(command: string, work: () => Promise<T>): Promise<T> {
  const release = acquireRun(command);
  try {
    await ensureBrowser();
    await sweep();
    return await work();
  } finally {
    release();
  }
}

/** A posting's link in place of an id is read, rated and queued first, so `apply <link> --submit` is one step. */
async function idsFromLinks(given: string[]): Promise<string[]> {
  const out: string[] = [];
  let jev: JevClient | null = null;
  for (const g of given) {
    if (!looksLikeUrl(g)) {
      out.push(g);
      continue;
    }
    jev ??= new JevClient();
    const e = await addJob(jev, loadProfile(), g);
    console.log(`${e.job.id}  ${e.job.company} | ${e.job.title}  (fit ${e.fit?.score.toFixed(2) ?? "?"})`);
    // A link to a job that was sent, or may have been, is passed on all the same: takeJobs refuses it and says why.
    out.push(e.job.id);
  }
  return out;
}

/** What this run does about documents: a tailored resume on request, a cover letter on request or when the profile says when_asked. */
const documentsFromOptions = (o: { tailor?: boolean; cover?: boolean; plain?: boolean }) => {
  if (o.plain) return setDocumentPolicy({ resume: false, cover: false });
  const cover = !!o.cover || loadProfile().preferences.coverLetter === "when_asked";
  setDocumentPolicy({ resume: !!o.tailor || cover, cover });
};

program
  .command("apply [ids...]")
  .description("Fill each form, answer what is open, walk its pages, check every answer, and with --submit send every form that is ready. An id can also be a posting's link on Greenhouse, Lever or Ashby")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", int, 1)
  .option("--submit", "send each form the moment it is ready. Without it, ready forms are left open in the window")
  .option("--dry", "a rehearsal: record nothing, send nothing, close the tabs")
  .option("--fresh", "ignore the answer memory and ask Claude again")
  .option("--tailor", "write a resume for each job from your profile and attach that one instead of your file")
  .option("--cover", "also write a cover letter for a form that has a box for one, as a file or as text")
  .option("--plain", "the profile's own resume and no cover letter, whatever the profile says")
  .option("--resubmit", "let a job you already applied to be filled and sent again. Never needed in normal use")
  .option("--json")
  .action(async (given: string[], o: ApplyOptions) => {
    documentsFromOptions(o);
    const began = new Date().toISOString();
    await inRun(`apply${o.submit ? " --submit" : ""}${o.dry ? " --dry" : ""}`, async () => {
      const ids = await idsFromLinks(given);
      if (given.length && !ids.length) return;
      const entries = takeJobs(ids, { count: o.count, dry: !!o.dry, resubmit: !!o.resubmit });
      if (given.length && !entries.length) return;
      const { reports, sent } = await pipeline(entries, { submit: !!o.submit, dry: !!o.dry, fresh: !!o.fresh, quiet: !!o.json });
      if (o.json) console.log(JSON.stringify(reports, null, 2));
      if (!o.dry) {
        await noteApplied(sent);
        const done = new Map(loadQueue().entries.map((e) => [e.job.id, e]));
        const count = (...statuses: string[]) => reports.filter((r) => statuses.includes(done.get(r.jobId)?.status ?? "")).length;
        console.log(`\n${count("applied")} applied, ${count("needs_review", "blocked", "login_required")} left for you, ${count("skipped", "failed")} skipped, ${count("in_progress")} filled and waiting for submit`);
        if (count("awaiting_user_action")) console.log(`${count("awaiting_user_action")} form(s) are open and waiting for you (an emailed code, a robot check). Finish each in the tool's window, then run: npx jev resume`);
        if (count("submission_unknown")) console.log(`${count("submission_unknown")} form(s) were clicked and not confirmed. They will not be sent again until settled: npx jev reconcile`);
        console.log(whereTheRecordIs());
      }
    });
    if (!o.json) console.log(`\nCost of this run\n${formatCost(loadCost(began))}`);
    endIfAbandoned();
  });

program
  .command("fill [ids...]")
  .description("Fill the first page of each form with JEV and stop. Nothing is answered by Claude and nothing is sent")
  .option("--count <n>", "with no ids: take this many jobs from the top of the queue", int, 1)
  .option("--dry", "a rehearsal: leave the queue untouched and close each tab once it is filled")
  .option("--tailor", "write a resume for each job from your profile and attach that one instead of your file")
  .option("--cover", "also write a cover letter for a form that has a box for one")
  .option("--json")
  .action(async (ids: string[], o: ApplyOptions) => {
    documentsFromOptions(o);
    const { reports } = await inRun("fill", () => pipeline(takeJobs(ids, { count: o.count, dry: !!o.dry }), { submit: false, dry: !!o.dry, fresh: false, quiet: !!o.json, fillOnly: true }));
    if (o.json) console.log(JSON.stringify(reports, null, 2));
    endIfAbandoned();
  });

program
  .command("tailor <ids...>")
  .description("Write a one-page resume, and with --cover a cover letter, for each job from your profile. Every claim is checked against the profile; the PDFs go to documents/tailored/<Company>_<Role>_<id>/")
  .option("--cover", "also write a cover letter")
  .option("--fresh", "write again even when documents for this job exist")
  .option("--open", "open each PDF when it is written")
  .action(async (ids: string[], o: { cover?: boolean; fresh?: boolean; open?: boolean }) => {
    const profile = loadProfile();
    const entries = loadQueue().entries.filter((e) => ids.includes(e.job.id));
    for (const id of ids) if (!entries.some((e) => e.job.id === id)) console.log(`${id}  not in the queue`);
    for (const e of entries) {
      try {
        const d = await tailorJob(profile, e, { cover: !!o.cover, fresh: !!o.fresh });
        console.log(`== ${e.job.company} | ${e.job.title} [${e.job.id}]${d.reused ? " (already written)" : ""}`);
        console.log(`   resume: ${d.resume}`);
        if (d.cover) console.log(`   cover letter: ${d.cover}`);
        if (d.tailored.keywordsCovered.length) console.log(`   covers: ${d.tailored.keywordsCovered.slice(0, 12).join(", ")}`);
        if (d.tailored.keywordsMissing.length) console.log(`   the posting also wants, and your profile does not say: ${d.tailored.keywordsMissing.slice(0, 8).join(", ")}`);
        if (o.open) for (const f of [d.resume, d.cover]) if (f) spawn("open", [f], { stdio: "ignore", detached: true, env: childEnv() }).unref();
      } catch (err) {
        console.log(`== ${e.job.company} | ${e.job.title} [${e.job.id}]  not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`
Cost of this run
${formatCost(loadCost(new Date(Date.now() - 60 * 60 * 1000).toISOString()))}`);
  });

program
  .command("report")
  .description("A dashboard of your records on your own machine: totals, applications per day and per board, every row with its status, which you can change by hand. --static writes a snapshot page instead")
  .option("--port <n>", "the port to listen on", int, REPORT.port)
  .option("--open", "open the page in your browser")
  .option("--static <file>", "write a self-contained snapshot page to this file and exit")
  .action(async (o: { port: number; open?: boolean; static?: string }) => {
    if (o.static) {
      writeFileSync(o.static, reportPage(buildReport(loadRows())));
      console.log(`Wrote ${o.static}`);
      if (o.open) spawn("open", [o.static], { stdio: "ignore", detached: true, env: childEnv() }).unref();
      return;
    }
    const address = await startReportServer(o.port);
    console.log(`Dashboard at ${address}  (Ctrl-C to stop)`);
    if (o.open) spawn("open", [address], { stdio: "ignore", detached: true, env: childEnv() }).unref();
  });

program
  .command("templates")
  .description("The resume and cover letter templates: list them, register your own folder of resume.html and cover.html with a mandatory test print, or choose which one tailor uses")
  .option("--add <dir>", "register the template in this folder, under the name given with --name")
  .option("--name <name>", "the name for --add: lower-case letters, digits and dashes")
  .option("--use <name>", "make this template the one tailor uses; default is the stock one")
  .action(async (o: { add?: string; name?: string; use?: string }) => {
    if (o.add) {
      const name = o.name ?? path.basename(path.resolve(o.add)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      const r = await addTemplate(path.resolve(o.add), name);
      console.log(`Registered ${name} at ${r.template.dir}. Test print: resume ${r.resumePages} page(s)${r.coverPages !== null ? `, cover letter ${r.coverPages} page(s)` : ", no cover.html"}. Proof PDFs are in ${path.join(r.template.dir, ".proof")}.`);
      console.log(`To use it: npx jev templates --use ${name}`);
      return;
    }
    if (o.use) {
      const t = useTemplate(o.use);
      console.log(`tailor now uses ${t.name} (${t.dir})`);
      return;
    }
    const active = activeTemplate();
    for (const t of listTemplates()) console.log(`${t.name === active.name ? "*" : " "} ${t.name.padEnd(16)} ${t.shipped ? "shipped" : "yours"}  ${t.dir}`);
    console.log("\n* is the one tailor uses. npx jev templates --use <name> changes it; --add <dir> --name <name> registers your own.");
  });

program
  .command("resolve <ids...>")
  .description("Answer what is still open on filled forms: from the answer memory, or by Claude. The answers are written in and read back")
  .option("--fresh", "ignore the answer memory and ask Claude again")
  .action(async (ids: string[], o: { fresh?: boolean }) => {
    const profile = loadProfile();
    const jev = new JevClient();
    const q = loadQueue();
    const writer = limiter(RUN.writerConcurrency);
    await Promise.all(ids.map((id) => writer(async () => printFill(await resolvePage(jev, profile, q.entries.find((e) => e.job.id === id) ?? null, loadReport(id), !!o.fresh)))));
  });

program
  .command("submit <ids...>")
  .description("Send forms that are ready, read the page that comes back, and record the ones that went through")
  .option("--keep-open", "leave the tab open after a confirmed submission")
  .option("--force", "send even though the form is not marked ready")
  .action(async (ids: string[], o: { keepOpen?: boolean; force?: boolean }) => {
    const jev = new JevClient();
    const sent: string[] = [];
    await inRun("submit", async () => {
      const unknown = new Set(loadQueue().entries.filter((e) => e.status === "submission_unknown").map((e) => e.job.id));
      for (const id of ids) {
        if (unknown.has(id)) console.log(`${id}  not sent: Submit was clicked on this form before and no confirmation was seen. Settle it first: npx jev reconcile ${id}`);
        else if (await submitAndRecord(jev, id, !!o.force, !!o.keepOpen)) sent.push(id);
      }
    });
    await noteApplied(sent);
  });

program
  .command("resume [ids...]")
  .description("Watch the forms that were left open for you while you finish them (an emailed code, a robot check), and record each application when its confirmation shows. Nothing is typed or clicked for you")
  .action(async (ids: string[]) => {
    const jev = new JevClient();
    const sent: string[] = [];
    await inRun("resume", async () => {
      const waiting = loadQueue().entries.filter((e) => e.status === "awaiting_user_action" && (!ids.length || ids.includes(e.job.id)));
      if (!waiting.length) return console.log("No form is waiting for you.");
      let skip = false;
      if (process.stdin.isTTY) process.stdin.on("data", () => (skip = true));
      for (const [i, e] of waiting.entries()) {
        console.log(`\n${i + 1} of ${waiting.length}: ${e.job.company} | ${e.job.title}`);
        console.log(`  In the tool's Chrome window: ${waitingWords(e.waitingFor ?? "unknown")}.${process.stdin.isTTY ? " Press Enter here to skip this one." : ""}`);
        skip = false;
        const outcome = await resume(jev, e.job.id, { stop: () => skip });
        if (outcome === "applied") sent.push(e.job.id);
        console.log(outcome === "applied" ? "  Sent and recorded." : outcome === "gone" ? "  Its tab was closed. It is on your by-hand list." : "  Not sent yet. It stays open; run resume again when you are ready.");
      }
      if (process.stdin.isTTY) process.stdin.pause();
    });
    await noteApplied(sent);
  });

program
  .command("reconcile [ids...]")
  .description("Settle the forms whose Submit was clicked with no confirmation seen: read what each tab shows now, and record it as applied or as not sent. A form that proves neither stays unconfirmed for you to settle with mark")
  .action(async (ids: string[]) => {
    const jev = new JevClient();
    const sent: string[] = [];
    await inRun("reconcile", async () => {
      const unknown = loadQueue().entries.filter((e) => e.status === "submission_unknown" && (!ids.length || ids.includes(e.job.id)));
      if (!unknown.length) return console.log("No submission is waiting to be confirmed.");
      for (const e of unknown) {
        const outcome = await reconcile(jev, e.job.id).catch(() => "unknown" as const);
        if (outcome === "applied") sent.push(e.job.id);
        console.log(`${e.job.id}  ${e.job.company} | ${e.job.title}: ${outcome === "applied" ? "confirmed, recorded as applied" : outcome === "not_sent" ? "the form is still open, so it was not sent. It is on your by-hand list" : `cannot tell. Look for a confirmation email from ${e.job.company}, then run: npx jev mark ${e.job.id} --status applied, or --status queued to try again`}`);
      }
    });
    await noteApplied(sent);
  });

program
  .command("browser <action>")
  .description("browser reset: clear the cookies, cache and site data of the tool's own Chrome. This signs it out of every site. Use it only when a site misbehaves")
  .option("--yes", "do it without asking")
  .action(async (action: string, o: { yes?: boolean }) => {
    if (action !== "reset") return console.log("The only action is: browser reset");
    if (!o.yes) return console.log("This clears every cookie and sign-in in the tool's own Chrome (your everyday browser is not touched). To go ahead: npx jev browser reset --yes");
    await inRun("browser reset", async () => {
      if (Object.keys(loadSession()).length) return console.log("Forms are still open in the tool's window. Finish or close them first (npx jev resume, npx jev close <id>).");
      await clearBrowsingData();
      console.log("Cleared the cookies, cache and site data of the tool's Chrome.");
    });
  });

// ------------------------------------------------------ forms left for you

program
  .command("check <ids...>")
  .description("Read what each job's tab shows now, without clicking, and record the job as applied if it is a confirmation. Use it after you finished a form by hand")
  .action(async (ids: string[]) => {
    const jev = new JevClient();
    const sent: string[] = [];
    for (const id of ids) {
      try {
        const r = await checkJob(jev, id);
        console.log(`${id}  ${r.needsCode ? "still needs your code" : r.state} (${r.confidence.toFixed(2)})  ${r.url}`);
        if (r.state === "submitted") {
          recordApplied(id);
          await closeJobTab(id);
          sent.push(id);
        } else console.log(`  page ends: ${r.excerpt}`);
      } catch (err) {
        console.log(`${id}  not checked: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await noteApplied(sent);
    console.log(`${sent.length} of ${ids.length} recorded as applied`);
  });

program
  .command("inspect <id>")
  .description("Show what a filled form holds right now, and any errors on the page")
  .action(async (id: string) => {
    const r = await inspect(id);
    for (const f of r.fields) console.log(`${f.required ? "*" : " "} ${f.action.padEnd(6)} ${f.label.slice(0, 90).padEnd(90)} ${f.shown.slice(0, 80)}`);
    if (r.errors.length) console.log(`errors: ${r.errors.join(" | ")}`);
  });

program
  .command("set <id>")
  .description("Write answers you chose into a filled form")
  .requiredOption("--values <file>", "JSON array of { selector, kind, value }")
  .action(async (id: string, o: { values: string }) => {
    const fills = JSON.parse(readFileSync(o.values, "utf8")) as Fill[];
    console.log(JSON.stringify(await setValues(loadProfile(), id, fills), null, 2));
  });

program
  .command("close <ids...>")
  .description("Close the tabs of these jobs")
  .action(async (ids: string[]) => {
    for (const id of ids) await closeJobTab(id);
  });

program
  .command("mark <id>")
  .description("Record an outcome by hand: applied | skipped | failed | blocked | needs_review | queued")
  .requiredOption("--status <status>")
  .option("--reason <text>")
  .option("--notes <text>")
  .action((id: string, o: { status: string; reason?: string; notes?: string }) => {
    const status = QueueStatus.parse(o.status);
    const e = withStore(() => {
      const changed = mutateQueue((q) => updateEntry(q, id, { status, statusReason: o.reason ?? null, waitingFor: null, ...(o.notes ? { notes: o.notes } : {}), ...(status === "applied" ? { appliedAt: new Date().toISOString() } : {}) }));
      saveRows(upsertEntry(loadRows(), changed, o.notes ? { Notes: o.notes } : {}));
      return changed;
    });
    console.log(`${e.job.company} | ${e.job.title} → ${status}${o.reason ? ` (${o.reason})` : ""}`);
  });

// ------------------------------------------------------------- the records

program
  .command("log")
  .description("Your applications: the ones you sent, newest first. The same list is in applied.csv at the top of this folder")
  .option("--manual", "the jobs left for you to do by hand, with the reason and the link (manual.csv)")
  .option("--all", "every job the tool considered")
  .option("--json", "print the rows as JSON with plain field names")
  .option("--open", "open the file in your spreadsheet program")
  .action((o: { manual?: boolean; all?: boolean; json?: boolean; open?: boolean }) => {
    const rows = loadRows();
    // Writing the rows back rebuilds applied.csv and manual.csv from the full record.
    if (rows.length) saveRows(rows);
    const file = o.all ? PATHS.applications : o.manual ? PATHS.manual : PATHS.applied;
    if (o.open) {
      if (!existsSync(file)) return console.log(`Nothing to open yet. ${file} is created by the first discover run.`);
      if (process.platform === "darwin") spawn("open", [file], { stdio: "ignore", detached: true, env: childEnv() }).unref();
      return console.log(file);
    }
    if (o.manual) {
      const todo = manualRecords(rows);
      if (o.json) return console.log(JSON.stringify(todo, null, 2));
      for (const r of todo) console.log(`${r.company.slice(0, 22).padEnd(22)} ${r.role.slice(0, 40).padEnd(40)} ${r.reason.slice(0, 70).padEnd(70)} ${r.job_link}`);
      return console.log(`\n${todo.length} job(s) left for you\n${whereTheRecordIs()}`);
    }
    const records = o.all ? rows.map(toRecord) : appliedRecords(rows);
    if (o.json) return console.log(JSON.stringify(records, null, 2));
    for (const r of records) console.log(`${(r.applied_on || "          ").padEnd(10)}  ${r.company.slice(0, 24).padEnd(24)} ${r.role.slice(0, 46).padEnd(46)} ${r.location.slice(0, 26).padEnd(26)} ${o.all && "status" in r ? String(r.status).slice(0, 30).padEnd(30) + " " : ""}${r.job_link}`);
    console.log(`\n${records.length} ${o.all ? "jobs considered" : "applications sent"}\n${whereTheRecordIs()}`);
  });

program
  .command("status")
  .description("Totals, and the reasons jobs were skipped")
  .option("--json")
  .action((o: { json?: boolean }) => {
    const q = loadQueue();
    const by = (s: string) => q.entries.filter((e) => e.status === s);
    const reasons: Record<string, number> = {};
    for (const e of q.entries) if (e.status !== "queued" && e.status !== "applied") reasons[e.statusReason ?? e.status] = (reasons[e.statusReason ?? e.status] ?? 0) + 1;
    const today = new Date().toDateString();
    const summary = {
      generatedAt: q.generatedAt,
      total: q.entries.length,
      applied: by("applied").length,
      appliedToday: by("applied").filter((e) => e.appliedAt && new Date(e.appliedAt).toDateString() === today).length,
      queued: by("queued").length,
      inProgress: by("in_progress").length,
      leftForYou: by("needs_review").length + by("blocked").length,
      failed: by("failed").length,
      skipped: by("skipped").length,
      topSkipReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
    if (o.json) return console.log(JSON.stringify(summary, null, 2));
    console.log(`Queue from ${summary.generatedAt}`);
    console.log(`applied ${summary.applied} (today ${summary.appliedToday}) | queued ${summary.queued} | in progress ${summary.inProgress} | left for you ${summary.leftForYou} | failed ${summary.failed} | skipped ${summary.skipped}`);
    for (const [r, n] of summary.topSkipReasons) console.log(`  ${String(n).padStart(4)}  ${r}`);
    console.log(whereTheRecordIs());
  });

program
  .command("cost")
  .description("What the tool has spent on JEV and on Claude, by purpose, and per form")
  .option("--since <iso>", "count only calls at or after this time, for example 2026-10-02T16:00:00Z")
  .option("--json")
  .action((o: { since?: string; json?: boolean }) => {
    const c = loadCost(o.since ?? "");
    console.log(o.json ? JSON.stringify(c, null, 2) : formatCost(c));
  });

program
  .command("survey")
  .description("Totals over every fill report: how many answers landed, and what did not")
  .action(() => {
    const reports = readdirSync(PATHS.runs).filter((f) => f.endsWith(".report.json")).map((f) => loadReport(path.basename(f, ".report.json")));
    const t = { forms: 0, blocked: 0, fields: 0, landed: 0, failed: 0, reviews: 0, drafts: 0, emptyRequired: 0 };
    for (const r of reports.sort((a: FillReport, b: FillReport) => a.ats.localeCompare(b.ats) || a.company.localeCompare(b.company))) {
      const all = [...r.earlier, ...r.fields];
      const wanted = all.filter((f) => f.action === "fill" || f.action === "upload");
      const landed = wanted.filter((f) => f.shown).length;
      t.forms++;
      if (r.state === "blocked") t.blocked++;
      t.fields += all.length;
      t.landed += landed;
      t.failed += r.failed.length;
      t.reviews += r.reviews.length;
      t.drafts += r.drafts.length;
      t.emptyRequired += r.missingRequired.length;
      console.log(`${r.ats.padEnd(12)} ${r.company.slice(0, 22).padEnd(22)} ${r.title.slice(0, 38).padEnd(38)} ${r.state === "blocked" ? `blocked: ${r.reason}` : `${String(all.length).padStart(3)} fields  ${landed}/${wanted.length} landed  ${r.failed.length} failed  ${r.reviews.length} review  ${r.drafts.length} draft  ${r.missingRequired.length} empty-required  ${r.seconds.toFixed(1)}s`}`);
    }
    console.log(`\n${t.forms} forms (${t.blocked} blocked), ${t.fields} fields: ${t.landed} landed, ${t.failed} failed, ${t.reviews} for review, ${t.drafts} to draft, ${t.emptyRequired} required still empty`);
  });

// ------------------------------------------------------------ housekeeping

program
  .command("doctor")
  .description("Check that everything a run needs is in place, and say what to do next")
  .option("--online", "also make one tiny JEV call and one tiny Claude call to prove the key and the sign-in work")
  .option("--json")
  .action(async (o: { online?: boolean; json?: boolean }) => {
    const checks = await runChecks(!!o.online);
    console.log(o.json ? JSON.stringify({ ready: isReadyToRun(checks), next: nextStep(checks), checks }, null, 2) : formatChecks(checks));
    if (!isReadyToRun(checks)) process.exitCode = 1;
  });

program
  .command("knowledge")
  .description("What the tool has learned about each site: how its controls take values, whether it wants a sign-in, how many pages its form has, and what it could not set")
  .option("--share", "write this machine's notes into knowledge/sites.json, ready to commit and send as a pull request")
  .option("--trouble", "only the controls the tool could not set: what to teach it next")
  .option("--json")
  .action((o: { share?: boolean; trouble?: boolean; json?: boolean }) => {
    if (o.share) {
      const n = shareKnowledge();
      return console.log(`${PATHS.knowledgeShipped} now holds notes on ${n} site(s). It has site names and kinds of controls in it, and nothing about you. Commit it and open a pull request to share what your runs learned.`);
    }
    const k = loadKnowledge();
    if (o.json) return console.log(JSON.stringify(k, null, 2));
    const sites = Object.entries(k.sites).sort(([, a], [, b]) => b.forms - a.forms);
    for (const [host, s] of sites) {
      const trouble = Object.entries(s.trouble);
      if (o.trouble && !trouble.length) continue;
      if (!o.trouble) {
        const ways = Object.entries(s.controls).map(([sig, c]) => `${sig} ${c.method}`).join(", ");
        console.log(`${host.padEnd(38)} ${String(s.forms).padStart(3)} forms, ${s.ready} ready${s.pages > 1 ? `, ${s.pages} pages` : ""}${s.signIn ? ", wants a sign-in" : ""}${s.emailsCode ? ", emails a code" : ""}${ways ? `\n    ${ways}` : ""}`);
      } else console.log(host);
      for (const [sig, t] of trouble) console.log(`    could not set ${sig} (${t.count}x): ${t.why}`);
    }
    console.log(`\n${sites.length} site(s) known. Shipped notes: ${PATHS.knowledgeShipped}. This machine's: ${PATHS.knowledgeLocal}.`);
  });

program
  .command("memory")
  .description("The answer memory: answers Claude gave before, reused so the same question is not paid for twice")
  .option("--forget <text>", "forget every remembered answer whose question or company contains this text")
  .option("--clear", "forget everything")
  .option("--json")
  .action((o: { forget?: string; clear?: boolean; json?: boolean }) => {
    if (o.clear) {
      saveMemory({ version: 1, forms: {}, answers: [] });
      return console.log("The answer memory is empty.");
    }
    const mem = loadMemory();
    if (o.forget) {
      const t = o.forget.toLowerCase();
      const kept = { version: 1 as const, answers: mem.answers.filter((a) => !a.question.toLowerCase().includes(t) && !a.company.toLowerCase().includes(t)), forms: Object.fromEntries(Object.entries(mem.forms).filter(([, f]) => !f.company.toLowerCase().includes(t))) };
      saveMemory(kept);
      return console.log(`Forgot ${mem.answers.length + Object.keys(mem.forms).length - kept.answers.length - Object.keys(kept.forms).length} entries.`);
    }
    // Entries written before the profile last changed can never match again, so they are dropped here.
    const current = prune(mem, contextFingerprint(loadProfile()));
    if (existsSync(PATHS.memory)) saveMemory(current);
    if (o.json) return console.log(JSON.stringify(current, null, 2));
    for (const a of current.answers) console.log(`${a.question.slice(0, 90).padEnd(90)}  ${a.value.replace(/\s+/g, " ").slice(0, 60).padEnd(60)}  (${a.company})`);
    console.log(`\n${current.answers.length} answers that hold on any form, ${Object.keys(current.forms).length} form pages remembered whole. File: ${PATHS.memory}`);
    console.log("An answer is reused only while your profile, drafts and voice guide stay as they were when it was written.");
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
