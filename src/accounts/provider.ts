/**
 * What a job board has to tell the tool for it to sign in there, and what the tool needs from a
 * page to do it. An adapter names every control it touches and reads every outcome from the page
 * itself. Text on a page never chooses which credential is used or where it is typed.
 */
import type { Secret } from "../util/redact.js";

/** A page as the sign-in sees it. The real one drives Chrome (`authPage.ts`); tests script one. */
export interface AuthPage {
  /** The address of the tab's own frame, as the browser knows it, not as the page says. */
  url(): Promise<string>;
  /** Which of the named controls are on the page and visible, and the words the page shows. */
  read(controls: Record<string, string>, words: { panel: string; errors: string; header: string }): Promise<AuthSnapshot>;
  /** A real click on the control. False when it is not on the page. */
  click(selector: string): Promise<boolean>;
  /** A real click on the one button inside `scope` whose words match. False when there is none, or more than one. */
  clickByText(scope: string, pattern: string): Promise<boolean>;
  /** Puts the keyboard in a box and empties it. True only when that box has the keyboard now. */
  focus(selector: string): Promise<boolean>;
  type(text: string): Promise<void>;
  typeSecret(secret: Secret): Promise<void>;
  /** What a box holds. A password box says how long its value is and never the value. */
  holds(selector: string): Promise<{ value: string | null; length: number; checked: boolean; password: boolean } | null>;
  navigate(url: string): Promise<void>;
  /** Opens a link with every page load held to the allowed origins. A load that would leave them is refused. */
  follow(url: string, allowedOrigins: string[]): Promise<{ ok: boolean; why?: string }>;
  wait(ms: number): Promise<void>;
}

export type AuthSnapshot = {
  url: string;
  present: Record<string, boolean>;
  /** The words of the account panel, or of the page when it has none. */
  text: string;
  /** The words of the page's own error messages. */
  errors: string[];
  /** The words of the page's top bar, where a board shows who is signed in. */
  header: string;
};

/**
 * What a page is, for signing in:
 * signed_in: the application is open. sign_in, register: that form. method: a choice of ways to
 * sign in, with "email" among them. verify_email: the board waits for the link or code it mailed.
 * challenge: a robot check, which is the person's. elsewhere: single sign-on, a passkey, a phone
 * code or another thing only the person can do. unknown: not a page the adapter knows.
 */
export type AuthView = "signed_in" | "sign_in" | "register" | "method" | "verify_email" | "challenge" | "elsewhere" | "unknown";
export type SignInResult = "moved_on" | "verify_email" | "wrong_password" | "locked" | "challenge" | "unclear";
export type RegisterResult = "moved_on" | "verify_email" | "exists" | "password_refused" | "challenge" | "unclear";

export interface Adapter {
  provider: "workday";
  /** The employer a link belongs to and the one origin its account may be used on. Null when the link is not this provider's. */
  tenantOf(url: string): { tenant: string; origin: string } | null;
  /** The address that opens the application for a posting. */
  applicationUrl(postingUrl: string): string;
  controls: {
    email: string;
    password: string;
    /** The second password box on the sign-up form. */
    passwordAgain: string;
    /** The account terms box on the sign-up form, ticked only when the person approved "account_terms". */
    terms: string;
    signIn: string;
    register: string;
    toSignIn: string;
    toRegister: string;
    /** "Sign in with email", on a page that offers several ways. */
    withEmail: string;
    /** The cookie notice's decline button. */
    declineCookies: string;
    /** A box for a code the board emailed to prove the inbox, and the button that sends it. Empty when the board uses a link. */
    code: string;
    sendCode: string;
    /** The form's own Back button, for a saved draft that opens in the middle. */
    back: string;
    [name: string]: string;
  };
  words: { panel: string; errors: string; header: string };
  /** The words on the button that asks the board to mail its verification again. */
  resend: string;
  view(s: AuthSnapshot): AuthView;
  afterSignIn(s: AuthSnapshot): SignInResult;
  afterRegister(s: AuthSnapshot): RegisterResult;
  /** The address the page shows as signed in, when it shows one. */
  identity(s: AuthSnapshot): string | null;
  /** What the board's verification email looks like. */
  mail: MailShape;
}

export type MailShape = {
  /** The domains the email may come from. A sender on a subdomain of one counts. */
  senders: string[];
  subject: RegExp;
  /** True for a link that verifies an account: only its path is judged here, its origin is checked against the account. */
  linkPath: RegExp;
  /** A code in the email's words, when the board sends one. The first group is the code. */
  code: RegExp | null;
};

export type VerificationRequest = {
  accountId: string;
  /** The address the email must have been sent to. */
  recipient: string;
  /** The origins a verification link may be on. */
  allowedOrigins: string[];
  /** The email must be newer than this: when the board was asked to send it. */
  since: Date;
  shape: MailShape;
};

export type VerificationFound = { ok: true; messageId: string; link: string | null; code: Secret | null } | { ok: false; why: string };

/** Finds the one verification email a request asked for. The real one reads Gmail (`src/mail/verification.ts`). */
export interface Verifier {
  find(req: VerificationRequest): Promise<VerificationFound>;
  /** Marks a message as used, so it never answers another request. */
  consume(messageId: string): void;
}
