/**
 * Asking the person for a password their job-board accounts use, in a window of their own
 * computer. They type it twice, hidden. It goes from that window to this process and from here
 * into the system's secret store: it is never printed, never an argument of a command, and never
 * seen by Claude. A window works from anywhere the command is started, a terminal or a skill,
 * which a prompt in the terminal does not.
 */
import { spawnSync } from "node:child_process";
import { ACCOUNTS, childEnv } from "../config.js";
import { osOf, powershellArgs, powershellPath, storeWords } from "../util/platform.js";
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

/** The Linux commands that show a hidden-answer window, in the order they are tried: GNOME's, then KDE's. */
export function linuxDialogCommands(message: string): { command: string; args: string[] }[] {
  return [
    { command: "zenity", args: ["--entry", "--hide-text", "--title=jev-job-search", `--text=${message}`, `--timeout=${ACCOUNTS.askSeconds}`] },
    { command: "kdialog", args: ["--title", "jev-job-search", "--password", message] },
  ];
}

const linuxDialog: Dialog = (message) => {
  for (const { command, args } of linuxDialogCommands(message)) {
    const r = spawnSync(command, args, { encoding: "utf8", env: childEnv(), timeout: (ACCOUNTS.askSeconds + 5) * 1000 });
    if (r.error) continue; // not installed: try the next one
    return r.status === 0 ? (r.stdout ?? "").replace(/\n$/, "") : null;
  }
  return null;
};

// A fixed script: the words come from the environment, and what was typed goes out on standard output.
export const WINDOWS_DIALOG = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$form = New-Object System.Windows.Forms.Form",
  "$form.Text = 'jev-job-search'",
  "$form.StartPosition = 'CenterScreen'",
  "$form.FormBorderStyle = 'FixedDialog'",
  "$form.MaximizeBox = $false",
  "$form.MinimizeBox = $false",
  "$form.TopMost = $true",
  "$form.ClientSize = New-Object System.Drawing.Size(460, 250)",
  "$label = New-Object System.Windows.Forms.Label",
  "$label.Text = $env:JEV_ASK_MESSAGE",
  "$label.SetBounds(14, 12, 432, 150)",
  "$box = New-Object System.Windows.Forms.TextBox",
  "$box.UseSystemPasswordChar = $true",
  "$box.SetBounds(14, 170, 432, 24)",
  "$save = New-Object System.Windows.Forms.Button",
  "$save.Text = 'Save'",
  "$save.DialogResult = [System.Windows.Forms.DialogResult]::OK",
  "$save.SetBounds(276, 208, 80, 28)",
  "$cancel = New-Object System.Windows.Forms.Button",
  "$cancel.Text = 'Cancel'",
  "$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel",
  "$cancel.SetBounds(366, 208, 80, 28)",
  "$form.Controls.AddRange(@($label, $box, $save, $cancel))",
  "$form.AcceptButton = $save",
  "$form.CancelButton = $cancel",
  "$form.Add_Shown({ $form.Activate(); $box.Focus() })",
  "if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }",
  "[Console]::Out.Write($box.Text)",
].join("\n");

const windowsDialog: Dialog = (message) => {
  const r = spawnSync(powershellPath(), powershellArgs(WINDOWS_DIALOG), { encoding: "utf8", env: childEnv({ JEV_ASK_MESSAGE: message }), timeout: ACCOUNTS.askSeconds * 1000 });
  return r.status === 0 ? (r.stdout ?? "") : null;
};

/** The hidden-answer window of this system. */
export const systemDialog = (): Dialog => {
  const os = osOf();
  return os === "mac" ? macDialog : os === "windows" ? windowsDialog : linuxDialog;
};

export type Asked = { ok: true; password: Secret } | { ok: false; why: "cancelled" | "mismatch" | "rules"; problems?: string[] };

/**
 * Asks for the password and its repeat, and checks it against the board's rules before anything
 * is stored. A password that misses a rule is asked for again, with the rule named, a few times.
 */
export function askPassword(dialog: Dialog = systemDialog(), o: { what?: string; existing?: boolean } = {}): Asked {
  // A password that already works at an employer is taken as it is. Only what the secret store cannot hand back as typed is refused.
  const check = (p: Secret) => passwordProblems(p).filter((x) => !o.existing || /plain keyboard/.test(x));
  const rules = o.existing ? "Type it exactly as you use it there." : "Workday wants 8 or more characters with a digit, a lower-case letter, an upper-case letter and a special character.";
  const what = o.what ?? "The one password for your job-board accounts.";
  let note = "";
  let last: Asked = { ok: false, why: "cancelled" };
  for (let round = 0; round < ACCOUNTS.askRounds; round++) {
    const first = dialog(`${note}${what}\n\nIt goes into ${storeWords()}. It is not shown, not saved in a file, and never sent to Claude or JEV.\n\n${rules}`);
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
