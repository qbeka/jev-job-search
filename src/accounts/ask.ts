/**
 * Asking the person for the one password their job-board accounts use, in a window of their own
 * Mac. They type it twice, hidden. It goes from that window to this process and from here into
 * the Keychain: it is never printed, never an argument of a command, and never seen by Claude.
 * A window works from anywhere the command is started, a terminal or a skill, which a prompt in
 * the terminal does not.
 */
import { spawnSync } from "node:child_process";
import { ACCOUNTS, childEnv } from "../config.js";
import { Secret } from "../util/redact.js";
import { passwordProblems } from "./secrets.js";

/** Shows one hidden-answer window and returns what was typed, or null when the person cancelled or it timed out. */
export type Dialog = (message: string) => string | null;

// The words travel as an argument to a fixed script, never as script text.
const SCRIPT = [
  "on run argv",
  'set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "jev-job-search" buttons {"Cancel", "Save"} default button "Save" giving up after ' + String(ACCOUNTS.askSeconds),
  'if gave up of r then error "timed out"',
  "return text returned of r",
  "end run",
];

const macDialog: Dialog = (message) => {
  const r = spawnSync("/usr/bin/osascript", [...SCRIPT.flatMap((line) => ["-e", line]), message], { encoding: "utf8", env: childEnv() });
  return r.status === 0 ? (r.stdout ?? "").replace(/\n$/, "") : null;
};

export type Asked = { ok: true; password: Secret } | { ok: false; why: "cancelled" | "mismatch" | "rules"; problems?: string[] };

/**
 * Asks for the password and its repeat, and checks it against the board's rules before anything
 * is stored. A password that misses a rule is asked for again, with the rule named, a few times.
 */
export function askPassword(dialog: Dialog = macDialog, o: { what?: string; existing?: boolean } = {}): Asked {
  // A password that already works at an employer is taken as it is. Only what the Keychain cannot hand back as typed is refused.
  const check = (p: Secret) => passwordProblems(p).filter((x) => !o.existing || /plain keyboard/.test(x));
  const rules = o.existing ? "Type it exactly as you use it there." : "Workday wants 8 or more characters with a digit, a lower-case letter, an upper-case letter and a special character.";
  const what = o.what ?? "The one password for your job-board accounts.";
  let note = "";
  let last: Asked = { ok: false, why: "cancelled" };
  for (let round = 0; round < ACCOUNTS.askRounds; round++) {
    const first = dialog(`${note}${what}\n\nIt goes into your Mac's Keychain. It is not shown, not saved in a file, and never sent to Claude or JEV.\n\n${rules}`);
    if (first === null) return { ok: false, why: "cancelled" };
    const password = new Secret(first);
    const problems = check(password);
    if (problems.length) {
      note = `That one needs ${problems.join(", ")}.\n\n`;
      last = { ok: false, why: "rules", problems };
      continue;
    }
    const again = dialog("Type it once more, to be sure.");
    if (again === null) return { ok: false, why: "cancelled" };
    if (again === first) return { ok: true, password };
    note = "The two did not match.\n\n";
    last = { ok: false, why: "mismatch" };
  }
  return last;
}
