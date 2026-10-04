/**
 * Help for the person when a form waits on them. The tool never passes a human check and never
 * reads or types a code a board sent to prove a person is applying. What it does: says so with a
 * notification, puts the form in front, and opens the person's own mail at a search for that
 * email, so the code is one glance away.
 */
import { spawn } from "node:child_process";
import { ASSIST, childEnv } from "../config.js";
import type { WaitingFor } from "../jobs/queue.js";

const WORDS: Record<WaitingFor, string> = {
  human_code: "type the code the board emailed you, then click Submit",
  robot_check: "pass the robot check, then click Submit",
  login: "sign in",
  agreement: "read and accept the agreement",
  phone: "finish the phone verification",
  passkey: "sign in with your passkey",
  sso: "sign in with your single sign-on",
  email_link: "click the link the board emailed you to prove the address is yours",
  unknown: "finish what the page asks for",
};

export const waitingWords = (w: WaitingFor) => WORDS[w];

/** The mail search that finds a board's code email: the board's name and "code", from the last hour. No address, nothing personal. */
export function mailSearchUrl(host: string): string {
  // Workday mails from its own domain, whatever the employer's address is.
  const board = /myworkday/.test(host) ? "workday" : (host.split(".").slice(-2, -1)[0] ?? host);
  const q = `${board} (code OR verification OR security) newer_than:1h`;
  return `${ASSIST.mailSearchBase}${encodeURIComponent(q)}`;
}

const run = (command: string, args: string[]) => {
  try {
    spawn(command, args, { stdio: "ignore", detached: true, env: childEnv() }).unref();
  } catch {
    /* help that cannot be given is not an error */
  }
};

/** A notification on the Mac. The words travel as arguments, never as script text. */
export function notify(title: string, body: string): void {
  if (process.platform !== "darwin" || !ASSIST.notify) return;
  run("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]);
}

/** Tells the person a form waits on them and, for an emailed code, opens their mail at the search for it. */
export function assist(job: { company: string; title: string }, waitingFor: WaitingFor, pageUrl: string): void {
  notify("jev-job-search needs you", `${job.company}: ${WORDS[waitingFor]}`);
  if ((waitingFor === "human_code" || waitingFor === "email_link") && ASSIST.openMail && process.platform === "darwin") {
    let host = "";
    try {
      host = new URL(pageUrl).hostname;
    } catch {
      host = "";
    }
    if (host) run("/usr/bin/open", [mailSearchUrl(host)]);
  }
}
