# macOS, Linux and Windows

The tool runs on all three. The commands and the skills are the same
everywhere; what differs is what the tool uses underneath, and how much of
it has been tried on a real machine.

## What it uses on each system

| | macOS | Linux | Windows |
|---|---|---|---|
| Browser | Google Chrome | Google Chrome, or Chromium | Google Chrome, or Microsoft Edge when Chrome is not installed |
| Where passwords and tokens are kept | The Keychain | The desktop keyring (GNOME Keyring, KWallet), through `secret-tool` | Credential Manager, under Windows Credentials |
| The window that asks for a password | A system dialog | `zenity`, or `kdialog` on KDE | A small window drawn by Windows PowerShell |
| Notifications | Notification Center | `notify-send` | A balloon in the notification area |
| Opening a link or a file | `open` | `xdg-open` | The system's own handler |
| The daily schedule | A LaunchAgent | A systemd user timer | A task in Task Scheduler |

A browser in an unusual place is named in `.env`:

```
CHROME_PATH=/full/path/to/chrome
```

`npx jev doctor` says which browser was found and what is missing.

## What you need to install

Node.js 22 or newer, a browser from the table, and your coding agent, on
every system. The rest is only for [boards that want an account](ACCOUNTS.md);
without it, everything else works.

**Linux.** The keyring command, the password window and notifications:

```bash
sudo apt install libsecret-tools zenity libnotify-bin     # Debian, Ubuntu
sudo dnf install libsecret zenity libnotify               # Fedora
```

The tool drives a browser window you can see, so it needs a desktop session.
On a server with no display it can find and rate jobs (`/discover`), and
nothing more. Under WSL it counts as Linux and needs WSLg for the window.

On a Linux machine with no `secret-tool`, the tool keeps no password at all:
the one way left is `JEV_ACCOUNTS_PASSWORD` in `.env`, which is a file, so
install the keyring instead if you can.

**Windows.** Nothing beyond the list above. Windows PowerShell 5.1, which
every Windows 10 and 11 has, is what reaches Credential Manager; you do not
need to open it. Run the commands in PowerShell, Windows Terminal or your
agent as written.

Codex looks for the skills under `.agents/skills`, which is a symbolic link.
Git on Windows makes real links only with Developer Mode on (or
`git config --global core.symlinks true` in an elevated shell) before you
clone. Without that, the skills are still at `.claude/skills`, and
`AGENTS.md` lists them.

## What has been tested, and what has not

Said plainly, because a tool that fills forms in your name should not claim
more than it has done.

| | macOS | Linux | Windows |
|---|---|---|---|
| The whole test suite, on every push | Yes | Yes | Yes |
| A real browser driven through a sign-in on a scripted board, and the dashboard page | Yes | Yes (CI) | Yes (CI) |
| A value kept, read back, replaced and removed in the system's real secret store | Yes (CI) | Yes (CI, GNOME Keyring) | Yes (CI, Credential Manager) |
| A command installed by npm started with its arguments intact | Yes | Yes | Yes (CI, through a `.cmd` file) |
| Real applications, start to finish | Yes: this is where every number in the README comes from | **Not yet** | **Not yet** |
| The password window, a notification, an installed schedule | Yes | **Not yet**, covered by tests with stand-in commands only | **Not yet**, covered by tests with stand-in commands only |
| The writer | Claude Code and the Claude API | **Not yet** | **Not yet** |

So on Linux and Windows the parts are tested and the whole is not. Rehearse
first (`/apply --dry`), read what it filled, and please open an issue saying
what worked and what did not: that is the most useful thing a Linux or
Windows user can send right now.

## Things that behave differently

- **The system prompt on Windows.** A Windows command line is too short to
  carry everything the writer is told about you, so for Claude Code it is
  written to a file under `data/runs/` (git-ignored, with your other run
  data) and removed when the call ends.
- **The schedule needs you signed in.** On every system the daily run opens
  a browser window, so it runs only while you are signed in to your desktop.
  On Linux that means a graphical session whose environment systemd knows
  about, which GNOME and KDE arrange by themselves.
- **Files in use on Windows.** Windows refuses to replace a file another
  program has open. The tool waits a moment and tries again, so a virus
  scanner looking at `data/queue.json` does not fail a run.
