---
name: accounts
description: Let the tool apply on job boards that want an account (Workday today). Asks what the person allows, sets it up, and explains what stays theirs. Use when the user says "accounts", "Workday", "sign in for me", "why are Workday jobs skipped", or asks to connect Gmail for verification emails.
---

# /accounts

Read `docs/ACCOUNTS.md` first. It is the reference; this skill is the
conversation. Everything here is optional and off by default.

## What you never do

- **Never ask for, read, type or repeat a password, a code or a token.**
  Not in chat, not in a file, not in a command you run. The password is
  typed by the person into their Mac's own prompt.
- **Never run a sign-in, a sign-up or `gmail connect` yourself.** These
  touch the person's real accounts. Give them the command in a `bash`
  block and wait. This includes `apply` on a Workday job, with or without
  `--dry`: a rehearsal still signs in and may make an account.
- **Never read the Keychain**, `.env`, `data/gmail.json` tokens or the
  tool's Chrome profile.
- **Never pass a human check.** A CAPTCHA, a phone code, a passkey, and
  the code a board emails because it suspects a robot are the person's.
- Do not edit `data/accounts.json` to allow more than the person said.

## The conversation

1. Run `npx jev accounts` and `npx jev doctor`, and say in one or two
   sentences what is set up now.

2. Ask, one question at a time, and only what is not already set:
   - Do you want the tool to apply on Workday? Every employer there wants
     its own account.
   - Which address should the accounts use? The default is the one in the
     profile.
   - May it **make** an account where an employer has none for you, or
     only sign in to accounts you already have?
   - If it may make accounts: may it tick the **account terms** box on the
     sign-up form? Say that this accepts each employer's candidate-account
     terms on their behalf, and that marketing boxes are never ticked.
   - If it may make accounts: may it read the **verification email** the
     employer sends? That needs Gmail connected, read-only. Without it,
     they click each link themselves.
   - How many new accounts a day at most? 3 is the default and is meant to
     look like one careful person.

3. Run the command that says exactly what they allowed, and nothing more:

   ```bash
   npx jev accounts add workday --create --terms --verify-email --max-new 3
   ```

   Leave out each flag they did not agree to. For one employer they
   already have an account with: `npx jev accounts add <link>`.

4. Give them the password step to run themselves, in their own terminal:

   ```bash
   npx jev accounts password
   ```

   Tell them: one password for all job-board accounts, typed twice, not
   shown, kept in the Mac's Keychain, never sent to Claude or JEV. Workday
   wants 8 or more characters with a digit, a lower-case letter, an
   upper-case letter and a special character. If they already have
   Workday accounts under another password, the tool stops at the first
   sign-in and leaves that employer to them.

5. If they allowed the verification email, walk them through "Connect
   Gmail" in `docs/ACCOUNTS.md`, one step at a time, and give them:

   ```bash
   npx jev gmail connect --client ~/Downloads/client_secret_XXXX.json
   ```

   They run it. Remind them to publish the Google app (step 3 there), or
   the connection ends after 7 days.

6. Run `npx jev accounts` and `npx jev doctor` again and read the result
   back. Then `npx jev discover` so Workday jobs enter the queue. Say how
   many did.

7. Give them the first rehearsal to run themselves, on one job:

   ```bash
   npx jev apply <a Workday link from the queue> --dry
   ```

   Say plainly: this sends no application, but it signs in for real and
   makes the account if there is none. Ask them to paste what it printed
   (it holds no secret). Read it with them. Workday's application pages
   were not seen while the tool was built, so the first forms may hold on
   a page; that is expected, and each held field names what to fix.

## When something waits for the person

`npx jev status` and `/report` list forms that wait. For each, say what
the page asks for (the reason is on the row), and that they finish it in
the tool's own Chrome window and then run:

```bash
npx jev resume --submit
```

A paused account (a refused password, a lockout) stays paused for a day.
After they fixed it: `npx jev accounts status --clear`.

## Turning it off

`npx jev accounts disconnect all` forgets every account and the rule.
`npx jev gmail disconnect` withdraws mail access. Say that the accounts
still exist on the employers' sites.
