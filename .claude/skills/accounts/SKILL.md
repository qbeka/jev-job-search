---
name: accounts
description: Let the tool apply on job boards that want an account (Workday today). Use when the user says /accounts or /account, with or without a subcommand (add, password, gmail, clear, remove), "Workday", "sign in for me", "why are Workday jobs skipped", or asks to connect Gmail for verification emails.
argument-hint: "[add workday | add <link> | password | gmail <client file> | clear | remove <id or all>]"
model: claude-sonnet-5-5
effort: medium
---

# /accounts

The user types a short command; you run the tool for them. They should
never have to type `npx`. `docs/ACCOUNTS.md` is the reference. Everything
here is off until the user turns it on.

## What the user can type

| They type | You do |
|---|---|
| `/accounts` | Run `npx jev accounts` and `npx jev gmail status`. Say in two or three sentences what is set up and what the next step is. |
| `/accounts add workday` | Ask the three questions below unless they already answered, then run `npx jev accounts add workday` with exactly the flags they agreed to. |
| `/accounts add <link>` | One employer they already have an account with: `npx jev accounts add <link>`. Add `--create` only if they say the tool may make it. |
| `/accounts password` | Run `npx jev accounts password`. A window opens on their Mac; they type the password there, twice. Tell them to look for the window. You never see it. |
| `/accounts gmail` | Walk them through "Connect Gmail" in `docs/ACCOUNTS.md` one step at a time until they have the client file. Then `/accounts gmail <file>`. |
| `/accounts gmail <file>` | Run `npx jev gmail connect --client <file>`. Their browser opens Google's consent page; approving is theirs. |
| `/accounts clear` | `npx jev accounts status --clear`, after they fixed what paused an account. |
| `/accounts remove <id or all>` | `npx jev accounts disconnect <id or all>`. `all` also needs `npx jev gmail disconnect` if they want mail access gone. Confirm `all` first. |

After any of these, run `npx jev accounts` and read the result back.

## The three questions for `add workday`

Each is a separate yes. Ask only what they have not said:

1. May the tool **make** an account where an employer has none for you, or
   only sign in to accounts you have? (`--create`)
2. May it tick the **account terms** box on a sign-up form? That accepts
   each employer's candidate-account terms for you. A marketing box is
   never ticked. (`--terms`)
3. May it read the **verification email** an employer sends? Read-only
   Gmail, that one email. Without it you click each link yourself.
   (`--verify-email`)

`--max-new 3` is the default: at most three new accounts a day.

## What you never do

- **Never ask for, read, type or repeat a password, a code or a token**,
  in chat, in a file or in a command. The password goes into the Mac's own
  window. Never read the Keychain, `.env` or the tool's Chrome profile.
- **Never run anything that signs in or signs up at an employer.** That is
  `apply` on a Workday job, with or without `--dry`, and `daily` or
  `resume --submit` when Workday is allowed. Show the command in a `bash`
  block; the app puts a Run button on it, so it is one click for them:

  ```bash
  npx jev apply <the Workday link> --dry
  ```

- **Never pass a human check**: a CAPTCHA, a phone code, a passkey, or the
  code a board emails because it suspects a robot.
- **Never allow more than they said.** No flag they did not agree to, and
  no edit to `data/accounts.json` by hand.
- If the permission system declines a command, do not try another way.
  Show the command in a `bash` block for them to run with one click.

## The first Workday job

Once the password is stored, run `npx jev discover` so Workday jobs enter
the queue, and say how many did. Then give them the first rehearsal to
start themselves (the block above). Say plainly: it sends no application,
but it signs in for real and makes the account if there is none. Ask them
to paste what it printed; it holds no secret. Workday's application pages
were not seen while the tool was built, so a first form may hold on a
page. Each held field names what to fix.

## When something waits for the user

A paused account (a refused password, a lockout, a sign-in that went
nowhere) stays paused until they sign in themselves in the tool's Chrome
window, or fix it and type `/accounts clear`. Forms that wait are listed
by `/status`; `/resume` picks them up.
