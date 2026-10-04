# jev-job-search

*The job search that fills the forms for you.*

[![ci](https://github.com/qbeka/jev-job-search/actions/workflows/ci.yml/badge.svg)](https://github.com/qbeka/jev-job-search/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/qbeka/jev-job-search?label=release)](https://github.com/qbeka/jev-job-search/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An open-source job application tool built on [Claude Code](https://claude.com/claude-code). It finds software internships and new-grad roles, fills the application forms in a Chrome window you can watch, reads every answer back from the page, and sends the ones you approve.

| | |
|---|---|
| **Who it is for** | Students and new graduates applying to software roles in Canada, the United States or remotely, who are comfortable opening a terminal once. It writes in English. |
| **What you need** | A Mac with Google Chrome, [Node.js](https://nodejs.org) 22, and [Claude Code](https://claude.com/claude-code) with a Claude Pro or Max subscription. |
| **What it costs** | Your Claude subscription, plus a few dollars of [OpenRouter](https://openrouter.ai/keys) credit for JEV: about 1 to 1.5 cents per 10 applications. Nothing else. |
| **How to start** | Clone it, run `npm install`, open `claude` in the folder and type `/setup`. About 20 minutes, most of it your answers. It ends with one application filled and waiting for your yes. |
| **What it checks** | Your right to work, education and dates are taken from your profile and never changed to fit a form. Every answer is read back from the page before a form is sent. A human check is left to you. It can only be as truthful as the profile you give it. |
| **What it is not** | A download-and-open app: there is no installer yet. And it is a beta: forms on boards it has not met will hold, and it says so. |

> This is an independent open-source project. It is not affiliated with, endorsed by or maintained by Anthropic, OpenRouter, or any job board. There is no token, coin or paid tier; the only ways to support it are using it and contributing on GitHub.

## Does it actually work?

It is how I run my own search. I sent 100 applications in less than 10 minutes across Ashby, Lever, Workable, Rippling, BambooHR, Jobvite and JazzHR forms, for about a dollar in JEV, while fixing what it got wrong on each new kind of form. Every answer on every one of those forms was read back from the page before it was sent, and every form it could not finish truthfully is in `applications/manual.csv` with the reason. The numbers it reports about itself are in [How well it works](docs/USAGE.md#how-well-it-works). I will add what came of the applications once I know.

## What this is

A command-line tool, a set of Claude Code skills that run it with you in the loop, and a dashboard on your own machine. Two models share the thinking: [JEV](https://openrouter.ai/typesafe/jev-1.13) makes every decision that has a fixed set of answers (which of your details goes in this box, which option, how good a fit this job is) for a fraction of a cent, and Claude, on your own subscription, writes the sentences. The code does the rest: finds the jobs, drives Chrome, checks every answer on the page, and keeps your records.

```
/setup              /discover              /apply
  |                    |                      |
  v                    v                      v
Your resume        Read public job        Fill each form in Chrome
and a short        lists and company      JEV picks every option
interview          boards                 Claude writes the sentences
  |                    |                      |
  v                    v                      v
Profile files      Ranked queue with      Read every answer back
ready              fit scores             Send only what is ready
                       |                      |
                       v                      v
                   Pick what to send    applications/applied.csv
                   -> /apply            manual.csv for what is yours
```

Four checks are built into the code. Your right to work, your education and your dates come from your profile and are not changed to fit a form; a required question the profile cannot answer holds the form. Every value is read back from the page, and a form is sent only when all of them are there. A human check stops the form for you. A sign-in happens only with an account you set up. What the tool cannot finish, it lists for you with the reason.

## Prerequisites

- A Mac with Google Chrome. The tool opens its own Chrome window with its own profile; your everyday browser is not touched.
- [Node.js](https://nodejs.org) 22 or newer.
- [Claude Code](https://claude.com/claude-code), signed in. Claude Code has no free tier: you need a Claude Pro or Max subscription, or a Claude API key in `.env` (then the commands work and the skills do not; see [Claude Code or the Claude API](#claude-code-or-the-claude-api)).
- An [OpenRouter](https://openrouter.ai/keys) account with a few dollars of credit. That pays for JEV, the only separate bill: about 1 to 1.5 cents for every 10 applications, and 7 to 9 cents per search. Five dollars covers about 60 searches and 3,000 applications. See [What it costs](#what-it-costs).

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/qbeka/jev-job-search
cd jev-job-search
npm install
```

> [!IMPORTANT]
> Everything about you stays in git-ignored files (`data/`, `documents/`, `applications/`, `.env`), so your own clone can be pushed anywhere without leaking anything. Fork only to contribute.

### 2. Set up your profile

```bash
claude
# Then inside Claude Code:
/setup
```

`/setup` checks what is installed, reads your resume PDF and anything else you drop into `documents/` (old resumes, a LinkedIn export, past applications), asks only what those do not say (where you may work, what you are looking for, how you want recurring questions answered), opens `.env` for you to paste your OpenRouter key, builds your profile, finds jobs, rehearses three forms without sending so you can correct what it got wrong, and ends with one real application filled and waiting for your yes. About 20 minutes, most of it your answers. `/setup` is safe to run again.

### 3. Find jobs

```
/discover
```

Reads the public lists and the company boards, drops the jobs you could not or would not apply to (no work authorization, wrong level, closed), rates the rest with JEV against your profile, and writes a ranked queue. Run it every day or two; a posting that has not changed is not rated again.

### 4. Apply

```
/apply
```

Fills the best queued forms, one Chrome tab each, answers what JEV left open with Claude, reads every value back from the page, and sends each form the moment it is ready once you say so. Every result is printed as it happens. Your records appear in `applications/`.

### 5. Apply to one posting you found yourself

```
/apply https://jobs.ashbyhq.com/company/job-id
```

A Greenhouse, Lever or Ashby link is read from the board, rated, and filled like any other. A Workday link needs `/accounts`, which is [in progress](#jobs-that-want-an-account). For another board, `/discover` picks it up when it appears on the public lists.

## Other commands

`/setup`, `/discover` and `/apply` are the workflow. Eleven more skills extend it once your profile is in place. Each is typed in Claude Code as written; none needs a terminal:

- **`/tailor <job id> [--cover]`** writes a one-page resume for the job from your profile and the posting, and with `--cover` a one-page cover letter, and shows you the PDFs. Every number and every name of a tool, a place or a company in the draft is checked against your profile in code; the keywords the posting wants and your profile cannot support are listed, never stuffed in. `/apply --tailor --cover` writes and attaches them as it applies. See [A resume and a cover letter written for the job](#a-resume-and-a-cover-letter-written-for-the-job).
- **`/report`** opens the dashboard on your own machine, the main screen once you are set up. **Today** is the day in one line. **Needs you** lists everything only you can do: a question a form asked that your profile could not answer, with a box and "Save for next run"; a form waiting for a code or a sign-in, with "Show the form"; a submission that was never confirmed. **Applications** is every job with its status, your notes and the reply that came back. **Automation** is the daily run as a switch, a time and your rules. Nothing leaves your machine.
- **`/inbox`** (in progress) reads your connected Gmail, read-only, for replies to applications you sent: received, rejected, an assessment, an interview, an offer. It looks at the sender, the subject and Gmail's own short preview, never the body. What it is not sure of waits for you under "Needs you".
- **`/expand`** reads the public places your profile already links to (your GitHub repositories, your portfolio site) and proposes projects, skills and facts that are missing from the profile, each with its source. Nothing is added without your yes.
- **`/add-source`** adds a job board or a public list as a source: it inspects the site, writes the source in the shape of the shipped ones, tests it on a captured sample and runs one live query before registering it.
- **`/accounts`** (in progress) lets the tool apply on Workday, where every employer wants its own account. The simple way: `/accounts signin <employer>` opens that employer's page, you sign in once yourself, and the tool keeps the session. Storing a password, and letting the tool make accounts for you (experimental), are there when you want them. Off until you turn it on. See [Jobs that want an account](#jobs-that-want-an-account).
- **`/daily`** is the daily run: a few applications a day with nobody watching, inside a standing policy you write (how many, where, which employers never) and limits meant to look like one careful person: 15 a day, one per employer, minutes between two applications to one board, a full stop when boards start asking for a human check. `/daily dry` rehearses it, `/daily run` runs today's, and `/daily schedule 09:00` makes it run by itself; nothing is scheduled until you type that. `/daily pause` removes the schedule, and `/daily stop` asks a run that is working to stop after the application it is on. See [docs/DAILY.md](docs/DAILY.md).
- **`/resume`** picks up the forms that wait for you. A board that emails a code, shows a robot check or needs a sign-in only you can finish leaves its form open in the tool's window; you do that one thing there, type `/resume`, and the application is recorded. It also settles a form whose Submit was clicked with no confirmation seen, which is never sent twice.
- **`/status`** says where you stand in a few lines: sent today and in total, what waits for you, what is left for you and why, how fresh the queue is, what it has cost, and the next step.
- **`/profile`** changes your profile, your standing answers (how recurring questions are answered), your drafts and your voice guide with you. When a form answer looked wrong, this is where you fix it, once.

#### In a terminal

Every skill runs a command you can also type yourself, as `npx jev <command>` from the project folder. You never have to; scripts and schedulers do.

| Skill | The same in a terminal |
|---|---|
| `/discover` | `npx jev discover` |
| `/apply`, `/apply <link>` | `npx jev apply --count 10 --submit`, `npx jev apply <link> --submit` |
| `/tailor <job id>` | `npx jev tailor <job id> --cover` |
| `/report` | `npx jev report --open` |
| `/accounts`, `/accounts signin acme`, `/accounts password acme` | `npx jev accounts`, `npx jev accounts signin acme`, `npx jev accounts password acme` |
| `/daily dry`, `/daily run`, `/daily schedule 09:00`, `/daily pause`, `/daily stop` | `npx jev daily --dry`, `npx jev daily`, `npx jev schedule install --at 09:00`, `npx jev schedule remove`, `npx jev daily --stop` |
| `/resume` | `npx jev resume`, `npx jev reconcile` |
| `/status` | `npx jev status`, `npx jev doctor`, `npx jev cost`, `npx jev log` |
| `/inbox` | `npx jev inbox --days 7` |

`npx jev log --open` opens your applications in your spreadsheet program, `npx jev knowledge --share` copies what your runs learned about job sites into the repo for a pull request (site names and kinds of controls, nothing about you), and `npx jev --help` lists everything, including the apply loop one step at a time (`fill`, `resolve`, `submit`, `check`, `inspect`, `set`).

## File structure

```
jev-job-search/
├── CLAUDE.md                  # Rules for Claude Code when it works on the code
├── .claude/skills/
│   ├── setup/                 # /setup: from a clone to the first rehearsal
│   ├── discover/              # /discover: build the ranked queue
│   ├── apply/                 # /apply: fill, check, send
│   ├── tailor/                # /tailor: a resume and a cover letter per job
│   ├── report/                # /report: the dashboard
│   ├── expand/                # /expand: enrich the profile from your public links
│   ├── add-source/            # /add-source: a new job board or list
│   ├── accounts/              # /accounts: boards that want an account (Workday)
│   ├── daily/                 # /daily: the daily run and its schedule
│   ├── inbox/                 # /inbox: replies to your applications, from your mail
│   ├── resume/                # /resume: pick up the forms that wait for you
│   ├── status/                # /status: where you stand, in a few lines
│   └── profile/               # /profile: change what the tool knows about you
├── applications/              # Your records (git-ignored)
│   ├── applied.csv            #   what was sent, newest first
│   ├── manual.csv             #   what the tool left for you, with the reason and the link
│   ├── takehome.csv           #   take-home assignments to do
│   └── all.csv                #   every job considered
├── documents/                 # Your files (git-ignored)
│   ├── resume.pdf             #   the resume you send
│   ├── transcript.pdf         #   for forms that ask for one
│   └── tailored/              #   <Company>_<Role>_<id>/ resume.pdf, cover.pdf, resume.md
├── data/                      # Your profile and the tool's working files (git-ignored, examples tracked)
│   ├── accounts.json          #   the job-board accounts you allowed (no password in it)
│   ├── policy.json            #   your standing instructions for the daily run
│   ├── profile.json           #   who you are; standing answers to recurring questions
│   ├── bank.json              #   your starting drafts for common open questions
│   ├── voice.local.md         #   how you write
│   └── queue.json, cache/, runs/
├── knowledge/sites.json       # What runs have learned about job sites, shared through the repo
├── src/
│   ├── cli.ts                 # every command
│   ├── config.ts              # every setting, in one place
│   ├── run/                   # the apply loop
│   ├── browser/               # Chrome over the DevTools protocol, no browser library
│   ├── forms/                 # reading and filling pages; three scripts that run in the page
│   ├── answers/               # the writer (Claude), the answer memory, drafts, voice
│   ├── documents/             # tailored resumes and cover letters
│   ├── jobs/, sources/        # finding and rating
│   ├── knowledge/, log/, jev/ # site notes; the CSV records; the JEV client
├── tests/                     # offline, on captured fixtures with no personal data
├── docs/                      # SETUP, USAGE, ARCHITECTURE, JEV, SOURCES, SAFETY
└── .github/workflows/         # CI: typecheck, tests, audit, CodeQL, a guard against personal data
```

## How `/apply` works

Each job goes through the same loop on its own, and its result is printed the moment it is known:

1. **Open** the form in its own Chrome tab and read every control on the page: labels, options, which are required, which file box wants which file.
2. **Map** the page with one JEV call: which of your details goes in each box, which option is true for you, which boxes stay empty. A form that has not changed keeps its mapping.
3. **Fill** with real input events, one control at a time on boards that save as you type. Dropdowns are opened and clicked; calendars are turned to the month and the day is clicked; the resume goes in the resume box and nowhere else.
4. **Write** what is left. Open questions, and the few fields JEV was unsure of, go to Claude with your facts, your drafts and your voice guide. Answers are remembered, so a form you rehearsed is not written twice.
5. **Read back** every value from the page. A box that shows something other than what it was given fails the fill and holds the form; an optional box the site refused is reported as left blank.
6. **Walk** to the next page when the form has one, and repeat.
7. **Send**, only when every wanted value is on the page and no required box is empty, and only when you asked. The page after the click must be a confirmation before the application counts.
8. **Record** the application in `applications/applied.csv`, with one sentence on what the company does and one on why you fit. What the tool could not finish is in `manual.csv` with the reason.

### What makes this workflow different

- **Decisions and sentences are split.** JEV, a model built for typed judgements, makes every fixed-answer choice and returns probabilities, not text, in about half a second for a fraction of a cent. Claude writes only the sentences. A form with no open question never calls Claude at all.
- **Nothing is trusted until it is read back.** Every value is read from the page after it is written. A wrong dropdown pick, a date a masked box mangled, or a value a site quietly dropped is caught before Submit, not after.
- **What goes on a form comes from your profile.** Work authorization is worked out in code, per country, from what your profile says; dates and education are copied from it; a written answer that names a number, a tool or a company your profile does not is refused. A signature, an NDA and a human check stop the form for you. The profile is the one place the truth can go wrong, and it is yours.
- **It learns per site.** How each board's controls take values, which sites want a sign-in, which email codes, is recorded after every form and read before the next, and shared through the repo.
- **Every record is a plain CSV** with fixed column names, at the top of the project, so you and your scripts can read it.

The longer version, with what it handles and what it leaves to you, is in [docs/USAGE.md](docs/USAGE.md).

## A resume and a cover letter written for the job

Off by default: your applications carry the resume file in your profile.
Turn it on and the tool writes a one-page resume for each job from your
profile and the posting, and attaches that one instead.

```bash
npx jev tailor <job id> --cover --open
npx jev apply --count 10 --submit --tailor --cover
```

- `tailor` writes the documents for a job and shows you the PDFs. `apply
  --tailor` writes one per job as it goes. `apply --cover` also writes a
  cover letter wherever a form has a box for one, and uploads it or pastes
  it. Set `coverLetter` to `"when_asked"` in your profile to make that the
  default.
- The resume is built from your own bullets, reordered and cut for the
  posting, with the posting's keywords used where your profile has the same
  thing. The cover letter names one specific thing from the posting and ties
  two or three of your facts to it.
- **Nothing is invented.** Every number and every name of a tool, a place or
  a company in the draft is checked against your profile in code. A draft
  that claims something your profile does not say is sent back once with
  the claims named, and refused if it still does. The keywords the posting
  wants and your profile cannot support are listed for you, not stuffed in.
- The PDFs are rendered by the tool's own Chrome, so there is nothing to
  install. They live in `documents/tailored/<Company>_<Role>_<job id>/` with the resume as
  Markdown next to it, git-ignored.

The method follows the drafter and verifier workflow of
[MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search)
(MIT), redone here in code against the profile instead of as a prompt.

## Customization

Everything about you is in data files, not in the code. `/profile` changes any of them with you.

### Which files to edit manually

| File | What to change |
|---|---|
| `data/profile.json` | Your details, education, experience, projects, skills, work authorization, and `answers`: how recurring questions are answered (relocation, text messages, notice period, pay, agreements). JEV and Claude both follow this list |
| `data/bank.json` | Your starting draft for each common open question ("Why this company?", "Tell us about a project") |
| `data/voice.local.md` | How you write, so the answers read as yours |
| `documents/resume.pdf` | The resume the tool sends when you do not tailor one |
| `src/config.ts` | Every setting in one place: the job lists, the scoring and where ranks highest, how many forms run at once, how fast the tool works on each site, which Claude model writes, the resume and cover letter page limits |

### Where the jobs come from, and adding a board

Jobs come from public lists on GitHub (the SimplifyJobs internship and new-grad lists among them) and from the company boards those lists point at, read through the boards' own APIs for Greenhouse, Lever and Ashby. Workday postings are read from Workday's own posting data and are kept once you allow accounts with `/accounts`; until then they are filtered out. iCIMS, Taleo, Oracle and the other boards that want an account are filtered out, and a site found behind a sign-in during a run is remembered and skipped. [docs/SOURCES.md](docs/SOURCES.md) describes each source and how to add one, and `data/imports/` takes a CSV of your own.

### Jobs that want an account

> **In progress.** Two parts of the tool are still being built and are off by default: applying on boards that want an account (Workday, with `/accounts`), and the Google connection (Gmail, for verification emails and for `/inbox`). One real Workday application (a six-step form at one employer) has been taken from the sign-in to a confirmed submission; other employers lay their forms out differently and are untested. The Gmail connection has not been run against a real mailbox. Until this note is gone, use the tool on the boards that need no account: Greenhouse, Lever, Ashby and the others listed in [docs/SOURCES.md](docs/SOURCES.md).

Every employer on Workday keeps its own accounts, and that is a large share of all postings. The tool skips them until you set an employer up, and there are three ways, from the simplest:

```
/accounts signin acme
```

1. **You sign in once.** That employer's page opens in the tool's Chrome window and you sign in yourself, however it asks. The tool keeps the session and fills that employer's forms from then on. Nothing else is stored.
2. **It signs in for you.** `/accounts password acme` opens a window on your Mac for that employer's password. It goes into your Keychain, and the tool signs in when the session has ended. A password an employer refuses is never tried twice.
3. **It makes accounts (experimental).** `/accounts add workday` asks whether the tool may make an account where you have none, accept the account terms, and read the verification email, and shows what that allows before it saves. Each new account gets its own random password in your Keychain. A rehearsal never makes one.

A robot check, a phone code, a passkey and single sign-on stop the job with the page left open for you; `/resume` carries on once you are through. `/accounts off` stops every sign-in, and `/accounts forget all` removes the stored passwords and sessions from your Mac. Neither deletes an account at an employer. [docs/ACCOUNTS.md](docs/ACCOUNTS.md) has every step, the Gmail connection, and what has and has not been tested.

### Which jobs it keeps

The filters and the scoring are in `src/config.ts`: early-career titles only, the countries you may work in, how much a Vancouver, Canadian, remote or US posting is worth to you, and how old a posting may be (`/discover --max-age 30`). A posting that prefers another graduation date is ranked lower, not dropped: whether to apply is your decision.

### Custom resume and cover letter templates

The stock resume and cover letter are plain HTML with system fonts, printed to PDF by Chrome. To use your own design, make a folder with a `resume.html` and, if you want letters, a `cover.html`, written with these placeholders:

| Placeholder | What it prints |
|---|---|
| `{{name}}`, `{{headline}}`, `{{contact}}`, `{{summary}}`, `{{skills}}` | Your name, the role in the posting's words, your contact line, the summary written for the job, the skills joined with dots (`{{#skillList}}{{.}}{{/skillList}}` for one at a time) |
| `{{#experience}} ... {{/experience}}` | One block per job, with `{{title}}`, `{{company}}`, `{{location}}`, `{{when}}` and `{{#bullets}}{{.}}{{/bullets}}` inside |
| `{{#projects}} ... {{/projects}}` | The same, with `{{name}}`, `{{role}}`, `{{link}}`, `{{when}}`, `{{#bullets}}` |
| `{{#education}} ... {{/education}}` | `{{degree}}`, `{{field}}`, `{{minor}}`, `{{school}}`, `{{when}}` |
| Cover letter: `{{date}}`, `{{company}}`, `{{role}}`, `{{greeting}}`, `{{#paragraphs}}{{.}}{{/paragraphs}}`, `{{closing}}` | |

Then register it. The tool checks every placeholder, prints a test pair from the example profile, and refuses a template that does not render or runs long:

```bash
npx jev templates --add ~/my-template --name mine
npx jev templates --use mine
```

`npx jev templates` lists what is registered and which one `/tailor` uses. The stock pair is in `src/documents/templates/default/`, the easiest starting point to copy.

### What the tool will not do

- **It will not change your facts to suit a job.** Your right to work, your
  education and your dates come from your profile, and code checks the
  answer picked for a right-to-work question against it. If the profile is
  wrong, the forms are wrong: that part is yours.
- **It will not add facts of its own.** Written answers are given only
  your profile and the posting, and a tailored resume or letter is checked
  for numbers and names your profile does not hold. A sentence can still
  be worded badly; rehearse and read.
- **It will not send a form it has not checked.** Every answer must be
  confirmed on the page first.
- **It will not send anything unless you ask.** Sending needs `--submit` or
  the `submit` command.
- **It will not sign for you.** If a form asks you to type your name to
  agree to a contract, the tool leaves it for you.
- **It will not choose a date for you.** If a form asks you to pick an
  interview or test slot, the tool leaves it for you.
- **It will not sign in or create an account unless you set that up.**
  Without `/accounts`, a job behind a sign-in goes on your by-hand list.
  With it, the tool signs in on Workday only, never retries a refused
  password, never makes an account in a rehearsal, and never ticks a
  marketing box.
- **It will not pass a "prove you are human" test for you.** That covers
  picture puzzles and the codes a board emails you because it suspects a
  robot.
- **It will not read your email**, with one exception you can turn on: the
  email an employer sends to prove your address when an account is made.
  Access is read-only, and that one email is all it looks for.
- **It will not make up references.** A job that requires them is skipped.
- **It will not write a cover letter unless you asked for one**, with
  `/apply --cover` or in your profile. Without that, a job that requires
  one is skipped. A letter it does write is checked against your profile
  like the resume.
- **It will not give your GPA** unless the form cannot be sent without it,
  or you chose to always give it.

[docs/SAFETY.md](docs/SAFETY.md) has the full list and shows where each rule
lives in the code.

### Starting over

Delete `data/profile.json`, `data/bank.json` and `data/voice.local.md` and run `/setup` again. `npx jev memory --clear` forgets the remembered answers; `applications/` and `documents/` are yours to keep or remove.

## What it costs

Two services do the thinking.

- **JEV** answers the questions that have a fixed set of answers, such as
  "which of my details goes in this box?" and "how good a fit is this
  job?" You pay for it through your OpenRouter key. **This is the only
  separate bill.**
- **Claude** writes the answers that need sentences, such as "Why do you
  want to work here?" It runs on the Sonnet 5.5 model at low effort,
  through Claude Code on your own Claude subscription, so there is no
  separate bill for it. If you would rather use a Claude API key, you can,
  and then those calls are billed to that key. See
  [Claude Code or the Claude API](#claude-code-or-the-claude-api).

### What JEV costs

Measured on three real batches on 2 October 2026, every call recorded:

| Batch | Forms filled | Applications sent | JEV cost | Per 10 forms |
|---|---:|---:|---:|---:|
| 1 | 15 | 10 | $0.022 | $0.015 |
| 2 | 27 | 16 | $0.037 | $0.014 |
| 3 | 36 | 18 | $0.037 | $0.010 |

So **1 to 1.5 cents for every 10 forms**. Most of that is one call per
form that decides what goes in each field; reading the page after Submit
and matching remembered answers add a tenth of a cent.

A search is separate: rating 350 to 460 new postings costs $0.06 to
$0.09, and a second search on the same day costs close to nothing, because
a posting that has not changed keeps its rating.

Five dollars of OpenRouter credit pays for about 60 searches and 3,000
applications.

For the record, everything we spent while building and testing the tool
from 1 to 2 October came to $1.43: 4 searches ($0.35), 118 applications
sent, and 67 forms that were rehearsed over and over while fixing bugs
($0.67 of it). Normal use does not do that.

What changes these numbers:

- **Forms with more fields cost more to map.** A long form is one JEV call
  of a few thousand tokens; a short one is a fraction of a cent. A form
  with several pages is one call per page.
- **A rehearsal costs the same as a real fill**, except the "read the page
  after Submit" step, which only a real application reaches. Sending a
  form you rehearsed does not map it again.
- **Claude calls count toward your subscription's usage allowance.** On
  an API key, `cost` shows what they cost instead.

To see what you have spent, run `npx jev cost`. Every run that
fills forms also prints its own cost at the end.

### How the tool keeps the cost down

- **It remembers answers.** Every answer Claude writes is kept on your
  computer. When you rehearse a form and then send it, the tool reuses the
  answers you read in the rehearsal and does not ask Claude again. We ran
  the same 10 forms a second time: Claude was asked about 1 form instead of
  6.
- **It reuses an answer on another company's form only when that is safe.**
  Claude marks an answer as reusable only if it would be true for any
  company. JEV then checks that the new question asks for the same thing.
  Most open questions name the company, so expect this to save a little,
  not a lot: in our test, 1 answer in 8 was reusable.
- **It forgets when you change your profile.** A remembered answer is used
  only while your profile, your drafts and your voice guide are unchanged.
  A corrected fact is never overruled by an old answer.
- **It does not ask JEV the same thing twice.** A posting that has not
  changed keeps its rating from the last search, and a form that has not
  changed keeps its field mapping. A second search on the same day costs
  close to nothing.
- **It sends Claude only what Claude needs.** Your profile is sent once per
  run and reused from a cache for the following forms.
- **JEV does everything it can.** On a typical form JEV settles all but one
  or two fields, for about a tenth of a cent.

To see or clear what the tool remembers, run `npx jev memory`.

## Claude Code or the Claude API

The tool reaches Claude in one of two ways. Both run the same model and
the same prompts, and everything else works the same.

| | Claude Code (the default) | The Claude API |
|---|---|---|
| What you need | Claude Code installed and signed in | A Claude API key in `.env` as `ANTHROPIC_API_KEY` |
| What it costs | Your Claude subscription's allowance. No separate bill. | Billed to your key at API prices. `cost` shows the amount. |
| The skills `/setup`, `/apply`, `/discover`, `/profile` | Work | Need Claude Code too. Without it, run the commands yourself. |

With a key in `.env`, the tool uses the API. To keep using Claude Code
while a key is present, add `WRITER_BACKEND=claude-code` to `.env`. Run
`npx jev doctor --online` to prove either one works.

## Tips for better results

### Profile depth matters

The writer may use only what your profile says. A bullet with a number in it ("cut page load by 44%") gives Claude something to tie to a posting; a vague one gives it nothing. Run `/profile` after each internship, project or course and add the facts. The tailored resume and the cover letter are only as specific as the profile is.

### Standing answers save you from repeating yourself

Every recurring question you answer by hand once (pay, relocation, start date, agreements, skill ratings) belongs in `answers` in your profile. The next form gets it right without you.

### Rehearse after a change

`/apply --dry` fills and checks forms without recording or sending anything. Read the values it reports after you change your profile or the code.

### Stay near your computer the first few runs

Boards sometimes email a code or show a "not a robot" check after Submit. The tool never types such a code or passes a check for you. It leaves that form open and filled, sends you a notification, opens your mail at a search for the code, and moves on to the next job, so a run never waits on you. Type the code or pass the check in the tool's Chrome window, then run `npx jev resume` and it records the application.

## Contributing

Bug reports, fixes for a form that filled wrongly, new job sources and site notes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: how the code is organized, how the docs are written, and what to run before a pull request. `knowledge --share` is the easiest contribution: what your runs learned about job sites, with nothing about you in it.

## Acknowledgements

- [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (MIT) for the drafter and reviewer method behind the tailored resume and cover letter, and for showing what a clear job-search repo looks like.
- [SimplifyJobs](https://github.com/SimplifyJobs) for the public internship and new-grad lists the tool reads.
- [typesafe/jev-1.13](https://openrouter.ai/typesafe/jev-1.13) for a model that answers a typed question with a probability.

## License

MIT. See [LICENSE](LICENSE).
