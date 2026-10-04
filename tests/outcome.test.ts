import { describe, expect, it } from "vitest";
import { blockedReport, SIGN_IN_REASON, type FillReport } from "../src/browser/report.js";
import { notReady, outcomeOf } from "../src/run/outcome.js";

const job = { id: "j1", company: "Acme", title: "SWE Intern", ats: "greenhouse", url: "https://careers.acme.com/1" };
const filled = (over: Partial<FillReport> = {}): FillReport => ({ jobId: "j1", company: "Acme", title: "SWE Intern", ats: "greenhouse", url: job.url, state: "filled", reason: null, fields: [], drafts: [], reviews: [], failed: [], leftBlank: [], missingRequired: [], ready: true, page: 1, earlier: [], hasNext: false, seconds: 1, jevCostUsd: 0, ...over });

describe("what becomes of a job", () => {
  it("is sent when its form is ready", () => {
    expect(outcomeOf(filled(), 8)).toEqual({ action: "send", reason: null, rememberSite: false });
  });
  it("is left for the person, and its site crossed out, when the site wants a sign-in", () => {
    expect(outcomeOf(blockedReport(job, SIGN_IN_REASON), 8)).toEqual({ action: "login_required", reason: SIGN_IN_REASON, rememberSite: true });
    expect(outcomeOf(blockedReport(job, "no form found, page looks like: login_required"), 8)).toMatchObject({ action: "login_required", reason: SIGN_IN_REASON, rememberSite: true });
  });
  it("waits for what a sign-in the tool started could not finish, and keeps the site", () => {
    const stopped = (auth: NonNullable<FillReport["auth"]>, reason: string) => outcomeOf({ ...blockedReport(job, reason), auth }, 8);
    expect(stopped({ status: "awaiting_user_action", waitingFor: "robot_check" }, "the sign-in page asks you to confirm you are not a robot")).toEqual({ action: "awaiting_user_action", reason: "the sign-in page asks you to confirm you are not a robot", rememberSite: false, waitingFor: "robot_check" });
    expect(stopped({ status: "awaiting_email_verification", waitingFor: null }, "click the link yourself")).toMatchObject({ action: "awaiting_email_verification", rememberSite: false });
    expect(stopped({ status: "login_required", waitingFor: "login" }, "no password is stored")).toMatchObject({ action: "login_required", reason: "no password is stored", rememberSite: false });
    // The day's limit of new accounts: nothing is wrong, the job goes back to the queue with no reason on it.
    expect(stopped({ status: "queued", waitingFor: null }, "today's limit of 3 new accounts is reached")).toEqual({ action: "queued", reason: null, rememberSite: false, waitingFor: null });
  });
  it("is skipped, not left for the person, when the posting has closed", () => {
    expect(outcomeOf(blockedReport(job, "no form found, page looks like: closed"), 8)).toEqual({ action: "skipped", reason: "the posting has closed", rememberSite: false });
  });
  it("is left for the person when the form asks for a signature or for something the profile does not say", () => {
    const nda = filled({ ready: false, reviews: [{ id: "f1", selector: "#nda", kind: "text", label: "Type your full name to agree to the NDA", options: [], why: "signing an agreement is for the candidate to do" }], missingRequired: ["Type your full name to agree to the NDA"] });
    expect(outcomeOf(nda, 8).action).toBe("needs_review");
    expect(outcomeOf(nda, 8).reason).toMatch(/asks for a signature/);
    const incident = filled({ ready: false, resolution: { verdict: "needs_review", reason: "The essay asks for a specific incident the facts do not record.", answers: [] } });
    expect(outcomeOf(incident, 8)).toMatchObject({ action: "needs_review", reason: "The essay asks for a specific incident the facts do not record." });
  });
  it("is skipped when Claude says the form requires a cover letter or references", () => {
    expect(outcomeOf(filled({ ready: false, resolution: { verdict: "skip", reason: "A cover letter is required.", answers: [] } }), 8)).toMatchObject({ action: "skipped", reason: "A cover letter is required." });
  });
  it("is recorded as applied when the form's last Next turned out to send it", () => {
    expect(outcomeOf(filled({ ready: false, sent: true }), 8).action).toBe("applied");
  });
  it("is left for the person when the form has more pages than the tool will walk", () => {
    expect(outcomeOf(filled({ ready: false, hasNext: true, page: 8 }), 8)).toMatchObject({ action: "needs_review", reason: "the form runs over more than 8 pages" });
  });
  it("says which page of a long form held it, and why Next did nothing", () => {
    const stuck = filled({ ready: false, hasNext: true, page: 2, failed: [{ selector: "#next", label: "Next", why: 'the form did not move on after "Next": Phone is required' }] });
    expect(notReady(stuck)).toBe('page 2: the form did not move on after "Next": Phone is required');
  });
});
