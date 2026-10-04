---
name: daily
description: Set up, rehearse and schedule the daily run, which sends a few applications a day with nobody watching, inside the user's standing policy. Use when the user says /daily, "run it every day", "automate this", "schedule it", or asks about the daily limits or data/policy.json.
---

# /daily

Read `docs/DAILY.md` first. It is the reference; this skill is the
conversation. The daily run is off until the user turns it on.

## What you never do

- **Never run `npx jev daily` without `--dry`, and never run
  `npx jev schedule install`.** The first sends applications with nobody
  watching; the second makes that happen every day. Both are the user's to
  run. Give them the command in a `bash` block.
- **Never write or change `data/policy.json` beyond what the user said.**
  Read it back to them before saving.
- **Never raise a limit in `DAILY` to get more applications out.** If the
  user asks for more than 25 a day, say why the limit is there: no rate is
  known to be safe, and a board that decides one person is a robot stops
  taking their applications.
- If the policy includes Workday, a rehearsal signs in for real. The user
  runs it, not you (see the `/accounts` skill).

## The conversation

1. Run `npx jev doctor` and `npx jev schedule status`. Say what is set up.
   If `data/profile.json` is missing, do `/setup` first.

2. If `data/policy.json` does not exist, ask, one question at a time:
   - How many applications a day? 15 is the default; 25 is the most.
   - Where may the jobs be? (Vancouver, the rest of Canada, remote, the
     United States, elsewhere.)
   - Internships, new-grad roles, or both?
   - Is there a fit score below which you would rather not apply? Show
     them the spread in their queue (`npx jev queue`) so the number means
     something.
   - Any employers to leave out?
   - A resume written for each job, and a cover letter where a form has a
     box for one? Say that this takes longer per job.
   - How much may JEV cost in a day? 50 cents is the default; a normal day
     is a few cents.

   Write `data/policy.json` in the shape of `data/policy.example.json`,
   show it to them, and save it only after a yes.

3. Rehearse three jobs. You may run this one, unless the policy includes
   Workday:

   ```bash
   npx jev daily --dry --target 3
   ```

   Read the summary with them: what it would have sent, what it could not.

4. Give them the real run to start themselves:

   ```bash
   npx jev daily
   ```

   Say what it does: it searches, applies one job at a time with minutes
   between two applications to one board, stops at the day's number, and
   leaves anything that needs a person open in the tool's window.

5. Only if they ask for it to run by itself, give them:

   ```bash
   npx jev schedule install --at 09:00
   ```

   Say: the Mac must be on and signed in at that time, the tool's Chrome
   window will open, and `npx jev schedule remove` stops it.

## Afterwards

- `data/runs/daily-<date>.json` and `data/runs/daily.log` hold each run's
  summary. Read the latest to them when they ask how it went.
- "Waiting for you" means a human check or a sign-in only they can pass.
  They finish it in the tool's window, then `npx jev resume --submit`.
- "Clicked and not confirmed" is settled with `npx jev reconcile`.
- A board that asked for a human check is left alone until tomorrow. That
  is the tool being careful, not a fault.
