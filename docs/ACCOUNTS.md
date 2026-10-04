# Accounts

> **In progress.** Two parts of the tool are still being built and are off by default: applying on boards that want an account (Workday, with `/accounts`), and the Google connection (Gmail, for verification emails and for `/inbox`). One real Workday application (a six-step form at one employer) has been taken from the sign-in to a confirmed submission; other employers lay their forms out differently and are untested. The Gmail connection has not been run against a real mailbox. Until this note is gone, use the tool on the boards that need no account: Greenhouse, Lever, Ashby and the others listed in [SOURCES.md](SOURCES.md).

*How the tool applies on a job board that wants an account, what you
decide, and what stays yours to do.*

Most of the boards the tool fills need no account. Workday does: every
employer on Workday keeps its own accounts, and you cannot see the form
until you are signed in. That is a large share of all postings.

Today the tool signs in on **Workday** and nowhere else. iCIMS, Taleo,
Oracle, SuccessFactors and LinkedIn are still skipped.

Everything here is off until you turn it on. There are three ways to use
it, from the simplest to the most automatic. Start with the first.

| | What you do | What the tool does | Status |
|---|---|---|---|
| **1. You sign in once** | Sign in at an employer yourself, in the tool's Chrome window | Keeps that session and uses it for jobs at that employer | Works today |
| **2. It signs in for you** | Store that employer's password, once | Signs in when the session has ended | Tested on scripted pages only |
| **3. It makes accounts** | Say that it may, and whether it may accept terms and read verification mail | Makes an account with its own random password where you have none | **Experimental** |

## 1. Sign in once yourself

```
/accounts signin <employer>
```

The employer's page opens in the tool's own Chrome window. You sign in
there, or make your account there, the way you always would: your
password, a code on your phone, a robot check, whatever it asks. The tool
types nothing. When the page shows the application, the tool notes that
this employer is yours, keeps the session, and from then on fills that
employer's forms like any other.

`<employer>` is the name as it appears in the employer's Workday address
(`acme` in `acme.wd5.myworkdayjobs.com`), or the link of one of its
postings. Jobs at employers you have signed in to are found by the next
`/discover`.

A session does not last. At the one employer this was tried on, it had
ended within the hour. When it has ended and you apply to a job you named
(`/apply <job>`), the sign-in page comes to the front, you get a
notification, and the run waits up to five minutes for you to sign in
again; then it fills the form. In a batch or a daily run the job waits
for you instead (`/resume` once you have signed in). Nothing is stored
except the session in the tool's Chrome. If signing in each time is too
much, way 2 is for that.

## 2. Let it sign in when the session ends

There are two ways. The first keeps the password in the tool's own Chrome,
where you may already have saved it when you signed in:

```
/accounts browser acme
```

From then on, when that Chrome has filled the sign-in page in, the tool
presses Sign In. It types nothing and never reads the password. A sign-in
the employer refuses is not tried again. `/accounts browser acme --off`
takes it back. The second way keeps the password in your Keychain:

```
/accounts password <employer>
```

A window opens on your Mac. You type that employer's password there,
twice, hidden. It goes into your Mac's Keychain under that employer's
name and is never shown, written to a file, or sent to Claude or JEV. Do
not paste a password into a chat.

Each employer has its own password in the Keychain. If you use one
password on several accounts you already had, `/accounts password` with
no employer stores that one, and it is tried once at an employer that has
none of its own.

A password the employer refuses is never tried twice. That account is
paused and the page is left open for you. Then either sign in yourself in
the tool's window, or type `/accounts password <employer>` again with the
right one. Both lift the pause; `/resume` carries on.

## 3. Let it make accounts (experimental)

```
/accounts add workday
```

This asks you three things, shows you in plain words what your answers
allow, and saves them only after you say yes.

| You allow | Without it |
|---|---|
| Making an account where an employer has none for you. Each is a real account with that employer, in your name, under your address | The job is left for you |
| Ticking the box that accepts the employer's candidate-account terms. You are agreeing to each employer's terms without reading them one by one | The sign-up page is left open for you to accept |
| Reading the one email the employer sends to prove your address, through Gmail if you connected it | You click the link in the email yourself |

A marketing or newsletter box is never ticked. At most 3 new accounts are
made in a day.

**You choose no password.** Each new account gets its own long random
password, made by the tool and kept in your Keychain before anything is
typed. No two employers share one. To sign in by hand later, open
**Keychain Access**, search for `jev-job-search`, and look at the item
named `account:workday:<employer>`, or use the employer's "Forgot your
password?" link.

Making the account is a separate step from rehearsing, and it is always
started by you:

```
/accounts setup <employer>
```

A rehearsal (`--dry`) never makes an account and never asks an employer
for a verification email. Where an account is missing, the rehearsal says
so and names this command.

To say that one employer is different from the rest, in a terminal:

```bash
npx jev accounts add https://acme.wd5.myworkdayjobs.com/Careers --off
```

`--off` leaves that employer alone whatever the rule says. Without it, the
same command with `--create`, `--terms` or `--verify-email` sets that one
employer's own answers.

Why this is marked experimental: no real account was made while it was
built. What Workday says after a sign-up is matched by wording, and its
verification emails have not been seen. Wording the tool does not know
stops the job for you; it never guesses and never tries again by itself.

## What happens on a Workday job

```
open the posting's application
  already signed in as you            -> fill the form
  signed in as someone else           -> stops, waits for you
  you have an account here
       its password is stored         -> sign in, once
            refused, locked, unclear  -> stops, pauses that account, waits for you
       no password stored             -> stops, waits for you to sign in
  no account here, and you allowed it -> (never in a rehearsal) sign up with a new random password
       "an account already exists"    -> sign in, once, if a password for it is stored
       a robot check                  -> stops, waits for you
       "verify your email"            -> read the one email, open its link, sign in; or wait for you to click it
  then the form, page by page, like any other
```

## What stays yours

The tool stops, keeps the page open in its window, sends you a
notification, and moves on to the next job, when it meets:

- a CAPTCHA or any "prove you are human" check
- a code sent to your phone, a passkey, or single sign-on
- account terms you did not approve
- a password the employer refuses, or an account it has locked
- a verification email it may not read or cannot use
- a page it does not recognise

Finish it in the tool's window, then type `/resume`.

A code a board emails **because it suspects a robot** (Greenhouse does
this after several applications) is a human check, not an account
verification. The tool never reads or types that code, with or without
Gmail connected.

## Every command

In Claude Code, type the left column. Nothing here needs a terminal.

| Type | What happens | In a terminal |
|---|---|---|
| `/accounts` | What is set up, and the next step. With nothing set up, it walks you through way 1 | `npx jev accounts` |
| `/accounts signin <employer>` | Opens that employer's page for you to sign in yourself | `npx jev accounts signin <employer>` |
| `/accounts password <employer>` | A window asks for that employer's password | `npx jev accounts password <employer>` |
| `/accounts add workday` | Asks what the tool may do for every Workday employer, shows what that allows, saves after a yes | `npx jev accounts add workday --create --terms --verify-email`, with `--preview` to see it first |
| `/accounts setup <employer>` | Signs in, or makes the account where you allowed it. Always started by you | `npx jev accounts setup <employer>` |
| `/accounts clear` | Lifts every pause, after you fixed what caused it | `npx jev accounts clear` |
| `/accounts off`, `/accounts on` | Switches every sign-in off, and on again. Everything you set up is kept | `npx jev accounts off` |
| `/accounts forget <employer or all>` | Removes from this Mac the entry, its stored password and its session | `npx jev accounts forget all --yes` |
| `/accounts gmail` | Connects Gmail for verification emails | `npx jev gmail connect --client <file>` |

## Turning it off, and removing what is stored

These are two different things, and neither deletes an account at an
employer.

- **`/accounts off`** stops the tool from signing in anywhere. Your
  settings, the stored passwords and the sessions stay, so `/accounts on`
  brings everything back. Workday jobs are skipped while it is off.
- **`/accounts forget <employer>`**, or `all`, removes what this Mac
  holds: the entry, that account's password in the Keychain, what the tool
  remembered about it, and its sign-in session in the tool's Chrome.
  `all` also removes the standing rule.

The account itself still exists at the employer. To close it, do that on
the employer's own site.

## Limits

| Limit | Value |
|---|---|
| New employer accounts per day | 3, or what you set with `--max-new` |
| Jobs per new employer in one run | 1 |
| Sign-in tries per account per day | 3. A refused password is never retried |
| After a refused password, a lockout, or a sign-in that did not go through | the account is left alone until you sign in yourself, store the right password, or type `/accounts clear`. Nothing is retried on a timer |
| Verification emails per sign-up | 1, and one request to send it again |

They are in `ACCOUNTS` and `GMAIL` in `src/config.ts`.

## Verification emails

When an employer wants your address proven, it emails you a link.

**The default: you click it.** The tool leaves the page open and tells
you. Click the link in your own mail, then type `/resume`. This needs no
setup at all.

**Advanced, experimental: connect Gmail.** The tool then finds that one
email and opens its link, so a new account needs nothing from you. It has
read-only access: it cannot send, change or delete mail.

Connecting Gmail takes a Google Cloud project of your own. That is a
choice this project made, not a rule of Google's: a tool can also ship one
shared Google sign-in for everybody, but Google asks the developer of such
an app to pass a security review before it may read mail, and this project
has not done that. Until it does, each person brings their own. Allow 15
to 30 minutes the first time; Google's console changes often, and the
names below may have moved.

1. Open https://console.cloud.google.com and create a project.
2. In **APIs and services**, open **Library**, find **Gmail API**, and
   click **Enable**.
3. Open the **OAuth consent screen** (Google now also calls it "Google
   Auth Platform"). Choose **External**, give the app a name and your own
   address, and save. Add your own address as a test user. An app left in
   "Testing" loses its connection every 7 days; **Publish app** under
   **Audience** removes that limit, and an app only you use is not
   reviewed.
4. Open **Credentials** (or **Clients**), create an **OAuth client**
   of type **Desktop app**, and download its JSON file.
5. Type `/accounts gmail <that file>`, or in a terminal:

```bash
npx jev gmail connect --client ~/Downloads/client_secret_XXXX.json
```

Your browser opens Google's consent page. Google warns that the app is not
verified, because it is yours and only you use it: choose **Advanced**,
continue, and approve "View your email messages and settings". When it
says connected, you can delete the downloaded file.
`npx jev gmail status` shows the connection, and `npx jev gmail
disconnect` withdraws it at Google and removes the tokens from your
Keychain.

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

These rules were written without a real Workday verification email to
check them against. They are strict on purpose: if Workday's real emails
come from another sender, or link through another address, the tool
refuses them and you click the link yourself. Nothing unsafe happens; the
automation just does not help yet. If that happens to you, an issue with
the sender's domain and the link's host (not the link itself) is what
lets the rules be widened to what Workday really sends.

The email's content goes to a small parser in `src/mail/verification.ts`
and nowhere else. It is never sent to Claude or JEV, never logged, and
never written to a file.

## Where things are kept

| What | Where | In git? |
|---|---|---|
| What you allowed, and one entry per employer account | `data/accounts.json` | Never. `data/accounts.example.json` shows the shape |
| Each employer account's password | macOS Keychain, service `jev-job-search`, item `account:workday:<employer>` | No file at all |
| The password for accounts you already had, if you stored one | macOS Keychain, item `accounts-password` | No file at all |
| Gmail's long-lived token and your client's secret | macOS Keychain, same service | No file at all |
| Which Gmail address is connected | `data/gmail.json` | Never |
| When each account last signed in, tries today, pauses, accounts made per day | `data/runs/accounts-state.json` | Never |
| Ids of verification emails already used | `data/runs/verifications.json` | Never |
| Your sign-in sessions | the tool's own Chrome profile, `data/runs/chrome-profile` | Never |

`data/accounts.json` holds no secret. You can read it and edit it.

On a machine with no Keychain, a password is read from `.env`
(`JEV_ACCOUNTS_PASSWORD` for the shared one), new accounts cannot be made,
and Gmail cannot be connected.

## What has been tested, and what has not

- **Tested without a real account.** Signing in, signing up, the
  verification and every stop above run in the test suite against a
  scripted Workday, and against a mock Workday in a real Chrome on this
  machine, with made-up credentials. Workday's real sign-up and sign-in
  pages were read, with nothing typed, to take the control names from.
- **Not tested: a real sign-in or sign-up.** What Workday says after a
  wrong password, a lockout or a duplicate sign-up is matched by wording.
- **Not tested: a real verification email.** See above.
- **Not tested: Workday's application pages.** They cannot be seen
  without an account. The form filler treats them like any other form and
  holds whatever it cannot fill and read back. Expect the first rehearsals
  to hold on some pages (repeated work-history sections, search-as-you-type
  pickers). Rehearse first, and send the printed report with an issue.

Way 1 depends on the least of this: you do the signing in, and the only
untested part is the form itself.
