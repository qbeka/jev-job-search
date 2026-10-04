import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { QueueEntry } from "../src/jobs/queue.js";
import { loadQueue, saveQueue } from "../src/jobs/queue.js";
import { loadRows } from "../src/log/csv.js";
import { candidatesFor, companyKey, inboxQuery, kindByRules, loadInbox, outcomeOf, readInbox, type BriefClient, type MailBrief } from "../src/mail/status.js";
import { buildNeeds, questionFor, saveAnswers, Stale } from "../src/report/needs.js";
import { applyStatusChange, Busy, fromThisPage, hasToken } from "../src/report/server.js";
import { formatInbox, recordReplies, recordReply, settleReview } from "../src/run/inbox.js";

const SENT = "2026-10-01T15:00:00.000Z";
const LATER = Date.parse("2026-10-03T15:00:00.000Z");

let n = 0;
const job = (company: string, title = "Software Engineer Intern", over: Partial<QueueEntry> = {}): QueueEntry =>
  ({
    job: { id: `j${++n}`, source: "test", company, title, url: `https://jobs.example.com/${n}`, ats: "greenhouse", locations: ["Toronto, ON"], postedAt: "2026-09-28", terms: [], sponsorship: "unknown", degrees: [], category: null },
    fit: null,
    preFilterReason: null,
    status: "applied",
    statusReason: null,
    waitingFor: null,
    answers: [],
    replies: [],
    response: null,
    attempts: 1,
    discoveredAt: SENT,
    updatedAt: SENT,
    appliedAt: SENT,
    notes: null,
    ...over,
  }) as QueueEntry;
const mail = (over: Partial<MailBrief> = {}): MailBrief => ({ id: "m1", from: "no-reply@acme.com", fromName: "Acme Careers", subject: "Thank you for applying to Acme", snippet: "We have received your application for Software Engineer Intern.", receivedAt: LATER, ...over });
const client = (mails: MailBrief[]): BriefClient => ({ search: async () => mails.map((m) => m.id), brief: async (id) => mails.find((m) => m.id === id) as MailBrief });
/** A JEV that answers as told, and records what it was shown. */
const jev = (answer: string, confidence: number) => {
  const shown: unknown[] = [];
  return { shown, decide: async (state: unknown) => (shown.push(state), { kind: { type: "choice", choice: answer, confidence, probabilities: {} } }) } as never as import("../src/jev/client.js").JevClient & { shown: unknown[] };
};

let files: { queue: string; rows: string; inbox: string; profile: string };
/** A last report that left these questions open. */
const asks = (...labels: string[]) => (() => ({ reviews: labels.map((label, i) => ({ id: `f${i}`, selector: `#q${i}`, kind: "text", label, options: [], why: "required but mapped to leave blank" })), drafts: [] })) as never;
beforeEach(() => {
  n = 0;
  const dir = mkdtempSync(path.join(tmpdir(), "jev-inbox-"));
  files = { queue: path.join(dir, "queue.json"), rows: path.join(dir, "all.csv"), inbox: path.join(dir, "inbox.json"), profile: path.join(dir, "profile.json") };
});
/** Writes the queue and gives back each job's id as the queue knows it: an id is worked out from the posting's link. */
const seed = (entries: QueueEntry[]): string[] => {
  saveQueue({ version: 1, generatedAt: SENT, entries } as never, files.queue);
  return loadQueue(files.queue).entries.map((e) => e.job.id);
};

describe("what an email says", () => {
  it("tells the kinds of reply apart by their words", () => {
    expect(kindByRules("Thank you for applying to Acme", "We received your application.")).toBe("confirmation");
    expect(kindByRules("Your application to Acme", "Thank you for applying. Unfortunately we will not be moving forward.")).toBe("rejection");
    expect(kindByRules("Next steps", "We would like to schedule a 30 minute interview with you.")).toBe("interview");
    expect(kindByRules("Acme online assessment", "Please complete this HackerRank coding challenge within 5 days.")).toBe("assessment");
    expect(kindByRules("Offer", "We are pleased to offer you the position.")).toBe("offer");
    expect(kindByRules("Weekly jobs digest", "New roles you might like")).toBeNull();
    // Saying no takes the words for it. Each of these says no:
    for (const no of ["We have decided not to move forward with your application.", "We decided to not proceed.", "We have decided to move forward with other candidates.", "We are pursuing other applicants at this time.", "You were not selected for this role.", "You are no longer under consideration.", "We will not be proceeding with your candidacy."]) expect(kindByRules("Your application", no), no).toBe("rejection");
    // And each of these does not, though it shares words with one that does:
    for (const yes of ["We have decided to proceed with your application.", "We have decided to move you forward.", "We are still reviewing other candidates and will be in touch.", "You have been selected to move on to the next stage."]) expect(kindByRules("Your application", yes), yes).not.toBe("rejection");
    expect(kindByRules("Good news", "We have decided to proceed and would like to schedule an interview with you.")).toBe("interview");
    // An assessment that leads to an interview is two things at once: not for a rule to decide.
    expect(kindByRules("Next steps", "Complete the coding challenge, then we will schedule an interview with you.")).toBe("unclear");
  });

  it("matches an email to the company it names, and only to applications sent before it", () => {
    const acme = job("Acme Inc.");
    const globex = job("Globex");
    const short = job("Ro");
    expect(companyKey("Acme Technologies, Inc.")).toBe("acme");
    expect(candidatesFor(mail(), [acme, globex, short]).map((e) => e.job.id)).toEqual(["j1"]);
    expect(candidatesFor(mail({ fromName: "Recruiting", subject: "Update", snippet: "", from: "jobs@globex.com" }), [acme, globex]).map((e) => e.job.id)).toEqual(["j2"]);
    // A short name is too common a word, and an email older than the application is not about it.
    expect(candidatesFor(mail({ subject: "Ro wants you", snippet: "", fromName: "", from: "a@b.com" }), [short])).toEqual([]);
    expect(candidatesFor(mail({ receivedAt: Date.parse("2026-09-20T00:00:00Z") }), [acme])).toEqual([]);
  });

  it("asks the mailbox with a search that names nothing about the person", () => {
    expect(inboxQuery(7)).toMatch(/^newer_than:7d /);
    expect(inboxQuery(7)).not.toMatch(/@/);
  });
});

describe("reading the mailbox", () => {
  it("records what it is sure of, and only shows JEV a subject and a preview", async () => {
    const acme = job("Acme");
    const globex = job("Globex");
    seed([acme, globex]);
    const asked = jev("interview", 0.95);
    const placed = await readInbox(client([mail(), mail({ id: "m2", from: "talent@globex.com", fromName: "Globex Talent", subject: "Globex: next steps", snippet: "Could we find a time to talk this week about the role?" })]), asked, loadQueue(files.queue).entries, { file: files.inbox });
    expect(placed.map((p) => [p.kind, p.entry?.job.company, p.sure])).toEqual([["confirmation", "Acme", true], ["interview", "Globex", true]]);
    // The rule settled the first email, so JEV saw only the second, and only these two short fields of it.
    expect(asked.shown).toEqual([{ subject: "Globex: next steps", preview: "Could we find a time to talk this week about the role?" }]);
    const s = recordReplies(placed, files);
    expect(s).toMatchObject({ toConfirm: 0, ignored: 0 });
    expect(formatInbox(s)).toMatch(/2 replies recorded[\s\S]*Globex \| Software Engineer Intern: asked for an interview/);
    const now = loadQueue(files.queue).entries;
    expect(now[0]?.response).toMatchObject({ kind: "confirmation", on: "2026-10-03" });
    expect(now[1]?.response?.kind).toBe("interview");
    expect(loadRows(files.rows).find((r) => r.Company === "Globex")?.Response).toBe("interview");
    // Each email is read once.
    expect(await readInbox(client([mail()]), null, now, { file: files.inbox })).toEqual([]);
  });

  it("settles a submission that was never confirmed when the employer writes back", async () => {
    seed([job("Acme", "Software Engineer Intern", { status: "submission_unknown", statusReason: "Submit was clicked and no confirmation was seen", appliedAt: null })]);
    const s = recordReplies(await readInbox(client([mail()]), null, loadQueue(files.queue).entries, { file: files.inbox }), files);
    expect(s.recorded[0]).toMatchObject({ kind: "confirmation", settled: true });
    expect(loadQueue(files.queue).entries[0]).toMatchObject({ status: "applied", statusReason: null });
  });

  it("holds what it is not sure of for the person, and never guesses", async () => {
    const ids = seed([job("Acme", "Backend Intern"), job("Acme", "Frontend Intern"), job("Globex")]);
    const entries = loadQueue(files.queue).entries;
    const two = mail({ subject: "Your application to Acme", snippet: "Thank you for applying." });
    const vague = mail({ id: "m2", from: "talent@globex.com", fromName: "Globex", subject: "Globex update", snippet: "An update regarding your candidacy." });
    const noise = mail({ id: "m3", from: "news@jobboard.com", fromName: "Job Board", subject: "10 new jobs for you", snippet: "Apply today" });
    const placed = await readInbox(client([two, vague, noise]), jev("rejection", 0.5), entries, { file: files.inbox });
    expect(placed.map((p) => p.sure)).toEqual([false, false, true]);
    const s = recordReplies(placed, files);
    expect(s).toMatchObject({ recorded: [], toConfirm: 2, ignored: 1 });
    expect(loadQueue(files.queue).entries.every((e) => e.response === null)).toBe(true);
    const review = loadInbox(files.inbox).review;
    expect(review.map((r) => r.why)).toEqual(["you applied to 2 jobs at that company and the email names none", "the tool could not tell what it says"]);
    // The dashboard offers the applications it could be about.
    const needs = buildNeeds(loadQueue(files.queue).entries, { inboxFile: files.inbox, report: () => { throw new Error("none"); } });
    expect(needs.mail[0]?.jobs.map((j) => j.title)).toEqual(["Backend Intern", "Frontend Intern"]);
    // The person says which, and it is recorded. Saying "not about an application" records nothing.
    expect(settleReview("m1", { jobId: ids[1] as string, kind: "confirmation" }, files)).toBe(true);
    expect(settleReview("m2", null, files)).toBe(true);
    expect(settleReview("m2", null, files)).toBe(false);
    expect(loadQueue(files.queue).entries.map((e) => e.response?.kind ?? null)).toEqual([null, "confirmation", null]);
    expect(loadInbox(files.inbox).review).toEqual([]);
  });

  it("goes by when each reply came, not by the order they were read in, and keeps every one", () => {
    const day = (d: number) => Date.parse(`2026-10-${String(d).padStart(2, "0")}T15:00:00Z`);
    const at = (kind: "confirmation" | "rejection" | "assessment" | "interview" | "offer", d: number) => ({ id: `${kind}${d}`, kind, at: day(d), subject: kind });
    // A rejection after an offer replaces it. An old rejection does not undo a newer interview.
    expect(outcomeOf([at("offer", 5), at("rejection", 9)])?.kind).toBe("rejection");
    expect(outcomeOf([at("interview", 9), at("rejection", 3)])?.kind).toBe("interview");
    // "We received your application" says nothing new once the employer has said more, whenever it came.
    expect(outcomeOf([at("interview", 4), at("confirmation", 6)])?.kind).toBe("interview");
    expect(outcomeOf([at("confirmation", 2)])?.kind).toBe("confirmation");
    expect(outcomeOf([])).toBeNull();

    const [id = ""] = seed([job("Acme")]);
    const reply = (kind: "rejection" | "interview" | "confirmation", d: number) => recordReply(id, { id: `${kind}${d}`, kind, receivedAt: day(d), subject: `${kind} on the ${d}th` }, files);
    reply("confirmation", 2);
    reply("interview", 9);
    // Found in the mailbox last, though it is the oldest: an earlier role's rejection, say.
    reply("rejection", 3);
    const e = loadQueue(files.queue).entries[0];
    expect(e?.response).toEqual({ kind: "interview", on: "2026-10-09", subject: "interview on the 9th" });
    expect(e?.replies.map((r) => r.kind)).toEqual(["confirmation", "interview", "rejection"]);
    // The same email read again adds nothing.
    expect(reply("rejection", 3)).toBeNull();
    expect(loadQueue(files.queue).entries[0]?.replies).toHaveLength(3);
    // A rejection that comes after the interview does replace it.
    reply("rejection", 12);
    expect(loadQueue(files.queue).entries[0]?.response?.on).toBe("2026-10-12");
    expect(loadRows(files.rows)[0]).toMatchObject({ Response: "rejection", "Response On": "2026-10-12" });
  });

  it("names the one application whose title the email gives, and keeps a rejection over a later thank-you", async () => {
    seed([job("Acme", "Backend Intern"), job("Acme", "Frontend Intern")]);
    const no = mail({ subject: "Acme: Frontend Intern", snippet: "Unfortunately we will not be moving forward with your application." });
    recordReplies(await readInbox(client([no]), null, loadQueue(files.queue).entries, { file: files.inbox }), files);
    expect(loadQueue(files.queue).entries.map((e) => e.response?.kind ?? null)).toEqual([null, "rejection"]);
    const thanks = mail({ id: "m5", subject: "Acme: Frontend Intern", snippet: "Thank you for applying. We received your application." });
    recordReplies(await readInbox(client([thanks]), null, loadQueue(files.queue).entries, { file: files.inbox }), files);
    expect(loadQueue(files.queue).entries[1]?.response?.kind).toBe("rejection");
  });
});

describe("answering a form's open question in the dashboard", () => {
  it("offers an answer box for an ordinary question and never for the right to work or a signature", () => {
    expect(questionFor("Which team interests you most?", "select", ["Select...", "Payments", "Platform"], "required but no option fits")).toMatchObject({ kind: "ask", options: ["Payments", "Platform"], canRemember: true });
    expect(questionFor("Are you legally authorized to work in the United States?", "radio", ["Yes", "No"], "unsure")).toMatchObject({ kind: "profile", canRemember: false });
    expect(questionFor("Will you now or in the future require sponsorship?", "radio", ["Yes", "No"], "unsure").kind).toBe("profile");
    expect(questionFor("Type your full name to agree to the NDA", "text", [], "signing an agreement is for the candidate to do").kind).toBe("sign");
  });

  it("keeps an answer for one job or for every form, as the person chose, and puts the job back in the queue", () => {
    copyFileSync(path.join(__dirname, "..", "data", "profile.example.json"), files.profile);
    const before = (JSON.parse(readFileSync(files.profile, "utf8")) as { answers: unknown[] }).answers.length;
    const [id = ""] = seed([job("Acme", "Backend Intern", { status: "needs_review", statusReason: "empty: Which team interests you most?" })]);
    Object.assign(files, { report: asks("Which team interests you most?", "How did you hear about this role?", "Empty one", "Are you authorized to work in Canada?") });
    const saved = saveAnswers(id, [{ question: "Which team interests you most?", answer: "Platform", remember: false }, { question: "How did you hear about this role?", answer: "A public list of internships", remember: true }, { question: "Empty one", answer: "  ", remember: true }], files);
    expect(saved).toMatchObject({ company: "Acme", kept: 1 });
    const e = loadQueue(files.queue).entries[0];
    expect(e).toMatchObject({ status: "queued", statusReason: null, answers: [{ question: "Which team interests you most?", answer: "Platform" }] });
    const profile = JSON.parse(readFileSync(files.profile, "utf8")) as { answers: { question: string; answer: string }[] };
    expect(profile.answers).toHaveLength(before + 1);
    expect(profile.answers.at(-1)).toEqual({ question: "How did you hear about this role?", answer: "A public list of internships" });
    // The right to work is never answered here, whatever the page sends.
    expect(() => saveAnswers(id, [{ question: "Are you authorized to work in Canada?", answer: "Yes", remember: true }], files)).toThrow(/not one to answer here/);
    expect((JSON.parse(readFileSync(files.profile, "utf8")) as { answers: unknown[] }).answers).toHaveLength(before + 1);
  });

  it("changes nothing from a page that is out of date", () => {
    copyFileSync(path.join(__dirname, "..", "data", "profile.example.json"), files.profile);
    const profile = readFileSync(files.profile, "utf8");
    const answer = [{ question: "Which team?", answer: "Platform", remember: true }];
    const withReport = { ...files, report: asks("Which team?") };
    // The page showed the question while the job was set aside. Since then the job was sent, or may have been, or a run took it.
    for (const status of ["applied", "submission_unknown", "in_progress", "awaiting_user_action", "queued", "skipped"] as const) {
      const [id = ""] = seed([job("Acme", "Backend Intern", { status })]);
      expect(() => saveAnswers(id, answer, withReport), status).toThrow(Stale);
      expect(loadQueue(files.queue).entries[0], status).toMatchObject({ status, answers: [] });
    }
    // The job is still set aside, but its form was filled again and now asks something else.
    const [id = ""] = seed([job("Acme", "Backend Intern", { status: "needs_review" })]);
    expect(() => saveAnswers(id, answer, { ...files, report: asks("Why us?") })).toThrow(/not a question Acme's form has open now/);
    expect(loadQueue(files.queue).entries[0]?.status).toBe("needs_review");
    // In every case the profile was left as it was.
    expect(readFileSync(files.profile, "utf8")).toBe(profile);
    // A status set from an old page is refused the same way: here the page still showed "unconfirmed" and a reply has since settled it.
    const [sent = ""] = seed([job("Globex", "Intern", { status: "applied" })]);
    expect(() => applyStatusChange({ id: sent, status: "queued", was: "submission_unknown" }, files)).toThrow(Busy);
    expect(loadQueue(files.queue).entries[0]?.status).toBe("applied");
    // From the status it really has, the person's own choice goes through.
    applyStatusChange({ id: sent, status: "needs_review", was: "applied" }, files);
    expect(loadQueue(files.queue).entries[0]?.status).toBe("needs_review");
  });

  it("lists the questions of a job that was set aside, from its last report", () => {
    const e = job("Acme", "Backend Intern", { status: "needs_review", statusReason: "empty: Which team?" });
    const waiting = job("Globex", "Intern", { status: "awaiting_user_action", waitingFor: "human_code", statusReason: "the board emailed you a code" });
    const report = () => ({ reviews: [{ id: "f1", selector: "#t", kind: "select", label: "Which team?", options: ["Select...", "A", "B"], why: "required but no option fits" }, { id: "f2", selector: "#a", kind: "radio", label: "Are you authorized to work in the United States?", options: ["Yes", "No"], why: "unsure" }], drafts: [] }) as never;
    const needs = buildNeeds([e, waiting, job("Initech", "Intern", { status: "submission_unknown" })], { report, inboxFile: files.inbox });
    expect(needs.questions[0]?.items.map((i) => i.kind)).toEqual(["ask", "profile"]);
    expect(needs.waiting[0]).toMatchObject({ company: "Globex", todo: expect.stringMatching(/type the code/), open: false });
    expect(needs.waiting[0]?.mail).toMatch(/^https:\/\/mail\.google\.com/);
    expect(needs.unconfirmed.map((u) => u.company)).toEqual(["Initech"]);
  });
});

describe("the dashboard server's door", () => {
  it("takes a change only from its own page with its own token", () => {
    const req = (headers: Record<string, string>) => ({ headers });
    expect(fromThisPage(req({ host: "127.0.0.1:4545", origin: "http://127.0.0.1:4545" }), 4545)).toBe(true);
    expect(fromThisPage(req({ host: "127.0.0.1:4545", origin: "https://evil.example" }), 4545)).toBe(false);
    expect(fromThisPage(req({ host: "evil.example" }), 4545)).toBe(false);
    expect(hasToken(req({ "x-jev-token": "abc123" }), "abc123")).toBe(true);
    expect(hasToken(req({ "x-jev-token": "abc124" }), "abc123")).toBe(false);
    expect(hasToken(req({}), "abc123")).toBe(false);
  });
});
