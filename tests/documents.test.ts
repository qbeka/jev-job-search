import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/profile/schema.js";
import { machineTells, Tailored, resumeMarkdown, trimOnce, unsupportedClaims } from "../src/documents/tailor.js";
import { coverHtml, escapeHtml, pdfPages, resumeHtml } from "../src/documents/render.js";
import { fileBoxWants } from "../src/forms/mapForm.js";

const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
const first = profile.experience[0]!;
const project = profile.projects[0]!;

const draft = (): Tailored =>
  Tailored.parse({
    headline: "Software Engineer Intern",
    summary: `${profile.summary.slice(0, 120)}. Built for this role.`,
    skills: [profile.skills.languages[0], profile.skills.frameworks[0], profile.skills.tools[0]],
    experience: [{ company: first.company, title: first.title, bullets: [first.bullets[0]] }],
    projects: project ? [{ name: project.name, bullets: [project.bullets[0], project.bullets[0]] }] : [],
    coverLetter: { greeting: "Dear Hiring Team,", paragraphs: ["I am applying for the Software Engineer Intern role at Acme Robotics, which builds warehouse robots.", `${first.bullets[0]} That is the work I want to keep doing.`], closing: "Sincerely," },
  });

describe("the truth gate on a tailored draft", () => {
  it("passes a draft made only of the profile's own words", () => {
    expect(unsupportedClaims(draft(), profile, "Acme Robotics Software Engineer Intern warehouse robots")).toEqual([]);
  });
  it("names a number, a tool and a job the profile does not hold", () => {
    const t = draft();
    t.summary = "Cut latency by 97% with Kubernetes at Globex.";
    t.experience.push({ company: "Globex", title: "Engineer", bullets: ["Ran the Kubernetes cluster for 400 services."] });
    const claims = unsupportedClaims(t, profile, "");
    expect(claims).toContain("97%");
    expect(claims).toContain("Kubernetes");
    expect(claims).toContain("job at Globex");
    expect(claims).toContain("400");
  });
  it("lets the cover letter name the company and the posting's words, and nothing else", () => {
    const t = draft();
    t.coverLetter!.paragraphs[0] = "Acme Robotics builds warehouse robots, and I would bring Terraform to it.";
    const claims = unsupportedClaims(t, profile, "Acme Robotics warehouse robots");
    expect(claims).toEqual(["Terraform"]);
  });
  it("knows a plural, a thousands separator and a phrase made of the profile's own words", () => {
    const t = draft();
    t.skills.push(`${profile.skills.frameworks[0]}s`);
    t.summary = `Wrote ${first.bullets[0]} Reached 18,000+ people.`;
    const rich = { ...profile, facts: [...profile.facts, "Reached 18,000 people with it."] };
    expect(unsupportedClaims(t, rich, "Acme Robotics warehouse robots")).toEqual([]);
  });
  it("refuses a skill the profile does not list", () => {
    const t = draft();
    t.skills.push("Rust");
    expect(unsupportedClaims(t, profile, "")).toContain("Rust");
  });
});

describe("a cover letter that reads as machine-written", () => {
  it("names the stock phrases, the dash and the long sentence, and passes plain writing", () => {
    const t = draft();
    expect(machineTells(t)).toEqual([]);
    t.coverLetter!.paragraphs[0] = "I am excited to apply, and my background aligns with your mission \u2014 truly.";
    const tells = machineTells(t);
    expect(tells).toContain('the phrase "i am excited"');
    expect(tells).toContain('the phrase "aligns with"');
    expect(tells).toContain("a dash used as punctuation");
    t.coverLetter!.paragraphs[0] = Array.from({ length: 40 }, () => "word").join(" ") + ".";
    expect(machineTells(t).some((x) => x.includes("sentence(s) over"))).toBe(true);
  });
});

describe("trimming a resume that runs long", () => {
  it("drops the last project bullet first, then a job bullet, then gives up", () => {
    const t = draft();
    const once = trimOnce(t)!;
    expect(once.projects[0]!.bullets).toHaveLength(1);
    const twice = trimOnce(once);
    expect(twice).toBeNull();
  });
});

describe("rendering", () => {
  it("escapes what it prints and keeps the profile's dates", () => {
    const t = draft();
    t.headline = "<b>Intern</b> & more";
    const html = resumeHtml(profile, t);
    expect(html).toContain("&lt;b&gt;Intern&lt;/b&gt; &amp; more");
    expect(html).toContain("May 2026");
    expect(html).toContain(profile.email);
    expect(resumeMarkdown(profile, t)).toContain(`**${first.title}**, ${first.company}`);
  });
  it("prints the cover letter with the company and the closing", () => {
    const entry = { job: { id: "x", company: "Acme Robotics", title: "Software Engineer Intern" } } as never;
    const html = coverHtml(profile, entry, draft());
    expect(html).toContain("Acme Robotics");
    expect(html).toContain("Sincerely,");
    const name = `${profile.name.first} ${profile.name.last}`;
    const t = draft();
    t.coverLetter!.closing = `Thanks for your time, ${name}`;
    expect(coverHtml(profile, entry, t)).toContain(`Thanks for your time,<br>${name}`);
  });
  it("counts pages in a PDF", () => {
    expect(pdfPages(Buffer.from("%PDF-1.4 1 0 obj << /Type /Pages /Kids [] >> 2 0 obj << /Type /Page >> 3 0 obj << /Type /Page >>"))).toBe(2);
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });
});

describe("a cover letter box", () => {
  it("is told from the resume box and other files", () => {
    const box = (label: string) => ({ label, name: "", hint: "", selector: "#x" });
    expect(fileBoxWants(box("Cover Letter (Attach)"))).toBe("cover");
    expect(fileBoxWants(box("Resume/CV"))).toBe("resume");
    expect(fileBoxWants(box("Portfolio"))).toBe("other");
  });
});
