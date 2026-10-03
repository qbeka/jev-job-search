# Architecture

*How the pieces fit. Last verified 2026-10-02.*

## The split

| Who | Decides | Does not |
|---|---|---|
| **Code** (`src/`) | Which sources to read, deterministic filters (ATS, age, flags, title words), location tier from strings, work authorization per country, the score formula, what the CSV says | Judge meaning |
| **JEV** | Every typed judgement: fit questions per job, which key fills a field, which option, whether a checkbox applies, what kind of page this is | Write text, see pixels, hold state |
| **The runner** (`src/browser/`) | Opens the form, reads it, writes values with real input events, attaches the resume, reads every value back, clicks Submit on a ready form | Decide what a value should be |
| **Claude** (the headless writer, through Claude Code or the Claude API; and the skills, through Claude Code) | Free-text answers, the fields JEV was unsure about, whether a required field can be answered truthfully at all | Invent facts, override authorization, create accounts, touch the browser |

The rule of thumb: if a question has a finite set of answers, it is JEV's.
If it needs a sentence, it is Claude's. If it is a rule, it is code.

## Discover pipeline (`src/discover.ts`)

```
fetchSimplify ──┐
fetchReadmeSources ─┤
importSheet(data/imports/*.csv) ─┼→ dedupe → preFilter → describe → rateJob → entryFor → queue.json
boards (greenhouse / lever / ashby for every company seen) ─┘                                   └→ applications.csv
```

1. **Collect.** Sources run concurrently. Board polling keeps only
   early-career titles (`EARLY_CAREER_TITLE`) because boards list every
   role.
2. **Dedupe** by posting (`postingKey` in `src/jobs/normalize.ts`). The
   lists and the boards link one job in several ways: a careers page with
   `gh_jid`, the board page, the embedded form, Ashby's `/application`. The
   big three are keyed by the ATS's own posting id, everything else by its
   canonical URL, so one posting is one queue entry and one CSV row. Merged
   records keep the richer fields.
3. **preFilter** (`src/jobs/hardFilters.ts`): account-walled ATSs and
   careers sites (`src/jobs/walled.ts`: a list in config plus the sites an
   apply run found behind a login), boards whose forms run over several
   pages, older than `DISCOVER.maxAgeDays`, titles that are plainly not
   software, French titles, advanced-degree-only, US with no-sponsorship or
   citizenship flags, unpaid. Reasons are kept and written to the CSV.
4. **describe** (`src/jobs/describe.ts`): ATS API text or page text, capped
   at `JEV.maxDescriptionChars`.
5. **rateJob** (`src/jobs/rate.ts`): one JEV call, fifteen questions,
   `scoreFromAnswers` turns them into a score, a decision and reasons. The
   term and graduation questions are worded from the profile's own
   graduation date. A posting that asks for another graduation date is
   ranked lower, not dropped: applying is the candidate's call.
6. **Queue** (`src/jobs/queue.ts`): sorted by score then recency. Entries
   from a previous run keep terminal statuses (applied, skipped, blocked) so
   nothing is applied to twice. Jobs already in a terminal state are not
   re-rated.

Timing on 2026-10-02: 4,748 unique postings, 478 rated, 61 seconds, $0.075.

## Where the code is

| Path | What it holds |
|---|---|
| `src/cli.ts` | The commands. Each is a thin wrapper |
| `src/discover.ts`, `src/sources/`, `src/jobs/` | Finding, filtering, rating and queueing jobs |
| `src/run/pipeline.ts` | The apply loop: fill, resolve, next page, submit, record |
| `src/run/outcome.ts` | What becomes of a job once its form is filled: send it, or set it aside with a reason |
| `src/browser/cdp.ts` | The Chrome DevTools Protocol client |
| `src/browser/session.ts` | One tab per job, page helpers, turns at the front of the window |
| `src/browser/formRunner.ts` | Open a form, fill a page, move to the next page, resolve open fields |
| `src/browser/fill.ts`, `dropdowns.ts`, `calendar.ts` | Writing values: plain controls, dropdowns, calendars |
| `src/browser/report.ts` | The fill report and the rules for when a form may be sent |
| `src/browser/submit.ts` | Sending a form and reading what the page became |
| `src/forms/*.js` | The three scripts that run inside the page |
| `src/forms/mapForm.ts` | Asking JEV what goes in each field |
| `src/answers/` | The writer (headless Claude Code, or the Claude API on a key), the answer memory, drafts and voice |
| `src/documents/` | Tailored resumes and cover letters: the writer's draft, the truth gate (`unsupportedClaims`), HTML rendered to PDF through Chrome (`printPdf`) |
| `src/knowledge/sites.ts` | What the tool has learned about each site |
| `src/log/` | The record files and the cost summary |
| `src/util/` | Pacing, the JEV answer cache, dates, text, HTTP |

## Apply loop (`src/run/pipeline.ts`)

Each job moves on its own through its steps, and nothing waits for the
batch. One exception: on a board that saves every field to its server
(`RUN.gentleHosts`, Ashby), one job goes from fill to submit before the next
starts, because saves are dropped when several of its forms are written at
once. Fills run `RUN.fillConcurrency` at once (one by default: a job goes from fill to submit before the next opens, and the next job's tailored documents are written meanwhile), paced per site
(`src/util/pace.ts`). The moment a fill ends, its form goes to the writer,
`RUN.writerConcurrency` at once. The moment a form is ready, it is
submitted: one click at a time, with `RUN.submitGapMs` between two
submissions to the same site. Each result is printed and recorded when it
happens.

```
fillJob (page 1)
  openForm ─→ the form URL, or its embedded ATS frame, or behind an Apply link or button
     │         password box → blocked, nothing typed, the site is noted as wanting a sign-in
     │         error page → one unhurried retry
  fillPage ─→ dumpFields.js ─→ readDropdownOptions ─→ mapForm (JEV, cached) ─→ uploads ─→ applyFills
     │                                                  read back, retry what did not stick
     │         secondLook ─→ JEV again, on the closest real options of a dropdown that refused a value
     │         followUp ─→ read the page again: follow controls that moved, map and fill controls that appeared
     │         readBack ─→ data/runs/<id>.report.json: every field, what the page shows, clean or not
walk, once per page
  resolveJob ─→ open fields → answer memory, then Claude (headless, no tools) → applyFills → read back
  nextPage ─→ only if the page is clean and has a Next: click it once, wait for other controls, fillPage again
outcomeOf ─→ send | left for the person, with the reason | skipped
submitJob ─→ refuse unless ready ─→ re-read required fields ─→ click ─→ JEV reads the page ─→ record
```

`applyUrl` (`applyUrlFor` in `src/jobs/normalize.ts`) is the direct form:
Greenhouse's embed page, Lever's `/apply`, Ashby's `/application`.

### The browser layer (`src/browser/cdp.ts`)

A small DevTools Protocol client with no dependency: Node 22 ships `fetch`
and `WebSocket`. It starts Chrome with its own profile under
`data/runs/chrome-profile`, a visible window the user can watch and take
over, and background throttling off so a tab behind another one still runs.
It gives the runner `evaluate`, `call` (values travel as arguments, never
as source text), real mouse and key input, file attachment, and a count of
the page's own writes (POST, PUT, PATCH) with any that failed.

### The form contract (`src/forms/fields.ts`)

- `dumpFields.js` runs in the page and returns a `FieldsDump`: every
  control a person could act on, with an `id` (f0, f1, …), a CSS `selector`
  that names exactly one element, `kind`, `widget`, `label`, `hint`,
  `required`, current `value`, `options`, the submit and next buttons,
  embedded ATS iframes, and whether the page shows a password box.
  - Labels come from `<label for>`, aria attributes or the enclosing label.
    A placeholder-style label ("Select", "Search") is replaced by the
    question above the control. A file box is named by the question above
    it, not by its "Attach" button.
  - Selectors prefer the names a site gives its own controls
    (`data-testid`). Ids a UI library numbers on each render are not used.
  - A radio or checkbox drawn by its label, with the real box out of sight,
    is read. So are button groups and role-based radio rows.
  - A read-only date box with a calendar is kind `calendar`.
  - Controls above the application form and outside it (a job-alert box)
    are left out.
- `mapForm` sends the fields and the candidate's facts and standing answers
  to JEV in chunks of `FORM.fieldsPerCall` and returns a `FillPlan`: per
  field an `action` (`fill`, `upload`, `draft`, `skip`, `review`), the chosen
  `key`, the `value`, and `confidence`. A list too long to show (countries,
  schools) is asked as "which value belongs here" and matched in code. A
  file box gets the document it asks for (`fileBoxWants`): the resume, a
  transcript if the profile has one, or nothing.
- `fillFields.js` writes plain controls: native value setters so React sees
  the change, `input` and `change` events, select by value then label,
  radios and button groups by label, checkboxes by click.
- `pageHelpers.js` reads values back, reads dropdown components through
  their own props, and reports where to click: a dropdown's options, a
  button group's choices, a calendar's arrows and days.

### Writing values (`fill.ts`, `dropdowns.ts`, `calendar.ts`)

Three ways, tried in the order the site notes suggest:

1. **From script.** Instant. Enough for most controls.
2. **Typed with real keys.** For a box that ignores or discards a value set
   from script. The box is left with the Tab key, as a person leaves it.
3. **Clicked.** Dropdowns that have no handler to call, button groups that
   ignore a scripted click, and calendars: `pickDate` opens the calendar,
   turns it month by month with its own arrows, clicks the day, and checks
   that the box then shows that date.

Clicks and keys need the tab in front, so tabs take turns for them
(`inFront`).

### Questions that appear later

Some questions exist only once another is answered. `followUp` reads the
page again after a fill (and after Claude's answers are written), up to
`FORM.followUpRounds` times. `comparePages` tells controls apart by what
they are (kind, label, name, in order), not by selector: a new question
pushes the controls below it down, so a selector made of positions may now
name another control. Controls that moved keep their answers under the new
selector. Controls that are new are mapped and filled like the rest. Ashby's
Yes/No rows are found by the name of the input they keep, which does not
shift.

### Forms with several pages

`nextPage` runs only when the current page is clean. It clicks the page's
own Next or Continue button once and waits for the page to hold other
controls. If the form does not move, the page's own complaint is recorded,
the form is marked `stuck` and is not clicked again. If the click turns out
to have sent the application, the job is recorded as applied. In a
rehearsal the button is clicked only when JEV agrees that the form goes on.
`RUN.maxPages` bounds the walk.

### Verification, in layers

1. Every fill is read back from the control. Empty means one retry with real
   input, then a failure with the reason.
2. A control the form switched off after another answer is not a failure. A
   control whose selector no longer matches is.
3. A form that saves each field to its server (Ashby) is filled one field at
   a time, each waiting for its save. A refused save or upload is retried
   once, then fails the form.
4. A form whose values did not land is opened and filled a second time
   (`RUN.fillAttempts`).
5. A form is `ready` only on its last page, with no draft, review or failure
   left and no required field empty. Up to `FORM.maxLeftBlank` optional
   fields that could not be set and that the page shows empty are not
   failures: they are listed as left blank (`splitFailures`). More than
   that holds the form.
6. `submit` refuses a form that is not ready. Then it reads the whole page
   afresh, plan or no plan, and any required control that shows nothing
   stops the click.
7. After the click, JEV reads the page. Only `submitted` is recorded as
   applied. A page that still shows the form with no error is watched a
   little longer first.

### What the tool does not finish (`src/run/outcome.ts`)

`outcomeOf` turns a finished fill into one of three things: send it, set
it aside for the person with a reason, or skip it. Set aside: a sign-in
page, a form that asks for a signature, a required question the profile
cannot answer, a form with more pages than `RUN.maxPages`, a form that would
not move to its next page. In a sending run the tab is closed and the job
goes into `applications/manual.csv`. A form that stops at a human check is the
exception: it stays open in `awaiting_user_action`, `assist` tells the person,
and `resume` records the application when they finish.

### Statuses (`src/jobs/queue.ts`)

| Status | Meaning | Who sets it |
|---|---|---|
| `queued`, `skipped` | A search decided | `discover`, `apply <link>` |
| `in_progress` | A run is working on it | `takeJobs` |
| `applied` | A confirmation page was read | `submitAndRecord`, `resume`, `reconcile`, `check`, the person |
| `needs_review`, `blocked`, `failed` | Set aside with a reason | `settle` |
| `login_required` | The board wants a sign-in the tool has no account for | `settle` |
| `registering`, `awaiting_email_verification`, `authenticated` | Stops on the way through a board with an account | the account adapter |
| `awaiting_user_action` | The filled form is open and waits for the person | `submitAndRecord`, the account adapter |
| `submission_unknown` | Submit was clicked and no confirmation was seen | `submitAndRecord`, before the click |

A job a run owned (`RUN_OWNED`) with no run alive was interrupted: `sweep`
puts it back in the queue when its tab is gone. A search never undoes a
status other than `queued` (`KEPT_ON_REDISCOVERY`), and keeps a job that
was sent or is waiting even when its posting has left every list
(`mergeDecided` in `src/discover.ts`).

### Files and locks (`src/util/store.ts`)

`writeAtomic` replaces a file whole. `withStore` is a short file lock
around a read-modify-write; `mutateQueue`, `mutateRows` and
`mutateSession` are the only ways the records change. `acquireRun` is the
lock a browser run holds for its whole length; a second run is refused,
and the dashboard shows which run holds it.

## What the tool learns

### Site notes (`src/knowledge/sites.ts`)

After every page, `guideFor` in `formRunner.ts` reports which way each
control's value landed, keyed by the control's signature (`kind`, plus
`widget` when the dump recognised one), and which controls could not be
set. `learn` adds that to `data/knowledge.json` under the page's host. The
pipeline adds how the form ended: its pages, whether it was ready, whether
the site wanted a sign-in or emailed a code.

Before a page is filled, the same notes are read back. `applyFills` types
straight into a control whose signature is known to need typing, and clicks
a dropdown known to need clicking, instead of failing the quick way first.
`learnedWalledHosts` feeds the sign-in sites to discover.

`loadKnowledge` merges the shipped file (`knowledge/sites.json`) with this
machine's. `knowledge --share` writes the merged notes into the shipped
file for a pull request. Reasons are passed through `sanitize`, which takes
out every quoted value, address and long number, so the shared file holds
nothing about the person.

### The answer memory (`src/answers/memory.ts`)

`data/memory.json` keeps what the writer decided, so a question is paid for
once. `resolveJob` looks there before it calls Claude, in this order:

1. **The same page of the same form, the same open fields.** The whole
   resolution (verdict, reason, answers, sheet note) is reused. This is the
   rehearsal followed by the real run: what was read is what is sent.
2. **The same page, other fields open.** Answers the page got last time are
   reused field by field, if last time ended `ready`.
3. **The same question on another form.** The writer marks each answer
   `reusable` only when the value would be right on any company's form. Such
   an answer is stored under the question with the company's name masked.
4. **A question worded another way.** JEV is asked which remembered question
   asks for exactly the same information, or none. Only a confidence of
   `MEMORY.sameQuestionConfidence` reuses the answer.

Every entry carries a fingerprint of the writer's system prompt (the rules,
the profile, the drafts, the voice guide), so any change there makes the
memory start over. A group of checkboxes is answered from memory only when
every box in it is. An answer that was itself recalled is never stored
again under the new wording.

### JEV's earlier answers (`src/util/cache.ts`)

`KeyedCache` keeps an answer under a hash of everything that went into the
question, so any change makes a new key and a new call.

- Ratings (`data/cache/ratings.json`): keyed by the posting, the candidate
  and the questions (`ratingKey`), without the posting's age. The score is
  worked out afresh each day from the stored answers.
- Field mappings (`data/cache/plans.json`): keyed by the form's fields, the
  job and the candidate. The second fill of a form, and the real run after
  a rehearsal, do not ask JEV again.

## Cost

`src/log/cost.ts` reads the two usage logs and reports spend by purpose and
per form. `apply` prints the cost of its own run at the end, and `cost`
prints it for any period. What keeps the writer cheap:

- The answer memory and the caches, above.
- The candidate's context is the system prompt, identical for every form,
  so the provider caches it. The first call of a process stores it; calls
  that start meanwhile wait for it and then read it at a tenth of the price.
- The cache is the five-minute one (`WRITER.env`).
- The headless call runs in an empty folder outside the project
  (`WRITER.cwd`), so this project's `CLAUDE.md` is not added to every prompt.
- A form with nothing left open makes no writer call at all.
- The writer returns the two sheet notes with its answers. Jobs it was not
  asked about get their notes in one call for the whole run.

Measured on three real batches on 2 October 2026: JEV 1 to 1.5 cents per
10 forms, plus $0.06 to $0.09 per search. Claude ran on a subscription
through Claude Code. The README has the table.

## Speed

| Step | Typical |
|---|---|
| Open the form | 1 to 3 s (7 s behind a careers page that redirects) |
| Dump, read dropdown options | under 1 s |
| JEV mapping | about 0.5 s, $0.001. Nothing when the form was mapped before |
| Fill and read back | 0.2 s on Greenhouse, 3 to 6 s on Ashby (per-field saves) |
| A further page of a form | 1 to 3 s |
| Claude, when a form has open fields | 10 to 25 s, three forms at a time |

Job boards answer bursts with errors or a human check, so the pacing is
part of correctness.

## Files

| Path | Format | Written by | Read by |
|---|---|---|---|
| `data/profile.json` | `ProfileSchema` | the user | everything |
| `data/bank.json`, `data/voice.local.md` | drafts per intent; the voice guide | the user | the writer |
| `data/queue.json` | `QueueFile` v1 | discover, `apply`, `mark` | everything |
| `applications/all.csv` | 25 columns, first 15 match the user's sheet. Every job considered | discover, `apply`, `submit`, `mark` | the user, `log --all` |
| `applications/applied.csv` | 15 columns with plain names. Only what was sent, newest first | the same commands | the user, `log` |
| `applications/manual.csv` | 9 columns. Jobs left for the person, with the reason and the link | the same commands | the user, `log --manual` |
| `knowledge/sites.json` | `Knowledge` v1: site notes shipped with the repository | `knowledge --share` | every fill, discover |
| `data/knowledge.json` | the same, learned on this machine | every fill, the pipeline | every fill, discover, `knowledge` |
| `data/memory.json` | `MemoryFile` v1: resolutions by form page, and reusable answers by question | `resolve`, `apply` | `resolve`, `apply`, `memory` |
| `data/cache/ratings.json`, `data/cache/plans.json` | JEV's answers by question hash | discover, `mapForm` | the same |
| `data/cache/http/` | cached GET bodies keyed by URL hash | `getText` | `getText` |
| `data/runs/jev-usage.jsonl` | one JSON object per JEV call: label, tokens, cost | `JevClient` | `cost` |
| `data/runs/writer-usage.jsonl` | one JSON object per Claude call: purpose, job, tokens, cost | the writer | `cost` |
| `data/runs/<id>.plan.json`, `<id>.report.json` | the dump and plan of the current page, and the verified result | the apply loop | `resolve`, `inspect`, `submit`, `survey` |
| `data/runs/browser-session.json` | which tab holds which job | `fill` | every later step |
| `data/runs/chrome-profile/` | the runner's Chrome profile | Chrome | Chrome |

## Setup and `doctor` (`src/doctor.ts`)

`doctor` runs a list of checks (Node, Chrome, Claude, the key, the
profile, the resume, the voice guide, the drafts, the queue) and names the
first thing that blocks a run. `--online` adds one tiny JEV call and one
tiny Claude call. The `/setup` skill runs it after every step. The
questions the skill asks, and the profile field each answer fills, are in
`.claude/skills/setup/questions.md`.

## Why its own Chrome window and no browser library

The first version drove the user's Chrome through the Claude in Chrome
extension, one tool call per action. It worked and it was slow: a form took
minutes, a background tab runs its timers once a second, and every value
passed through the model on its way to the page. The runner talks to Chrome
directly, so a form is one command and the model only sees what JEV could
not settle. It needs no Playwright or Puppeteer: the DevTools Protocol is a
WebSocket and a dozen methods. The price is a separate browser profile with
no signed-in sessions, which is fine for the forms this tool targets (they
need no account) and is why a human check still goes to the person at the
keyboard.
