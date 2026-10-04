# Accounts

*How the tool applies on a job board that wants an account, what you have
to allow first, and what stays yours to do.*

Most of the boards the tool fills need no account. Workday does: every
employer on Workday keeps its own accounts, and you cannot see the form
until you are signed in. That is a large share of all postings. This page
is about letting the tool use those accounts for you.

Today the tool signs in on **Workday** and nowhere else. iCIMS, Taleo,
Oracle, SuccessFactors and LinkedIn are still skipped.

Everything here is off until you turn it on.

## What you allow, one thing at a time

| You allow | With | Without it |
|---|---|---|
| Signing in to accounts you have | `accounts add <link>` or `accounts add workday` | Workday jobs are skipped, as before |
| Making an account where an employer has none for you | `--create` | The job goes on your by-hand list |
| Ticking the account terms box on the sign-up form | `--terms` | The sign-up page is left open for you to accept |
| Reading the email the board sends to prove your address | `--verify-email`, and `gmail connect` | The tool waits; you click the link yourself |

A marketing or newsletter box on a sign-up form is never ticked.

## Turn it on

The `/accounts` skill asks you these questions and runs the commands. By
hand it is three steps.

**1. Say what the tool may do.** For every Workday employer:

```bash
npx jev accounts add workday --create --terms --verify-email
```

Or for one employer you already have an account with:

```bash
npx jev accounts add https://acme.wd5.myworkdayjobs.com/Careers
```

The address used is the one in your profile. `--email` gives another.
`--max-new 3` is the most new accounts in one day, and 3 is the default.

**2. Set the password.** One password for all your job-board accounts,
typed into your Mac's Keychain by you:

```bash
npx jev accounts password
```

Your Mac asks for it twice and does not show it. The tool checks it against
Workday's rules (8 or more characters, a digit, a lower-case letter, an
upper-case letter, a special character) and tells you which rule it misses.
It never prints the password, never writes it to a file, and never sends it
to Claude or JEV. Do not paste it into a chat.

If you already have accounts with some employers under another password,
the tool will find out on the first sign-in, stop, and leave that employer
to you. It does not try twice.

**3. Connect Gmail (optional).** Only if you used `--verify-email`. See
[Connect Gmail](#connect-gmail) below.

Then look at what is set up, and find the jobs:

```bash
npx jev accounts
```

```bash
npx jev discover
```

## What happens on a Workday job

```
open the posting's application
  already signed in as you            -> fill the form
  signed in as someone else           -> stops, waits for you
  you have an account here            -> sign in, once
       wrong password, locked         -> stops, waits for you, leaves the account alone
  no account here, and you allowed it -> sign up: your address, the password, the terms box
       "an account already exists"    -> sign in, once
       a robot check                  -> stops, waits for you
       "verify your email"            -> read the one email, open its link, sign in
  then the form, page by page, like any other
```

A rehearsal (`--dry`) sends no application, but the sign-in is real: if the
employer has no account for you and you allowed making one, one is made.

The first time, rehearse one job and read what it printed:

```bash
npx jev apply <a Workday posting's link> --dry
```

## What stays yours

The tool stops, keeps the page open in its window, sends you a
notification, and moves on to the next job, when it meets:

- a CAPTCHA or any "prove you are human" check
- a code sent to your phone, a passkey, or single sign-on
- account terms you did not approve
- a password the board refuses, or an account the board has locked
- a verification email it cannot use (see the rules below)
- a page it does not recognise

Finish it in the tool's window, then run:

```bash
npx jev resume --submit
```

`resume` sees that you are signed in, fills the form and, with `--submit`,
sends it when it is ready. Without `--submit` it fills and stops. For a
verification link you clicked in your own mail, `resume` signs in again to
see that the address is proven.

A code a board emails **because it suspects a robot** (Greenhouse does this
after several applications) is a human check, not an account verification.
The tool never reads or types that code, with or without Gmail connected.

## Limits

| Limit | Value |
|---|---|
| New employer accounts per day | 3, or what you set with `--max-new` |
| Jobs per new employer in one run | 1 |
| Sign-in tries per account per day | 3. A wrong password is never retried |
| After a refused password, a lockout, or a sign-in that did not go through | the account is left alone until you sign in yourself in the tool's window, or run `npx jev accounts status --clear`. Nothing is retried on a timer |
| Verification emails per sign-up | 1, and one request to send it again |

They are in `ACCOUNTS` and `GMAIL` in `src/config.ts`.

## Connect Gmail

When an employer wants your address proven, it emails you a link. With
Gmail connected, the tool finds that one email and opens the link. It has
**read-only** access: it cannot send, change or delete mail.

Google makes each person create their own "client" for this. It is free
and takes about five minutes, once.

1. Open https://console.cloud.google.com and create a project. Any name.
2. In **APIs and services**, open **Library**, find **Gmail API**, and
   click **Enable**.
3. Open **OAuth consent screen**. Choose **External**, give the app a name
   and your own address, and save. Then under **Audience**, click
   **Publish app**. An app left in "Testing" loses its connection every 7
   days. Publishing an app that only you use needs no review.
4. Open **Credentials** (or **Clients**), click **Create OAuth client**,
   choose **Desktop app**, and download the JSON file.
5. Connect:

```bash
npx jev gmail connect --client ~/Downloads/client_secret_XXXX.json
```

Your browser opens Google's consent page. Google warns that the app is not
verified, because it is yours and only you use it: choose **Advanced**,
then continue, and approve "View your email messages and settings". When
the terminal says it is connected, you can delete the downloaded file.

```bash
npx jev gmail status
```

```bash
npx jev gmail disconnect
```

`disconnect` withdraws the access at Google and removes the tokens from
your Keychain.

### Which email the tool will use

All of these must be true, or the tool stops and leaves the link to you:

- It comes from Workday's own mail domain, and Google's mail server
  verified that (DKIM or DMARC passed).
- It was sent to the address of that account.
- It arrived after the tool asked for it.
- It was not used before.
- It is the only one that fits. Two that fit is one too many.
- Its link is HTTPS, on that employer's own Workday address, with a
  verification path. A link to anywhere else is never opened, and a link
  that redirects off that address is stopped at the redirect.

The email's content goes to a small parser in `src/mail/verification.ts`
and nowhere else. It is never sent to Claude or JEV, never logged, and
never written to a file. The search the tool sends to Gmail names
Workday's senders and nothing about you.

## Where things are kept

| What | Where | In git? |
|---|---|---|
| What you allowed, and one entry per employer account | `data/accounts.json` | Never. `data/accounts.example.json` shows the shape |
| The password | macOS Keychain, service `jev-job-search`, item `accounts-password` | No file at all |
| Gmail's long-lived token and your client's secret | macOS Keychain, same service | No file at all |
| Which Gmail address is connected | `data/gmail.json` | Never |
| When each account last signed in, tries today, pauses, accounts made per day | `data/runs/accounts-state.json` | Never |
| Ids of verification emails already used | `data/runs/verifications.json` | Never |
| Your sign-in sessions | the tool's own Chrome profile, `data/runs/chrome-profile` | Never |

`data/accounts.json` holds no secret. You can read it and edit it.

On a machine with no Keychain, the password is read from
`JEV_ACCOUNTS_PASSWORD` in `.env`, and Gmail cannot be connected.

## Turn it off

```bash
npx jev accounts disconnect all
```

This forgets every account and the standing rule. Workday jobs are skipped
again from the next `discover`. The accounts themselves still exist on the
employers' sites; close them there if you want them gone. To remove the
password, open **Keychain Access**, search for `jev-job-search`, and delete
the item.

## What has been tested, and what has not

Said plainly, because nobody should find this out on a real application:

- **Tested without a real account.** The sign-in, the sign-up, the
  verification and every stop above run in the test suite against a
  scripted Workday, and against a mock Workday in a real Chrome on your
  machine, with made-up credentials. Workday's real sign-up and sign-in
  pages were read, with nothing typed, to take the control names from.
- **Not tested: a real sign-in.** No real account was made or signed in to
  while this was built. What Workday says after a wrong password, a
  lockout or a duplicate sign-up is matched by wording, and wording the
  tool does not recognise stops the job for you and pauses that account.
  It never guesses and never tries again by itself.
- **Not tested: Workday's application pages.** They cannot be seen without
  an account. The form filler treats them like any other form and holds
  whatever it cannot fill and read back. Expect the first rehearsals to
  hold on some pages (repeated work-history sections, search-as-you-type
  pickers). Run `--dry` first, and send the printed report with an issue.
