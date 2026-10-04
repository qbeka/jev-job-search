/**
 * Workday candidate accounts. Every employer on Workday keeps its own accounts, on its own
 * address, so an account here is always for one employer. The controls are found by the names
 * Workday itself gives them (data-automation-id), read on its live sign-in and sign-up pages.
 *
 * The sign-up form also holds a box that is hidden from people and meant to catch robots. This
 * adapter names every control it touches and that box is not one of them, so it stays empty.
 */
import type { Adapter, AuthSnapshot } from "./provider.js";

const id = (name: string) => `[data-automation-id="${name}"]`;

// An account or an address that has to be verified or activated. "Verify New Password" is a box on the sign-up form, not this.
const VERIFY = /\b(account|e-?mail|address)\b[^.]{0,80}\b(verif|activat)|\b(verif|activat)\w*\b[^.]{0,80}\b(account|e-?mail|address)\b/i;
// "Try again later" alone is not a lockout: a page says that about any hiccup.
const LOCKED = /\block(ed|out)\b|too many (failed )?(attempts|tries|sign-?ins|log-?ins)|temporarily (disabled|suspended)|\b(disabled|suspended)\b[^.]{0,30}\baccount|\baccount\b[^.]{0,30}\b(disabled|suspended)/i;
// Any message about the password or the credentials after a click on Sign In is a refusal, however it is worded.
const ABOUT_PASSWORD = /\b(password|credentials|user ?name)\b/i;
// The board refusing the address or the password, in so many words. "Something went wrong" is not that.
const WRONG = /\b(invalid|incorrect|wrong)\b[^.]{0,40}\b(user ?name|e-?mail|address|password|credentials|log-?in|sign-?in)|\b(user ?name|e-?mail|address|password|credentials)\b[^.]{0,40}\b(is|are|was)? ?(invalid|incorrect|wrong|not recogni[sz]ed)|(does not|doesn['’]t|do not|don['’]t) match/i;
const EXISTS = /already (exists|registered|in use|been used|have an account)|account (already )?exists|existing account/i;
const PASSWORD_RULE = /password (must|should|does not|doesn['’]t|requirements?|is too)|must (contain|include|be at least)/i;
const ROBOT = /not a robot|verify (that )?you('re| are) (a )?human|complete the captcha|security check/i;
const ELSEWHERE = /passkey|security key|single sign-on|\bsso\b|text message|phone number to verify|authenticator/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export const workday: Adapter = {
  provider: "workday",

  tenantOf(url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    // acme.wd5.myworkdayjobs.com: the employer is the first name of the host.
    const jobs = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
    if (jobs?.[1]) return { tenant: jobs[1], origin: u.origin };
    // wd5.myworkdaysite.com/recruiting/acme/Careers: the employer is in the path.
    const site = /^wd\d+\.myworkdaysite\.com$/.test(host) ? /^\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([a-z0-9_-]+)\//i.exec(u.pathname) : null;
    if (site?.[1]) return { tenant: site[1].toLowerCase(), origin: u.origin };
    return null;
  },

  applicationUrl(postingUrl) {
    const u = new URL(postingUrl);
    const path = u.pathname.replace(/\/+$/, "").replace(/\/apply(\/[A-Za-z]+)?$/, "");
    return `${u.origin}${path}/apply/applyManually`;
  },

  controls: {
    email: `input${id("email")}`,
    password: `input${id("password")}`,
    passwordAgain: `input${id("verifyPassword")}`,
    terms: `input${id("createAccountCheckbox")}`,
    signIn: id("signInSubmitButton"),
    register: id("createAccountSubmitButton"),
    toSignIn: id("signInLink"),
    toRegister: id("createAccountLink"),
    withEmail: id("SignInWithEmailButton"),
    declineCookies: id("legalNoticeDeclineButton"),
    code: "",
    sendCode: "",
    back: `${id("pageFooterBackButton")}, ${id("bottom-navigation-back-button")}`,
    // Read only, to tell pages apart.
    headerSignIn: id("utilityButtonSignIn"),
    application: id("applyFlowPage"),
    progress: id("progressBar"),
    robot: `${id("noCaptchaWrapper")} iframe, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[title*="challenge" i]`,
    otherSignIn: `${id("GoogleSignInButton")}, ${id("AppleSignInButton")}, ${id("LinkedInSignInButton")}`,
  },

  words: { panel: id("signInContent"), errors: `${id("errorMessage")}, ${id("inputAlert")}, [role="alert"]`, header: id("utilityButtonBar") },

  resend: "^(resend|send( it)? again|resend (account )?verification( e-?mail)?)$",

  view(s: AuthSnapshot) {
    const p = s.present;
    if (p.robot || ROBOT.test(s.errors.join(" "))) return "challenge";
    // The board says the address must be proven first, on whatever form it says it. A message that
    // also speaks of the password is a refused sign-in, not this.
    if (VERIFY.test(s.errors.join(" ")) && !ABOUT_PASSWORD.test(s.errors.join(" "))) return "verify_email";
    if (p.signIn && p.password) return "sign_in";
    if (p.register && p.password) return "register";
    if (p.withEmail) return "method";
    if (!p.password && p.headerSignIn && VERIFY.test(s.text)) return "verify_email";
    if (!p.password && !p.email && (p.otherSignIn || ELSEWHERE.test(s.text)) && p.headerSignIn) return "elsewhere";
    // The application itself: its progress bar, with no sign-in control anywhere on the page.
    if (p.application && p.progress && !p.password && !p.signIn && !p.register && !p.headerSignIn) return "signed_in";
    return "unknown";
  },

  afterSignIn(s) {
    const said = s.errors.join(" ");
    if (this.view(s) === "challenge") return "challenge";
    if (LOCKED.test(said)) return "locked";
    if (WRONG.test(said) || ABOUT_PASSWORD.test(said)) return "wrong_password";
    if (VERIFY.test(said)) return "verify_email";
    return s.errors.length ? "unclear" : "moved_on";
  },

  afterRegister(s) {
    const said = s.errors.join(" ");
    if (this.view(s) === "challenge") return "challenge";
    if (EXISTS.test(said)) return "exists";
    if (PASSWORD_RULE.test(said)) return "password_refused";
    if (VERIFY.test(said)) return "verify_email";
    return s.errors.length ? "unclear" : "moved_on";
  },

  identity(s) {
    return EMAIL.exec(s.header)?.[0]?.toLowerCase() ?? null;
  },

  mail: {
    senders: ["myworkday.com", "workday.com", "myworkdayjobs.com"],
    subject: /verif|activat|confirm|account/i,
    linkPath: /\/(activate|verify|verification|confirm)[a-z]*(\/|$)/i,
    code: null,
  },
};
