/**
 * Sending a form, and reading what the page became. A form is sent only when
 * its report says ready and its required fields are read once more as filled.
 * An application counts only when the page after the click is a confirmation.
 */
import { BROWSER } from "../config.js";
import { decidePageState, type PageState } from "../forms/pageState.js";
import type { JevClient } from "../jev/client.js";
import path from "node:path";
import { sleep, type Page } from "./cdp.js";
import { emptyRequired, loadPlan, loadReport, pickSubmit, showsPlanned } from "./report.js";
import type { FillPlan } from "../forms/fields.js";
import { controlStates, dump, inFront, install, pageFor, shownValues, type Point } from "./session.js";

export type SubmitResult = {
  state: PageState["state"];
  confidence: number;
  url: string;
  errors: string[];
  /** The board emailed a code to confirm a person is applying. A human check: the person's to type. */
  needsCode: boolean;
  /** The page shows a robot check. The person's to pass. */
  humanCheck: boolean;
  /** The board refused a second application from this person. */
  refused: boolean;
  /** The form is still on the page with its Submit control: the click did not send it. */
  formStillOpen: boolean;
  excerpt: string;
};

/**
 * What the page shows now against what each control was given: every planned fill, every answer the
 * writer gave, every attached file. The names of the controls that show something else. Read-back
 * after the fill can go stale (a later answer, a re-render), so this runs right before the click.
 */
export async function verifyIntended(page: Page, plan: FillPlan, answers: { selector: string; value: string }[]): Promise<string[]> {
  const written = new Map(answers.map((a) => [a.selector, a.value]));
  const wanted = plan.fields
    .filter((f) => (f.action === "fill" && f.value) || written.has(f.selector))
    .map((f) => (written.has(f.selector) ? { ...f, value: written.get(f.selector) as string, optionLabel: null } : f));
  const shown = await shownValues(page, wanted.map((f) => f.selector));
  const states = await controlStates(page, wanted.map((f) => f.selector));
  const wrong = wanted.filter((f, i) => states[i] !== "off" && !showsPlanned(f, shown[i] ?? "")).map((f) => `${f.label.slice(0, 50)} (wanted "${(f.optionLabel ?? f.value ?? "").slice(0, 30)}")`);
  for (const u of plan.uploads) {
    const name = path.basename(u.path);
    if (!(await page.awj<boolean>("showsFile", name))) wrong.push(`the file ${name} is not attached`);
  }
  return wrong;
}

/**
 * Clicks the form's Submit control and reports what the page became. `onClick` is called just
 * before the click: from that moment the application may be with the employer, whatever happens next.
 */
export async function submitJob(jev: JevClient, jobId: string, opts: { force?: boolean; onClick?: () => void } = {}): Promise<SubmitResult> {
  const force = !!opts.force;
  const r = loadReport(jobId);
  if (!r.ready && !force) throw new Error(`not ready to submit: ${r.resolution?.reason || [...r.missingRequired.map((l) => `empty: ${l.slice(0, 50)}`), ...r.failed.map((f) => `failed: ${f.label.slice(0, 50)}`), ...r.reviews.map((x) => `review: ${x.label.slice(0, 50)}`), ...r.drafts.map((x) => `draft: ${x.label.slice(0, 50)}`)].join("; ") || r.reason}`);
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = loadPlan(jobId);
    const pick = pickSubmit(plan.submitSelectors);
    if (!pick) throw new Error("No submit control in the plan.");
    if (!force) {
      // A question may have appeared since the page was read, or the tool may never have seen one. The whole page is
      // read afresh, and any required control on it that shows nothing stops the click.
      const now = await dump(page);
      const all = now.fields.filter((f) => f.kind !== "file");
      const asPlan = { fields: all.map((f) => ({ selector: f.selector, kind: f.kind, label: f.label, required: f.required, action: "fill" })) } as unknown as FillPlan;
      const unseen = emptyRequired(now, asPlan, await shownValues(page, all.map((f) => f.selector)), await controlStates(page, all.map((f) => f.selector))).map((l) => l.slice(0, 50));
      if (unseen.length) throw new Error(`not ready to submit, required fields are empty on the page: ${unseen.join("; ")}`);
      // The report says ready, but the page is what gets submitted: read the required fields once more.
      const selectors = plan.fields.map((f) => f.selector);
      const empty = emptyRequired(d, plan, await shownValues(page, selectors), await controlStates(page, selectors)).map((l) => l.slice(0, 50));
      if (empty.length) throw new Error(`not ready to submit, required fields are empty on the page: ${empty.join("; ")}`);
      // And every value is compared with what it was meant to be, as the page shows it now.
      const wrong = await verifyIntended(page, plan, r.resolution?.answers ?? []);
      if (wrong.length) throw new Error(`not ready to submit, the page no longer shows what was entered: ${wrong.slice(0, 4).join("; ")}`);
    }
    await page.writesSettled(BROWSER.saveMs);
    const before = await page.evaluate<string>("window.__awj.pageText()");
    // Other forms may be filling in their own tabs. The click takes its turn for the front of the window.
    await inFront(page, async () => {
      let p = await page.awj<Point>("point", pick.selector);
      if (!p.ok) throw new Error(`Submit control ${pick.selector} is not on the page.`);
      // A cookie banner over the button would take the click. It is answered with its most private choice
      // (necessary cookies only), never with "accept all". If the button is still covered, it is pressed from script.
      if (await page.awj<string>("coveredBy", pick.selector)) {
        const decline = await page.awj<Point>("clickByText", DECLINE_COOKIES);
        if (decline.ok) {
          await page.click(decline.x, decline.y);
          await sleep(BROWSER.pollMs * 3);
          p = await page.awj<Point>("point", pick.selector);
        }
      }
      opts.onClick?.();
      if (await page.awj<string>("coveredBy", pick.selector)) await page.awj<boolean>("press", pick.selector);
      else await page.click(p.x, p.y);
    });
    const deadline = Date.now() + BROWSER.submitMs;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(BROWSER.pollMs * 3);
      try {
        await install(page);
        after = await page.evaluate<string>("window.__awj.pageText()");
      } catch {
        continue; // mid-navigation
      }
      if (after !== before && after.length > 0) break;
    }
    await sleep(BROWSER.pollMs * 6);
    await install(page);
    after = await page.evaluate<string>("window.__awj.pageText()");
    const url = await page.evaluate<string>("location.href");
    let state = await decidePageState(jev, after, url, jobId);
    let errors = await page.evaluate<string[]>("window.__awj.errors()");
    // Still the form, and the page reports nothing wrong: the board may only be slow to confirm. Wait for the page to change once more, then look again.
    if (state.state !== "submitted" && !errors.length && !SECURITY_CODE.test(after)) {
      const settled = after;
      const until = Date.now() + BROWSER.confirmMs;
      while (Date.now() < until && after === settled) {
        await sleep(BROWSER.pollMs * 6);
        try {
          await install(page);
          after = await page.evaluate<string>("window.__awj.pageText()");
        } catch {
          continue; // mid-navigation
        }
      }
      if (after !== settled) {
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId);
        errors = await page.evaluate<string[]>("window.__awj.errors()");
      }
    }
    const notSent = state.state !== "submitted";
    const text = withoutBadges(after);
    const stillThere = notSent && (await page.awj<Point>("point", pick.selector).then((p) => p.ok).catch(() => false));
    return { state: state.state, confidence: state.confidence, url: await page.evaluate<string>("location.href"), errors, needsCode: notSent && SECURITY_CODE.test(text), humanCheck: notSent && !SECURITY_CODE.test(text) && HUMAN_CHECK.test(text), refused: notSent && ALREADY_APPLIED.test(text), formStillOpen: stillThere, excerpt: after.replace(/\s+/g, " ").slice(-400) };
  } finally {
    page.close();
  }
}

/** The choice on a cookie banner that allows the least. */
const DECLINE_COOKIES = "^\\s*(necessary only|only necessary|necessary cookies only|use necessary cookies only|reject all|reject|decline|decline all|refuse|deny)\\s*$";

/** A board that refuses a second application from the same person for now. The job is skipped, not held. */
export const ALREADY_APPLIED = /recently applied for another role|unable to accept an additional application|already (applied|submitted an application)/i;

/**
 * A page that asks the person to prove they are not a robot (BambooHR after Submit). Only the
 * person can pass it. The footer badge every protected form carries is not a check.
 */
export const HUMAN_CHECK = /not a robot|i am human|i'm human|human check|verify (that )?you('re| are) (a )?human|complete the captcha|captcha (is )?required/i;
const withoutBadges = (text: string) => text.replace(/(this site is )?protected by (re|h)captcha[^.\n]*[.\n]?/gi, " ").replace(/recaptcha (privacy|terms)[^.\n]*/gi, " ");

/** A board that emails a code to confirm a person is applying. Only the person can enter it. */
export const SECURITY_CODE = /verification code was sent|enter the \S+ code|security code/i;

/**
 * Reads the page a job's tab shows now, without clicking anything. This is how an application is
 * recorded after the person finished it by hand: a human check, an emailed code, a field they fixed.
 */
export async function checkJob(jev: JevClient, jobId: string): Promise<{ state: PageState["state"]; confidence: number; url: string; needsCode: boolean; formStillOpen: boolean; excerpt: string }> {
  const page = await pageFor(jobId);
  try {
    await install(page);
    const text = await page.evaluate<string>("window.__awj.pageText()");
    const url = await page.evaluate<string>("location.href");
    const state = await decidePageState(jev, text, url, jobId);
    let formStillOpen = false;
    try {
      const pick = pickSubmit(loadPlan(jobId).plan.submitSelectors);
      formStillOpen = !!pick && (await page.awj<Point>("point", pick.selector)).ok;
    } catch {
      formStillOpen = false;
    }
    return { state: state.state, confidence: state.confidence, url, needsCode: state.state !== "submitted" && SECURITY_CODE.test(withoutBadges(text)), formStillOpen, excerpt: text.replace(/\s+/g, " ").slice(-300) };
  } finally {
    page.close();
  }
}

/**
 * Brings a job's tab to the front and watches it while the person finishes the form by hand (a
 * code to type, a human check). Nothing is typed or clicked. The page is judged only when its
 * text changes. Returns "submitted" on a confirmation, "gave_up" when `stop` says so or time runs out.
 */
export async function watchForConfirmation(jev: JevClient, jobId: string, opts: { timeoutMs: number; stop?: () => boolean }): Promise<"submitted" | "gave_up"> {
  const page = await pageFor(jobId);
  try {
    await page.bringToFront();
    const deadline = Date.now() + opts.timeoutMs;
    let last = "";
    while (Date.now() < deadline && !opts.stop?.()) {
      await sleep(BROWSER.pollMs * 6);
      let text: string;
      try {
        await install(page);
        text = await page.evaluate<string>("window.__awj.pageText()");
      } catch {
        continue; // mid-navigation
      }
      if (text === last) continue;
      last = text;
      // The form with its code box or robot check still showing is not worth a judgement.
      if (SECURITY_CODE.test(withoutBadges(text)) || HUMAN_CHECK.test(withoutBadges(text))) continue;
      const state = await decidePageState(jev, text, await page.evaluate<string>("location.href"), jobId);
      if (state.state === "submitted") return "submitted";
    }
    return "gave_up";
  } finally {
    page.close();
  }
}
