/**
 * The dashboard page: one HTML file with its style and script inline, no library, no network
 * beyond the server it came from. With data embedded it is a snapshot a person can keep.
 */
import type { Report } from "./data.js";
import { REPORT } from "../config.js";
import { LEFT_FOR_YOU } from "./data.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The page. With a snapshot it is a file to keep, read-only. Without one it is live, and `token` is what lets it send a change back. */
export function reportPage(snapshot: Report | null, token = ""): string {
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
  nav { display: flex; gap: 6px; padding: 0 24px; border-bottom: 1px solid var(--line); } nav button { border: 0; background: none; color: var(--muted); padding: 10px 14px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; } nav button.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .screen { display: none; padding-top: 16px; } .screen.on { display: block; }
  .item { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; } .item h4 { margin: 0 0 4px; font-size: 15px; } .item p { margin: 4px 0; } .item .q { margin: 10px 0 4px; font-weight: 600; }
  .item input[type=text], .item input[type=number], .item input[type=time], .item textarea, .item select { width: 100%; max-width: 640px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); font: inherit; }
  .btn { border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 7px 14px; border-radius: 8px; cursor: pointer; font: inherit; margin: 8px 8px 0 0; } .btn.quiet { background: none; color: var(--accent); } .btn:disabled { opacity: .5; cursor: default; }
  .line { font-size: 20px; font-weight: 600; margin: 4px 0 12px; } h2 { font-size: 15px; margin: 22px 0 10px; } .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 20px; } .grid2 label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
  .note { color: var(--muted); font-size: 13px; } .warn { color: var(--warn); }
  @media (max-width: 700px) { header, main { padding-left: 16px; padding-right: 16px; } .bar { grid-template-columns: 100px 1fr 32px; } }
</style></head>
<body>
<header><h1>jev-job-search</h1><span class="sub" id="when"></span><span class="static" id="mode"></span></header>
<nav id="nav"></nav>
<main>
  <section class="screen" id="s-today">
    <div class="line" id="todayLine"></div>
    <div class="cards" id="cards"></div>
    <div class="charts">
      <div class="card chart"><h3>Applications per day</h3><div id="byDay"></div></div>
      <div class="card chart"><h3>Sent, by job board</h3><div id="byBoard"></div></div>
      <div class="card chart"><h3>Every job considered, by status</h3><div id="byStatus"></div></div>
    </div>
  </section>
  <section class="screen" id="s-needs"><div id="needs"></div></section>
  <section class="screen" id="s-apps">
    <div class="tabs" id="tabs"></div>
    <p><input type="search" id="q" placeholder="Filter by company, role, board, reason"> <span class="sub" id="count"></span></p>
    <table id="table"><thead></thead><tbody></tbody></table>
  </section>
  <section class="screen" id="s-auto"><div id="auto"></div></section>
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
    { key: "waiting", label: "Waiting for you", keep: (r) => r.status_key === "awaiting_user_action" || r.status_key === "awaiting_email_verification" || r.status_key === "submission_unknown" },
    { key: "manual", label: "Left for you", keep: (r) => LEFT.includes(r.status_key) },
    { key: "takehome", label: "Take-home", keep: (r) => !!r.takehome_link },
    { key: "queued", label: "Queued", keep: (r) => r.status_key === "queued" },
    { key: "all", label: "Everything", keep: () => true },
  ];
  const TOKEN = ${JSON.stringify(token)};
  const SCREENS = live ? [["today", "Today"], ["needs", "Needs you"], ["apps", "Applications"], ["auto", "Automation"]] : [["today", "Today"], ["apps", "Applications"]];
  let data = null, needs = null, auto = null, screen = "today", tab = "applied", sortKey = "applied_on", sortDir = -1, q = "";
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-jev-token": TOKEN }, body: JSON.stringify(body) });
  const needCount = () => needs ? needs.waiting.length + needs.questions.length + needs.unconfirmed.length + needs.mail.length : 0;
  function renderNav() {
    $("#nav").innerHTML = SCREENS.map(([k, l]) => '<button class="' + (k === screen ? "on" : "") + '" data-screen="' + k + '">' + l + (k === "needs" && needCount() ? " (" + needCount() + ")" : "") + "</button>").join("");
    for (const [k] of SCREENS) $("#s-" + k).classList.toggle("on", k === screen);
  }
  const KINDS = { confirmation: "received your application", rejection: "said no", assessment: "sent an assessment", interview: "asked for an interview", offer: "made an offer" };
  function renderNeeds() {
    if (!needs) return;
    const out = [];
    if (!needCount()) out.push('<p class="note">Nothing needs you right now.</p>');
    if (needs.questions.length) out.push("<h2>Questions only you can answer</h2>");
    for (const j of needs.questions) {
      const ask = j.items.filter((x) => x.kind === "ask");
      out.push('<div class="item" data-job="' + esc(j.id) + '"><h4>' + esc(j.company) + " needs " + (j.items.length === 1 ? "one answer" : j.items.length + " answers") + '</h4><p class="note"><a href="' + esc(j.link) + '" target="_blank" rel="noopener">' + esc(j.title) + "</a></p>" +
        j.items.map((x, n) => '<p class="q">' + esc(x.question) + "</p>" + (x.kind !== "ask" ? '<p class="note warn">' + esc(x.note) + "</p>" :
          (x.options.length ? '<select data-q="' + n + '"><option value="">Choose</option>' + x.options.map((o) => "<option>" + esc(o) + "</option>").join("") + "</select>" : '<textarea data-q="' + n + '" placeholder="Your answer, in your own words"></textarea>') +
          '<p class="note"><label><input type="checkbox" data-keep="' + n + '"> Remember for future applications</label></p>')).join("") +
        (ask.length ? '<button class="btn" data-answer="' + esc(j.id) + '">Save for next run</button><span class="saved" id="saved-' + esc(j.id) + '"></span><p class="note">Nothing is sent now. The job goes back in the queue, and your next /apply or daily run fills it with this answer.</p>' : "") + "</div>");
    }
    if (needs.waiting.length) out.push("<h2>Forms open and waiting for you</h2>");
    for (const w of needs.waiting) out.push('<div class="item"><h4>' + esc(w.company) + ": " + esc(w.todo) + '</h4><p class="note">' + esc(w.title) + "</p><p>" + esc(w.reason) + "</p>" +
      (w.open ? '<button class="btn" data-show="' + esc(w.id) + '">Show the form</button>' : '<span class="note">Its window was closed. It is on your by-hand list.</span>') +
      (w.mail ? '<a class="btn quiet" href="' + esc(w.mail) + '" target="_blank" rel="noopener">Find the email</a>' : "") +
      '<p class="note">Do it in the tool\u2019s Chrome window, then type /resume in Claude Code.</p></div>');
    if (needs.unconfirmed.length) out.push("<h2>Clicked, and no confirmation seen</h2>");
    for (const u of needs.unconfirmed) out.push('<div class="item"><h4>' + esc(u.company) + '</h4><p class="note"><a href="' + esc(u.link) + '" target="_blank" rel="noopener">' + esc(u.title) + '</a></p><p>Look for a confirmation email from them. It is never sent again until you say which it was.</p><span class="saved" id="saved-' + esc(u.id) + '"></span><button class="btn" data-set="' + esc(u.id) + '" data-to="applied">I got a confirmation</button><button class="btn quiet" data-set="' + esc(u.id) + '" data-to="queued">It was not sent. Try again</button></div>');
    if (needs.mail.length) out.push("<h2>Emails the tool could not place</h2>");
    for (const m of needs.mail) out.push('<div class="item" data-mail="' + esc(m.id) + '"><h4>' + esc(m.subject) + '</h4><p class="note">From ' + esc(m.from) + ", " + esc(m.on) + ". " + esc(m.why) + "</p>" +
      '<div class="grid2"><div><label>Which application</label><select data-mjob>' + '<option value="">Choose</option>' + m.jobs.map((j) => '<option value="' + esc(j.id) + '">' + esc(j.company) + " | " + esc(j.title) + "</option>").join("") + "</select></div>" +
      "<div><label>What it says</label><select data-mkind>" + Object.entries(KINDS).map(([k, l]) => '<option value="' + k + '"' + (k === m.kind ? " selected" : "") + ">They " + l + "</option>").join("") + "</select></div></div>" +
      '<button class="btn" data-mail-ok="' + esc(m.id) + '">Save</button><button class="btn quiet" data-mail-no="' + esc(m.id) + '">Not about an application</button></div>');
    $("#needs").innerHTML = out.join("");
  }
  const list = (v) => (v || []).join(", ");
  function renderAuto() {
    if (!auto) return;
    const p = auto.policy || auto.defaults, L = auto.limits, sch = auto.schedule;
    const last = auto.today.length ? auto.today[auto.today.length - 1] : null;
    $("#auto").innerHTML =
      '<div class="item"><h4>Apply automatically</h4>' +
      '<p><label><input type="checkbox" id="autoOn"' + (sch.on ? " checked" : "") + (auto.policy ? "" : " disabled") + '> Run every day at </label> <input type="time" id="autoAt" value="' + esc(sch.at) + '" style="width:auto"> <span class="note">' + esc(auto.timezone) + "</span></p>" +
      (sch.on && sch.next ? "<p>Next run: <b>" + esc(new Date(sch.next).toLocaleString()) + "</b></p>" : '<p class="note">' + (auto.policy ? "Off. Nothing runs by itself." : "Save your daily rules below first.") + "</p>") +
      '<p class="note">Your Mac has to be on and you signed in at that time. The tool\u2019s Chrome window opens while it works.</p>' +
      (sch.on ? '<button class="btn quiet" id="autoPause">Pause future runs</button>' : "") +
      (auto.running ? (auto.stopAsked ? '<p class="warn">A run is working now and was asked to stop. It finishes the application it is on.</p>' : '<p>A run is working now. <button class="btn quiet" id="autoStop">Stop it after this application</button></p>') : "") +
      (sch.on ? '<p class="note">Pausing removes the schedule. It does not stop a run that is already working.</p>' : "") + '<span class="saved" id="saved-auto"></span></div>' +
      '<div class="item"><h4>Your daily rules</h4>' + (auto.policyError ? '<p class="warn">' + esc(auto.policyError) + "</p>" : "") +
      '<div class="grid2">' +
      '<div><label>Applications a day (at most ' + L.maxTarget + ')</label><input type="number" id="pTarget" min="1" max="' + L.maxTarget + '" value="' + esc(p.target) + '"></div>' +
      '<div><label>Most JEV may cost in a day, in dollars (JEV only: Claude is on your subscription or your own key, and is not counted)</label><input type="number" id="pBudget" min="0" step="0.05" value="' + esc(p.jevBudgetUsd) + '"></div>' +
      '<div><label>Lowest fit score, 0 to 1</label><input type="number" id="pScore" min="0" max="1" step="0.05" value="' + esc(p.minScore) + '"></div>' +
      '<div><label>Where: vancouver, canada, remote, us, international (empty: anywhere)</label><input type="text" id="pWhere" value="' + esc(list(p.where)) + '"></div>' +
      '<div><label>Kinds: internship, new_grad (empty: both)</label><input type="text" id="pLevels" value="' + esc(list(p.levels)) + '"></div>' +
      '<div><label>Boards: greenhouse, lever, ashby, workday (empty: all)</label><input type="text" id="pBoards" value="' + esc(list(p.boards)) + '"></div>' +
      '<div><label>Employers never to apply to</label><input type="text" id="pExclude" value="' + esc(list(p.excludeEmployers)) + '"></div>' +
      '<div><label>Documents</label><label><input type="checkbox" id="pTailor"' + (p.documents.tailor ? " checked" : "") + '> A resume written for each job</label><label><input type="checkbox" id="pCover"' + (p.documents.cover ? " checked" : "") + "> A cover letter where a form has a box for one</label></div>" +
      '</div><button class="btn" id="pSave">Save rules</button><span class="saved" id="saved-policy"></span>' +
      '<p class="note">A run reads these rules when it starts. A change you save while one is working applies from the next run.</p>' +
      '<p class="note">Fixed limits, the same for everyone: at most ' + L.perBoard + " a day to one job board, " + L.perEmployerPerDay + " a day to one employer, " + L.gapMinutes[0] + " to " + L.gapMinutes[1] + " minutes between two applications to one board, and a run of at most " + L.maxMinutes + " minutes. A board that asks whether a person is there is left alone until tomorrow.</p></div>" +
      '<div class="item"><h4>Today</h4>' + (last ? '<p class="line">' + esc(last.sent.length + " submitted. " + (last.waiting.length + last.unconfirmed.length) + " need you. " + last.leftForYou.length + " could not be sent.") + '</p><p class="note">Stopped because ' + esc(last.stoppedBecause) + ". JEV today: $" + Number(last.jevUsd).toFixed(4) + "</p>" : '<p class="note">No daily run yet today.</p>') + "</div>";
  }
  const words = (id) => $("#" + id).value.split(",").map((x) => x.trim()).filter(Boolean);
  async function act(path, body, savedId) {
    const res = await post(path, body);
    const el = savedId && document.getElementById(savedId);
    let said = res.ok ? "saved" : "not saved";
    if (!res.ok) { try { said = (await res.json()).error || said; } catch (e) {} }
    if (el) { el.textContent = said; setTimeout(() => (el.textContent = ""), 2500); }
    if (res.ok) await load();
    return res.ok;
  }
  const statusClass = (k) => k === "applied" ? "applied" : LEFT.includes(k) ? "needs" : "";
  const bars = (el, obj, max) => { el.innerHTML = Object.entries(obj).slice(0, 10).map(([k, v]) => '<div class="bar"><span title="' + esc(k) + '">' + esc(k) + '</span><i style="width:' + Math.max(2, 100 * v / max) + '%"></i><b>' + v + '</b></div>').join("") || '<span class="sub">nothing yet</span>'; };
  function render() {
    const t = data.totals;
    $("#when").textContent = "as of " + new Date(data.generatedAt).toLocaleString();
    $("#mode").textContent = live ? "" : "snapshot: statuses cannot be changed here";
    $("#todayLine").textContent = t.appliedToday + " sent today. " + t.waitingForYou + " waiting for you. " + t.queued + " ready to apply to.";
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
    const cols = [["applied_on", "Date"], ["company", "Company"], ["role", "Role"], ["location", "Location"], ["ats", "Board"], ["fit_score", "Fit"], ["status", "Status"], ["response", "Reply"], ["skip_reason", "Reason"], ["notes", "Notes"]];
    $("#table thead").innerHTML = "<tr>" + cols.map(([k, l]) => '<th data-sort="' + k + '">' + l + (sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : "") + "</th>").join("") + "</tr>";
    $("#table tbody").innerHTML = rows.map((r) => {
      // A status the page does not offer (a run's own, or one waiting on you) is shown as it is, never as "queued".
      const current = r.status_key;
      const other = STATUSES.includes(current) ? "" : '<option value="" selected disabled>' + esc(r.status.replace(/:.*$/, "")) + "</option>";
      const pick = live ? '<select data-id="' + esc(r.job_id) + '" data-was="' + esc(current) + '">' + other + STATUSES.map((s) => '<option value="' + s + '"' + (s === current ? " selected" : "") + ">" + s.replace("_", " ") + "</option>").join("") + "</select>" : "";
      return "<tr>" +
        '<td class="n">' + esc(r.applied_on) + "</td>" +
        "<td>" + esc(r.company) + "</td>" +
        "<td><a href=\\"" + esc(r.job_link) + "\\" target=\\"_blank\\" rel=\\"noopener\\">" + esc(r.role) + "</a>" + (r.takehome_link ? ' <a href="' + esc(r.takehome_link) + '" target="_blank" rel="noopener">take-home</a>' : "") + "</td>" +
        "<td>" + esc(r.location) + "</td>" +
        "<td>" + esc(r.ats) + "</td>" +
        '<td class="n">' + esc(r.fit_score) + "</td>" +
        '<td><span class="status ' + statusClass(r.status_key) + '">' + esc(r.status.replace(/:.*$/, "")) + "</span><br>" + pick + '<span class="saved" id="saved-' + esc(r.job_id) + '"></span></td>' +
        '<td class="n">' + (r.response ? esc(r.response) + "<br><span class=\\"sub\\">" + esc(r.response_on) + "</span>" : "") + "</td>" +
        "<td>" + esc(r.skip_reason || r.status.replace(/^[^:]*:\\s*/, "").replace(r.status.replace(/:.*$/, ""), "")) + "</td>" +
        "<td>" + (live ? '<textarea data-notes="' + esc(r.job_id) + '" placeholder="your notes">' + esc(r.notes) + "</textarea>" : esc(r.notes)) + "</td>" +
        "</tr>";
    }).join("") || '<tr><td colspan="10" class="sub">nothing here</td></tr>';
  }
  const save = (id, patch) => act("/api/status", { id, ...patch }, "saved-" + id);
  document.addEventListener("click", async (e) => {
    const t = e.target;
    const nav = t.closest("[data-screen]"); if (nav) { screen = nav.dataset.screen; renderNav(); return; }
    const b = t.closest("[data-tab]"); if (b) { tab = b.dataset.tab; render(); return; }
    const th = t.closest("[data-sort]"); if (th) { if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; } render(); return; }
    const show = t.closest("[data-show]"); if (show) { const r = await post("/api/show", { id: show.dataset.show }); const ok = r.ok && (await r.json()).ok; show.textContent = ok ? "It is in front now" : "Its window is closed"; return; }
    const set = t.closest("[data-set]"); if (set) { await act("/api/status", { id: set.dataset.set, status: set.dataset.to, was: "submission_unknown" }); return; }
    const ans = t.closest("[data-answer]");
    if (ans) {
      const box = ans.closest("[data-job]");
      const job = needs.questions.find((j) => j.id === ans.dataset.answer);
      const answers = [...box.querySelectorAll("[data-q]")].map((el) => ({ question: job.items[Number(el.dataset.q)].question, answer: el.value.trim(), remember: !!box.querySelector('[data-keep="' + el.dataset.q + '"]').checked })).filter((a) => a.answer);
      if (!answers.length) { document.getElementById("saved-" + job.id).textContent = "type an answer first"; return; }
      await act("/api/answer", { id: job.id, answers }, "saved-" + job.id);
      return;
    }
    const mok = t.closest("[data-mail-ok]"); if (mok) { const box = mok.closest("[data-mail]"); const jobId = box.querySelector("[data-mjob]").value; if (!jobId) return; await act("/api/mail", { id: mok.dataset.mailOk, jobId, kind: box.querySelector("[data-mkind]").value }); return; }
    const mno = t.closest("[data-mail-no]"); if (mno) { await act("/api/mail", { id: mno.dataset.mailNo }); return; }
    if (t.id === "pSave") { await act("/api/policy", { target: Number($("#pTarget").value), jevBudgetUsd: Number($("#pBudget").value), minScore: Number($("#pScore").value), where: words("pWhere"), levels: words("pLevels"), boards: words("pBoards"), excludeEmployers: words("pExclude"), documents: { tailor: $("#pTailor").checked, cover: $("#pCover").checked } }, "saved-policy"); return; }
    if (t.id === "autoPause") { await act("/api/schedule", { on: false }, "saved-auto"); return; }
    if (t.id === "autoStop") { await act("/api/stop", {}, "saved-auto"); return; }
  });
  document.addEventListener("change", (e) => { if (e.target.id === "autoOn" || (e.target.id === "autoAt" && $("#autoOn").checked)) act("/api/schedule", { on: $("#autoOn").checked, at: $("#autoAt").value }, "saved-auto"); });
  document.addEventListener("change", (e) => { const s = e.target.closest("select[data-id]"); if (s) save(s.dataset.id, { status: s.value, was: s.dataset.was }); const n = e.target.closest("textarea[data-notes]"); if (n) save(n.dataset.notes, { notes: n.value }); });
  $("#q").addEventListener("input", (e) => { q = e.target.value; render(); });
  async function load() {
    data = live ? await (await fetch("/api/data")).json() : JSON.parse(embedded.textContent);
    if (live) { needs = await (await fetch("/api/needs")).json(); auto = await (await fetch("/api/automation")).json(); }
    render(); renderNeeds(); renderAuto(); renderNav();
  }
  load();
})();
</script>
</body></html>`;
}

export const escapeForTitle = esc;
