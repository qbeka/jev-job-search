# The daily run

*A few applications a day with nobody watching: what you set first, the
limits it keeps, how to schedule it, and how to stop it.*

`/apply` works while you watch. `daily` is for the days you do not: it
finds jobs, then fills and sends one application at a time, and writes you
a summary. It is **off until you turn it on**. Nothing is scheduled, and
`daily` itself does nothing, until you have written your standing policy.

## 1. Write your standing policy

The `/daily` skill asks you the questions and writes the file. By hand:

```bash
cp data/policy.example.json data/policy.json
```

| Field | What it means | Left empty |
|---|---|---|
| `target` | Applications a day. At most 25 | 15 |
| `where` | Where a job may be: `vancouver`, `canada`, `remote`, `us`, `international`, `unclear` | anywhere your search kept |
| `levels` | `internship`, `new_grad` | both |
| `minScore` | The lowest fit score a job may have, 0 to 1 | the search's own threshold |
| `boards` | Job boards by name: `greenhouse`, `lever`, `ashby`, `workday` and so on | every board the tool fills |
| `excludeEmployers` | Employers the daily run never applies to. A name matches any company that contains it | none |
| `documents` | `tailor`: a resume written for each job. `cover`: a cover letter where a form has a box for one | your profile's own resume |
| `jevBudgetUsd` | The most JEV may cost in a day. The run stops there | 0.50 |

Every job is checked against this file in code before its form is opened.
There is no pay filter: postings rarely state pay in a way the tool can
read, and it will not guess.

`data/policy.json` is git-ignored.

## 2. Rehearse

```bash
npx jev daily --dry --target 3
```

A rehearsal fills and checks the forms, sends nothing, records nothing and
does not wait between jobs. Read what it would have sent. If your policy
includes Workday, a rehearsal still signs in for real ([ACCOUNTS.md](ACCOUNTS.md)).

## 3. Run it

```bash
npx jev daily
```

It searches for jobs, then applies until the day's number is reached or a
limit stops it, and prints what it sent, what waits for you, and what it
could not send. The same summary is kept in `data/runs/daily-<date>.json`.

`--target 5`, `--max-attempts 10` and `--max-minutes 30` tighten one run.
`--no-discover` uses the queue as it is.

## The limits it keeps

No rate is known to be safe on any job board. These are set to look like
one careful person, and they are not yours to raise from the command line.

| Limit | Value |
|---|---|
| Applications a day | 15, or your policy's number, never more than 25 |
| To one job board in a day | 8 |
| To one employer in a day | 1 |
| Forms open or unconfirmed with one employer | 2, then that employer is left alone |
| New employer accounts in a day | 3 ([ACCOUNTS.md](ACCOUNTS.md)) |
| Between two applications to one board | 3 to 6 minutes, chosen at random |
| A board that asks for a human check, or answers "too many requests" | left alone until tomorrow |
| Two boards asking for a human check in one run | the run stops for the day |
| Jobs one run opens | 30 |
| Longest run | 90 minutes |
| JEV spend in a day | $0.50, or your policy's number |

A form whose Submit was clicked with no confirmation seen counts towards
the day's number until you settle it with `npx jev reconcile`, so the run
never sends extra to make up for one it is unsure of.

They live in `DAILY` in `src/config.ts`.

## What it leaves for you

The daily run passes no human check and finishes no sign-in that needs
you. Such a form stays open in the tool's window, you get a notification,
and the run goes on with another board. When you are back, type
`/resume`, or in a terminal:

```bash
npx jev resume --submit
```

The summary lists these under "Waiting for you". Forms left open longer
than 12 hours are closed and put on your by-hand list.

## Schedule it

Nothing runs by itself until you install the schedule, with
`/daily schedule 09:00` or in a terminal:

```bash
npx jev schedule install --at 09:00
```

This adds one entry to macOS's own scheduler for your account (a
LaunchAgent at `~/Library/LaunchAgents/com.jev-job-search.daily.plist`)
that runs `jev daily` in this folder at that time each day. What it prints
goes to `data/runs/daily.log`.

```bash
npx jev schedule status
```

```bash
npx jev schedule remove
```

Things to know:

- The Mac must be on and you must be signed in at that time. A Mac that
  was asleep runs the job when it wakes.
- The tool's Chrome window opens on your screen while it works.
- Claude Code must be signed in, or `ANTHROPIC_API_KEY` set, as for
  `/apply`.
- The schedule holds no key and no password. It only starts the command.

### With Claude Desktop instead

If you would rather have Claude run it and read you the result, make a
scheduled task in the Claude desktop app with a prompt such as "Run
`npx jev daily` in my jev-job-search folder and summarise what it printed."
Use one or the other, not both: two runs in one day share the same daily
number, but there is no reason to run twice.

## Turn it off

`npx jev schedule remove` stops the schedule. Deleting `data/policy.json`
makes `daily` refuse to run at all.
