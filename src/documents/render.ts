/**
 * The tailored documents as pages: plain HTML with system fonts, printed to PDF by the runner's
 * own Chrome over the DevTools protocol. No LaTeX, no library. Everything from the profile and
 * the writer is escaped before it reaches the page.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BROWSER, childEnv, DOCUMENTS, PATHS } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import type { Tailored } from "./tailor.js";
import { renderTemplate, type View } from "./template.js";
import { activeTemplate } from "./templates.js";

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** "2026-05" or "2026-05-01" as "May 2026"; anything else as it is. */
export const prettyMonth = (s: string) => {
  const m = /^(\d{4})-(\d{2})/.exec(s.trim());
  if (!m) return s;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
};
const span = (start: string, end: string, current: boolean) => `${prettyMonth(start)} to ${current ? "present" : prettyMonth(end)}`;

const monthYear = (month: number, year: number) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] ?? ""} ${year}`.trim();

/** Everything a resume template may print, already in words: dates as "May 2026", the contact line joined. */
export function resumeView(profile: Profile, t: Tailored): View {
  const exp = t.experience.map((e) => {
    const src = profile.experience.find((x) => x.company.toLowerCase().includes(e.company.toLowerCase()) || e.company.toLowerCase().includes(x.company.toLowerCase()));
    return { title: e.title, company: e.company, location: src?.location ?? "", when: src ? span(src.start, src.end, src.current) : "", bullets: e.bullets };
  });
  const projects = t.projects.map((p) => {
    const src = profile.projects.find((x) => x.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(x.name.toLowerCase()));
    return { name: p.name, role: src?.role ?? "", link: src?.link ? src.link.replace(/^https?:\/\/(www\.)?/, "") : "", when: src ? span(src.start, src.end, /present|current|now/i.test(src.end) || !src.end) : "", bullets: p.bullets };
  });
  const education = profile.education.map((e) => ({ degree: e.degree, field: e.field, minor: e.minor ?? "", school: e.school, when: `${e.startYear} to ${e.status === "in_progress" ? "expected " : ""}${monthYear(e.gradMonth, e.gradYear)}` }));
  return {
    name: `${profile.name.first} ${profile.name.last}`,
    headline: t.headline,
    contact: contactText(profile),
    summary: t.summary,
    skills: t.skills.join(" \u00b7 "),
    skillList: t.skills,
    experience: exp,
    projects,
    education,
  };
}

/** Everything a cover letter template may print. */
export function coverView(profile: Profile, entry: { job: { company: string; title: string } }, t: Tailored): View {
  const letter = t.coverLetter;
  if (!letter) throw new Error("no cover letter was written");
  const name = `${profile.name.first} ${profile.name.last}`;
  const stripped = letter.closing.replace(new RegExp(`[,\\s]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s*$`, "i"), "").trim();
  return {
    name,
    contact: contactText(profile),
    date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    company: entry.job.company,
    role: entry.job.title,
    greeting: letter.greeting,
    paragraphs: letter.paragraphs,
    closing: stripped ? (stripped.endsWith(",") ? stripped : `${stripped},`) : "Sincerely,",
  };
}

const contactText = (profile: Profile) => {
  const bits = [profile.email, `${profile.phone.countryCode} ${profile.phone.national}`, `${profile.address.city}, ${profile.address.regionCode || profile.address.region}`];
  const links = Object.entries(profile.links ?? {}).filter(([, v]) => typeof v === "string" && v) as [string, string][];
  for (const [, url] of links) bits.push(url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
  return bits.join(" \u00b7 ");
};

/** The resume through the template in use. */
export function resumeHtml(profile: Profile, t: Tailored): string {
  return renderTemplate(readFileSync(activeTemplate().resume, "utf8"), resumeView(profile, t));
}

/** The cover letter through the template in use. */
export function coverHtml(profile: Profile, entry: QueueEntry, t: Tailored): string {
  const template = activeTemplate();
  if (!existsSync(template.cover)) throw new Error(`the template ${template.name} has no cover.html`);
  return renderTemplate(readFileSync(template.cover, "utf8"), coverView(profile, entry, t));
}

/** How many pages a PDF holds, from its page objects. Enough to tell one page from two. */
export const pdfPages = (pdf: Buffer) => Math.max(1, (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length);

/**
 * Prints an HTML document to a PDF file and returns its page count. A headless Chrome of its own
 * does the printing: the runner's window cannot print, and nothing else needs installing. The
 * HTML is written next to the PDF while Chrome reads it, then removed.
 */
export async function printPdf(html: string, outFile: string): Promise<number> {
  const htmlFile = outFile.replace(/\.pdf$/, "") + ".html";
  writeFileSync(htmlFile, html);
  if (existsSync(outFile)) unlinkSync(outFile);
  // Chrome writes the PDF and may then linger, so the file is watched and Chrome is stopped once it is whole.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(BROWSER.chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-pdf-header-footer", `--print-to-pdf=${outFile}`, `--user-data-dir=${path.join(PATHS.runs, "print-profile")}`, `file://${htmlFile}`], { stdio: ["ignore", "ignore", "pipe"], env: childEnv() });
    let err = "";
    let done = false;
    const finish = (fail?: Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (fail) reject(fail);
      else resolve();
    };
    let lastSize = -1;
    const poll = setInterval(() => {
      if (!existsSync(outFile)) return;
      const size = statSync(outFile).size;
      if (size > 0 && size === lastSize) finish();
      lastSize = size;
    }, 200);
    const timer = setTimeout(() => finish(new Error("printing did not finish in time")), DOCUMENTS.printTimeoutMs);
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => finish(new Error(`could not run Chrome to print: ${e.message}`)));
    child.on("close", () => {
      if (existsSync(outFile) && statSync(outFile).size > 0) finish();
      else finish(new Error(`printing failed${err ? `: ${err.trim().split("\n").pop()?.slice(0, 160)}` : ""}`));
    });
  });
  unlinkSync(htmlFile);
  return pdfPages(readFileSync(outFile));
}
