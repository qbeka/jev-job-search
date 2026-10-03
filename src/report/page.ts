/**
 * The dashboard page: one HTML file with its style and script inline, no library, no network
 * beyond the server it came from. With data embedded it is a snapshot a person can keep.
 */
import type { Report } from "./data.js";
import { REPORT } from "../config.js";
import { LEFT_FOR_YOU } from "./data.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function reportPage(snapshot: Report | null): string {
  const embedded = snapshot ? `<script id="data" type="application/json">${JSON.stringify(snapshot).replace(/</g, "\\u003c")}</script>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>jev-job-search</title>
<style>
  :root { --ink: #16181d; --muted: #6b7280; --line: #e5e7eb; --bg: #fafafa; --card: #fff; --accent: #2563eb; --good: #16a34a; --warn: #d97706; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e5e7eb; --muted: #9ca3af; --line: #2a2f3a; --bg: #0f1115; --card: #171a21; --accent: #60a5fa; --good: #4ade80; --warn: #fbbf24; } }
  * { box-sizing: border-box; } body { margin: 0; font: 14px/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); }
  header { padding: 18px 24px 8px; display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; } h1 { font-size: 18px; margin: 0; } .sub { color: var(--muted); }
  main { padding: 0 24px 40px; max-width: 1400px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 12px 0 18px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; } .card .n { font-size: 26px; font-weight: 600; } .card .l { color: var(--muted); font-size: 12px; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .chart h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .bar { display: grid; grid-template-columns: 150px 1fr 40px; gap: 8px; align-items: center; font-size: 13px; margin: 3px 0; } .bar i { display: block; height: 10px; border-radius: 5px; background: var(--accent); } .bar b { font-weight: 500; text-align: right; color: var(--muted); }
  .tabs { display: flex; gap: 6px; margin: 6px 0 10px; flex-wrap: wrap; } .tabs button { border: 1px solid var(--line); background: var(--card); color: var(--ink); padding: 6px 12px; border-radius: 999px; cursor: pointer; } .tabs button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  input[type=search] { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); min-width: 260px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; } th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-size: 12px; color: var(--muted); font-weight: 600; cursor: pointer; white-space: nowrap; } tr:last-child td { border-bottom: 0; }
  td.n { white-space: nowrap; } a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  select, textarea { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); padding: 4px 6px; } textarea { width: 100%; min-height: 34px; }
  .status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--line); white-space: nowrap; } .status.applied { background: color-mix(in srgb, var(--good) 20%, transparent); color: var(--good); } .status.needs { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .saved { color: var(--good); font-size: 12px; margin-left: 6px; } .static { color: var(--muted); font-size: 12px; }
  @media (max-width: 700px) { header, main { padding-left: 16px; padding-right: 16px; } .bar { grid-template-columns: 100px 1fr 32px; } }
</style></head>
<body>
<header><h1>jev-job-search</h1><span class="sub" id="when"></span><span class="static" id="mode"></span></header>
<main>
  <div class="cards" id="cards"></div>
  <div class="charts">
    <div class="card chart"><h3>Applications per day</h3><div id="byDay"></div></div>
    <div class="card chart"><h3>Sent, by job board</h3><div id="byBoard"></div></div>
    <div class="card chart"><h3>Every job considered, by status</h3><div id="byStatus"></div></div>
  </div>
  <div class="tabs" id="tabs"></div>
  <p><input type="search" id="q" placeholder="Filter by company, role, board, reason"> <span class="sub" id="count"></span></p>
  <table id="table"><thead></thead><tbody></tbody></table>
</main>
${embedded}
<script>
(() => {
  const STATUSES = ${JSON.stringify(REPORT.statuses)};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const embedded = document.getElementById("data");
  const live = !embedded;
  const LEFT = ${JSON.stringify(LEFT_FOR_YOU)};
  const TABS = [
    { key: "applied", label: "Applied", keep: (r) => r.status_key === "applied" },
    { key: "waiting", label: "Waiting for you", keep: (r) => r.status_key === "awaiting_user_action" || r.status_key === "submission_unknown" },
    { key: "manual", label: "Left for you", keep: (r) => LEFT.includes(r.status_key) },
    { key: "takehome", label: "Take-home", keep: (r) => !!r.takehome_link },
    { key: "queued", label: "Queued", keep: (r) => r.status_key === "queued" },
    { key: "all", label: "Everything", keep: () => true },
  ];
  let data = null, tab = "applied", sortKey = "applied_on", sortDir = -1, q = "";
  const statusClass = (k) => k === "applied" ? "applied" : LEFT.includes(k) ? "needs" : "";
  const bars = (el, obj, max) => { el.innerHTML = Object.entries(obj).slice(0, 10).map(([k, v]) => '<div class="bar"><span title="' + esc(k) + '">' + esc(k) + '</span><i style="width:' + Math.max(2, 100 * v / max) + '%"></i><b>' + v + '</b></div>').join("") || '<span class="sub">nothing yet</span>'; };
  function render() {
    const t = data.totals;
    $("#when").textContent = "as of " + new Date(data.generatedAt).toLocaleString();
    $("#mode").textContent = live ? "" : "snapshot: statuses cannot be changed here";
    $("#cards").innerHTML = [["Applied", t.applied], ["Today", t.appliedToday], ["Unconfirmed", t.unconfirmed], ["Waiting for you", t.waitingForYou], ["Left for you", t.leftForYou], ["Queued", t.queued], ["Skipped", t.skipped], ["Considered", t.considered]].map(([l, n]) => '<div class="card"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join("");
    bars($("#byDay"), Object.fromEntries(data.byDay.map((d) => [d.day, d.applied])), Math.max(1, ...data.byDay.map((d) => d.applied)));
    bars($("#byBoard"), data.byBoard, Math.max(1, ...Object.values(data.byBoard)));
    bars($("#byStatus"), data.byStatus, Math.max(1, ...Object.values(data.byStatus)));
    $("#tabs").innerHTML = TABS.map((x) => '<button class="' + (x.key === tab ? "on" : "") + '" data-tab="' + x.key + '">' + x.label + " (" + data.rows.filter(x.keep).length + ")</button>").join("");
    const keep = TABS.find((x) => x.key === tab).keep;
    const needle = q.toLowerCase();
    let rows = data.rows.filter(keep).filter((r) => !needle || [r.company, r.role, r.ats, r.skip_reason, r.location, r.status].join(" ").toLowerCase().includes(needle));
    rows.sort((a, b) => String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? "")) * sortDir || String(a.company).localeCompare(String(b.company)));
    $("#count").textContent = rows.length + " row" + (rows.length === 1 ? "" : "s");
    const cols = [["applied_on", "Date"], ["company", "Company"], ["role", "Role"], ["location", "Location"], ["ats", "Board"], ["fit_score", "Fit"], ["status", "Status"], ["skip_reason", "Reason"], ["notes", "Notes"]];
    $("#table thead").innerHTML = "<tr>" + cols.map(([k, l]) => '<th data-sort="' + k + '">' + l + (sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : "") + "</th>").join("") + "</tr>";
    $("#table tbody").innerHTML = rows.map((r) => {
      // A status the page does not offer (a run's own, or one waiting on you) is shown as it is, never as "queued".
      const current = r.status_key;
      const other = STATUSES.includes(current) ? "" : '<option value="" selected disabled>' + esc(r.status.replace(/:.*$/, "")) + "</option>";
      const pick = live ? '<select data-id="' + esc(r.job_id) + '">' + other + STATUSES.map((s) => '<option value="' + s + '"' + (s === current ? " selected" : "") + ">" + s.replace("_", " ") + "</option>").join("") + "</select>" : "";
      return "<tr>" +
        '<td class="n">' + esc(r.applied_on) + "</td>" +
        "<td>" + esc(r.company) + "</td>" +
        "<td><a href=\\"" + esc(r.job_link) + "\\" target=\\"_blank\\" rel=\\"noopener\\">" + esc(r.role) + "</a>" + (r.takehome_link ? ' <a href="' + esc(r.takehome_link) + '" target="_blank" rel="noopener">take-home</a>' : "") + "</td>" +
        "<td>" + esc(r.location) + "</td>" +
        "<td>" + esc(r.ats) + "</td>" +
        '<td class="n">' + esc(r.fit_score) + "</td>" +
        '<td><span class="status ' + statusClass(r.status_key) + '">' + esc(r.status.replace(/:.*$/, "")) + "</span><br>" + pick + '<span class="saved" id="saved-' + esc(r.job_id) + '"></span></td>' +
        "<td>" + esc(r.skip_reason || r.status.replace(/^[^:]*:\\s*/, "").replace(r.status.replace(/:.*$/, ""), "")) + "</td>" +
        "<td>" + (live ? '<textarea data-notes="' + esc(r.job_id) + '" placeholder="your notes">' + esc(r.notes) + "</textarea>" : esc(r.notes)) + "</td>" +
        "</tr>";
    }).join("") || '<tr><td colspan="9" class="sub">nothing here</td></tr>';
  }
  async function save(id, patch) {
    const res = await fetch("/api/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    const el = document.getElementById("saved-" + id);
    if (el) { el.textContent = res.ok ? "saved" : "not saved"; setTimeout(() => (el.textContent = ""), 1800); }
    if (res.ok) await load();
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; render(); } const th = e.target.closest("[data-sort]"); if (th) { if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; } render(); } });
  document.addEventListener("change", (e) => { const s = e.target.closest("select[data-id]"); if (s) save(s.dataset.id, { status: s.value }); const n = e.target.closest("textarea[data-notes]"); if (n) save(n.dataset.notes, { notes: n.value }); });
  $("#q").addEventListener("input", (e) => { q = e.target.value; render(); });
  async function load() { data = live ? await (await fetch("/api/data")).json() : JSON.parse(embedded.textContent); render(); }
  load();
})();
</script>
</body></html>`;
}

export const escapeForTitle = esc;
