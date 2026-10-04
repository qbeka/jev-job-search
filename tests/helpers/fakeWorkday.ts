/**
 * A scripted stand-in for a Workday tenant's sign-in pages, for testing the sign-in without a
 * browser or a real account. It keeps the same controls the live pages have (read on a live
 * sign-up and sign-in page, with nothing typed) and behaves the way a careful reading of them
 * says the board does. Every keystroke is logged with where it went, so a test can prove that a
 * password only ever reaches a password box on the employer's own origin.
 */
import type { AuthPage, AuthSnapshot } from "../../src/accounts/provider.js";
import type { Secret } from "../../src/util/redact.js";
import { workday } from "../../src/accounts/workday.js";

export const ORIGIN = "https://acme.wd5.myworkdayjobs.com";
export const APPLY = `${ORIGIN}/en-US/Careers/job/Toronto/Software-Intern_R1/apply/applyManually`;

type View = "register" | "sign_in" | "application" | "verify_notice" | "robot" | "method" | "blank" | "sso";
type Box = "email" | "password" | "passwordAgain";

export type Server = {
  /** The account the board holds for the address, if any. */
  account: { email: string; password: string; verified: boolean; locked?: boolean } | null;
  /** New accounts must prove their address before they can sign in. */
  verifies: boolean;
  /** The sign-up answers with a robot check. */
  robotOnRegister?: boolean;
  /** The token the board's verification link carries. */
  token: string;
  /** Has a "Resend" button on the verification notice. */
  canResend?: boolean;
  /** What the board says after Sign In or Create Account, in place of its usual answer. Empty words mean it says nothing and stays where it is. */
  signInSays?: string;
  signUpSays?: string;
};

export class FakeWorkday implements AuthPage {
  view: View;
  address = APPLY;
  boxes: Record<Box, string> = { email: "", password: "", passwordAgain: "" };
  terms = false;
  hasTerms = true;
  cookieNotice = false;
  errors: string[] = [];
  header = "";
  focused: Box | null = null;
  /** Everything typed: which box, whether it was a secret, and the origin the tab was on. */
  typed: { box: Box | null; secret: boolean; origin: string; text: string }[] = [];
  clicks: string[] = [];
  followed: string[] = [];
  resent = 0;
  signInClicks = 0;
  registerClicks = 0;
  /** Reads of the page that show nothing yet, before the form draws itself. */
  blankReads = 0;

  constructor(readonly server: Server, start: View = "register") {
    this.view = start;
  }

  private box(selector: string): Box | null {
    const c = workday.controls;
    return selector === c.email ? "email" : selector === c.password ? "password" : selector === c.passwordAgain ? "passwordAgain" : null;
  }
  private onForm(box: Box): boolean {
    if (this.view === "sign_in") return box !== "passwordAgain";
    return this.view === "register";
  }
  private clear(): void {
    this.boxes = { email: "", password: "", passwordAgain: "" };
    this.terms = false;
    this.errors = [];
    this.focused = null;
  }

  async url(): Promise<string> {
    return this.address;
  }

  async read(): Promise<AuthSnapshot> {
    const blank = this.blankReads > 0;
    if (blank) this.blankReads--;
    const v = blank ? "blank" : this.view;
    const present: Record<string, boolean> = {
      email: v === "sign_in" || v === "register",
      password: v === "sign_in" || v === "register",
      passwordAgain: v === "register",
      terms: v === "register" && this.hasTerms,
      signIn: v === "sign_in",
      register: v === "register",
      toSignIn: v === "register" || v === "verify_notice",
      toRegister: v === "sign_in",
      withEmail: v === "method",
      declineCookies: this.cookieNotice,
      code: false,
      sendCode: false,
      back: false,
      headerSignIn: v !== "application",
      application: v !== "blank",
      progress: v !== "blank",
      robot: v === "robot",
      otherSignIn: v === "method" || v === "sso",
    };
    const text =
      v === "register"
        ? "Create Account Email Address* Password* Verify New Password* Yes, I have read and consent to the terms and conditions Create Account Already have an account? Sign In"
        : v === "sign_in"
          ? "Sign In Email Address* Password* Sign In Don't have an account yet? Create Account Forgot your password?"
          : v === "verify_notice"
            ? "Verify your account. An email was sent to you. Click the link in it to activate your account."
            : v === "sso"
              ? "Sign in with your company single sign-on"
              : "";
    return { url: this.address, present, text, errors: [...this.errors], header: this.header };
  }

  async click(selector: string): Promise<boolean> {
    const c = workday.controls;
    this.clicks.push(selector);
    if (selector === c.declineCookies) {
      if (!this.cookieNotice) return false;
      this.cookieNotice = false;
      return true;
    }
    if (selector === c.back) return false;
    if (selector === c.withEmail && this.view === "method") {
      this.view = "sign_in";
      return true;
    }
    if (selector === c.toSignIn && (this.view === "register" || this.view === "verify_notice")) {
      this.clear();
      this.view = "sign_in";
      return true;
    }
    if (selector === c.toRegister && this.view === "sign_in") {
      this.clear();
      this.view = "register";
      return true;
    }
    if (selector === c.terms && this.view === "register") {
      this.terms = !this.terms;
      return true;
    }
    if (selector === c.signIn && this.view === "sign_in") {
      this.signInClicks++;
      // A click is what makes a browser hand its saved password to the page.
      if (this.browserHolds && !this.boxes.email && !this.boxes.password) this.boxes = { ...this.boxes, email: this.browserHolds.email, password: this.browserHolds.password };
      const a = this.server.account;
      if (this.server.signInSays !== undefined) this.errors = this.server.signInSays ? [this.server.signInSays] : [];
      else if (a?.locked) this.errors = ["Your account has been locked. Try again later."];
      else if (!a || a.email !== this.boxes.email || a.password !== this.boxes.password) this.errors = ["ERROR: Invalid Username/Password"];
      else if (!a.verified) this.errors = ["Your account has not been verified. Check your email for the verification link."];
      else {
        this.errors = [];
        this.view = "application";
        this.header = a.email;
      }
      return true;
    }
    if (selector === c.register && this.view === "register") {
      this.registerClicks++;
      if (this.server.robotOnRegister) {
        this.view = "robot";
        return true;
      }
      if (this.server.signUpSays !== undefined) {
        this.errors = this.server.signUpSays ? [this.server.signUpSays] : [];
        return true;
      }
      if (this.server.account?.email === this.boxes.email) this.errors = ["An account already exists for this email address."];
      else if (this.boxes.password !== this.boxes.passwordAgain || !/\d/.test(this.boxes.password)) this.errors = ["Password must contain a numeric character."];
      else if (this.hasTerms && !this.terms) this.errors = ["You must agree to the terms."];
      else {
        this.server.account = { email: this.boxes.email, password: this.boxes.password, verified: !this.server.verifies };
        this.errors = [];
        this.view = this.server.verifies ? "verify_notice" : "application";
        if (!this.server.verifies) this.header = this.boxes.email;
      }
      return true;
    }
    return false;
  }

  async clickByText(_scope: string, pattern: string): Promise<boolean> {
    if (this.view !== "verify_notice" && !this.errors.some((e) => /verif/i.test(e))) return false;
    if (!this.server.canResend || !new RegExp(pattern, "i").test("Resend")) return false;
    this.resent++;
    return true;
  }

  async focus(selector: string): Promise<boolean> {
    const b = this.box(selector);
    if (!b || !this.onForm(b)) return false;
    this.focused = b;
    this.boxes[b] = "";
    return true;
  }

  async type(text: string): Promise<void> {
    this.typed.push({ box: this.focused, secret: false, origin: new URL(this.address).origin, text });
    if (this.focused) this.boxes[this.focused] += text;
  }

  async typeSecret(secret: Secret): Promise<void> {
    this.typed.push({ box: this.focused, secret: true, origin: new URL(this.address).origin, text: "(secret)" });
    if (this.focused) this.boxes[this.focused] += secret.reveal();
  }

  /** What the person's own browser holds for this sign-in page, when they saved a password in it. It fills the boxes itself; the tool never reads them. */
  browserHolds: { email: string; password: string } | null = null;

  async autofilled(selector: string): Promise<boolean> {
    const b = this.box(selector);
    return !!this.browserHolds && this.view === "sign_in" && (b === "email" || b === "password") && this.boxes[b] === "";
  }

  async holds(selector: string): Promise<{ value: string | null; length: number; checked: boolean; password: boolean } | null> {
    if (selector === workday.controls.terms) return this.view === "register" && this.hasTerms ? { value: "", length: 0, checked: this.terms, password: false } : null;
    const b = this.box(selector);
    if (!b || !this.onForm(b)) return null;
    const password = b !== "email";
    return { value: password ? null : this.boxes[b], length: this.boxes[b].length, checked: false, password };
  }

  async navigate(url: string): Promise<void> {
    this.address = url;
    this.clear();
    this.view = this.header ? "application" : "register";
  }

  async follow(url: string, allowedOrigins: string[]): Promise<{ ok: boolean; why?: string }> {
    this.followed.push(url);
    const u = new URL(url);
    if (!allowedOrigins.includes(u.origin)) return { ok: false, why: "it is not on the employer's own site" };
    if (u.searchParams.get("then") === "elsewhere") return { ok: false, why: "it led to https://evil.example" };
    if (u.pathname.endsWith(`/activate/${this.server.token}`) && this.server.account) this.server.account.verified = true;
    this.address = url;
    return { ok: true };
  }

  async wait(): Promise<void> {
    /* no time passes in a test */
  }
}
