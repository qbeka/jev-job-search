# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and Conventional
Commits.

Releases are vetted checkpoints of `main`. If you run your own copy, update
to a tagged release rather than to raw `main`; each release's notes say what
changed for a person using the tool and what changed for a contributor.

## [Unreleased]

### Added
- Sixteen company boards with offices in Vancouver and Western Canada
  are polled on every search (Hootsuite, Later, AbCellera, Kabam, Klue,
  Trulioo, Jobber and others), each checked against its public board
  before it was added. The lists often miss their postings.
- `apply` on a job you named waits at an employer's sign-in. When your
  session there has ended and no password is stored, the sign-in page
  comes to the front, you are notified, and the run waits up to five
  minutes for you to sign in yourself. Then it fills the form. Before,
  the job stopped and you had to sign in and start again. A batch and the
  daily run still move on.
- Workday's search-and-pick boxes ("How did you hear about us?", the
  phone's country code) are read as one dropdown each: what is picked is
  the box's value, the list that opens is its options, and a choice that
  opens a list under it is followed there.

### Changed
- A form is not given up at the first trouble. A box that did not take
  its value goes back to Claude with the reason (a list with no such
  choice, a box showing something else), up to three rounds, as long as
  a round changes something. Before, one failed dropdown ended the form
  and the run moved to the next job.
- A page whose Next does not move the form is put right and tried
  again: the boxes the page's own errors name go back to Claude, and a
  page that says nothing has its Next pressed once more. Only after two
  tries is the form left for you.
- The README and `docs/ACCOUNTS.md` say plainly that accounts (Workday)
  and the Google connection are in progress and off by default.
- A box that already shows the value it is meant to hold is left alone.
  A draft a site kept from an earlier visit is no longer written over
  box by box. On Workday, writing the country again redrew the name,
  address and phone sections and emptied them.

### Fixed
- "Do you require work authorization?" is read as a question about
  sponsorship. It was read as "are you authorized", so the true answer
  was refused and the form held.
- A click in a long list waits for the list to stop moving under the
  pointer. On Workday's country list the click landed on the row beside
  the wanted one ("Cameroon" for "Canada"). It was caught and put right
  on a second look, but not before the form had redrawn itself for the
  wrong country.
- Two values with the same digits and different words are no longer the
  same: "Anguilla (+1)" does not pass for "Canada (+1)", nor "June 2026"
  for "May 2026".
- A short value that sits inside many options ("+1") picks none of them
  unless one names the candidate's own country. On Workday the dial code
  is asked for with its country, "Canada (+1)".
- A page that was still drawing itself when it was read is read again
  before it is planned, so no section is missed.
- A choice that opens a list of its own ("Job Board" under "How did you
  hear about us?") is answered as "Job Board > the one". When the answer
  does not say which, the choices on offer go to the writer, and to you
  when the profile cannot settle it.
- An option of a long Workday list is pressed on the option itself, not
  at a point on the screen: the list moved between the press and the
  release, and the row beside the wanted one was taken. What the list
  shows is read back as before.
- A dropdown that a form has put out of sight while it saves is waited
  for instead of being reported as not found.
- A list that only draws the rows in view is gone through to its end
  when the wanted choice is not in sight.
- A page that is in place but out of sight is not read yet. Workday hides
  a page while it saves and while it brings the next one in; the tool
  read the second page of a form in that moment, found nothing and
  stopped.
- "I have a preferred name" is ticked only when the profile gives a name
  other than the first name.
- A remembered answer that a list turned down is not given to that list
  again. The question goes back to the writer with what the list offers.
- A form whose boxes were not on screen when the page was read back is
  never called ready. On a real Workday form the page lay hidden for a
  moment after its lists were read; every box then looked switched off,
  nothing was held, and the rehearsal said READY with two required boxes
  empty. Now the fill waits for the boxes to be back, and a page read
  back with many boxes off holds the form.
- A box that shows another value than the one it was given holds the
  form after the second pass too, not only after the first. A click on a
  long list that was still moving landed three rows low and the report
  did not say so.
- An option is clicked only once it has stopped moving and is what lies
  under the pointer.
- Menus in a page's header (its language, the account) are no longer
  taken for questions of the form. Picking a language there reloaded the
  page in the middle of a fill.
- The sign-in says which controls an unknown page shows, in its steps
  and in the trace.
- A page that loads a second time while its form is being filled no
  longer stops the fill with "Cannot read properties of undefined". The
  runner puts its in-page helpers back and carries on; every value is
  still read back from the page afterwards. Met on the first real Workday
  form.
- A job a search skipped for one reason and now skips for another shows
  the reason that holds today. Before, a Workday job that was rated after
  you set its employer up, and skipped by the rating, still said it needed
  an account.
- `data/queue.json.bak`, the copy kept when the queue is rewritten, is
  git-ignored like the queue itself.

## [1.4.1] - 2026-10-03

Fixes from a review of 1.4.0.

### Fixed
- **An old dashboard page could put a sent application back in the
  queue.** Saving an answer now looks at the job again, under the lock:
  only a job that is still set aside, with that very question open, is put
  back. One that was sent, may have been sent, waits on you or is being
  worked on is refused, and nothing is written. A status set from the page
  is refused the same way when the job has moved on since the page loaded.
- **"We have decided to proceed" was read as a rejection.** The rule now
  needs the words for no ("decided not to", "with other candidates", "not
  selected", and so on), with examples of both kinds in the tests.
- **Replies went by a fixed ranking, not by when they came.** An older
  rejection read late could replace a newer interview, and a rejection
  after an offer could not replace it. Every reply is now kept with its
  time, and where an application stands is the latest one that says
  something; "we received your application" counts only when it is all
  there is.

### Changed
- The dashboard's button is "Save for next run", which is what it does:
  nothing is sent then. "Pause" is "Pause future runs" and removes the
  schedule; a new "Stop it after this application" asks a run that is
  working to stop, as do `/daily stop` and `daily --stop`. `/daily pause`
  is the schedule's off switch.
- The daily budget is said to be what it is, a limit on JEV: Claude runs
  on your subscription or your own key and is not counted. A run reads its
  rules once, when it starts.
- The README says which checks the software performs where it used to say
  "never", and says one thing about how setup ends.

## [1.4.0] - 2026-10-03

Accounts on Workday, a daily run, a dashboard that is the main screen,
replies read from your mail, and a slash command for everything. All of it
is off until you turn it on.

### Added
- **A slash command for every action**, so nobody has to type `npx`:
  `/accounts`, `/daily`, `/resume`, `/status`, `/inbox` and `/report`
  join the rest, and `/accounts` and `/daily` take short subcommands
  (`/accounts signin acme`, `/daily dry`, `/daily schedule 09:00`). The
  terminal form of each is in one table in the README.
- **Accounts, for Workday**, where every employer keeps its own. Three
  ways, from the simplest:
  - `accounts signin <employer>`: the employer's page opens in the tool's
    window, you sign in yourself, and the tool keeps the session.
  - `accounts password <employer>`: a window on your Mac asks for that
    employer's password and keeps it in the Keychain, so the tool can sign
    in when the session ends. A refused password is never tried twice.
  - Experimental: `accounts add workday` lets the tool make an account
    where you have none, with its own random password per employer, and
    says in plain words what that allows before it saves. `accounts setup
    <employer>` is the one command that makes an account. A rehearsal
    never does.
- `accounts off` and `on` switch every sign-in with everything kept;
  `accounts forget <employer or all>` removes the entry, its password and
  its session from this Mac. Neither deletes the account at the employer.
- Experimental: `gmail connect | status | disconnect`, read-only Gmail
  through your own Google client, for the one email an employer sends to
  prove your address. The default needs no setup: you click the link and
  type `/resume`. Never used for a human-check code.
- **The daily run.** `daily` searches, then fills and sends one job at a
  time inside your standing policy (`data/policy.json`) and fixed limits:
  15 a day unless your policy says otherwise and never more than 25, 8 to
  one board, 1 to one employer, 3 to 6 minutes between two applications to
  one board. A board that asks for a human check is left alone until
  tomorrow, and the second one stops the run. It does nothing until the
  policy exists, and ends with one line: "12 submitted. 3 need you. 5
  could not be sent." `daily --dry` rehearses the day.
- `schedule install --at HH:MM | remove | status`: runs `daily` every day
  through macOS's own scheduler. Nothing is scheduled until you install
  it.
- **The dashboard is the main screen**, with four parts. Today: the day in
  one line. Needs you: a question a form asked that your profile could not
  answer, with a box and "Save answer and continue" (for this job, or for
  every form when you tick "Remember"); forms that wait, with "Show the
  form" and "Find the email"; submissions never confirmed; emails the tool
  could not place. Applications: every job, with the reply that came back.
  Automation: the daily run as a switch with a time, the next run, a Pause
  button and your rules as a form.
- `inbox`: replies to your applications, read from your connected Gmail by
  sender, subject and preview, never the body. A reply settles an
  application that was clicked and never confirmed.
- `resume --submit`: after a sign-in you finished yourself, the form is
  filled and sent. `status` lists what waits for you.
- `apply <Workday link>`, and Workday postings read from Workday's own
  posting data for rating.
- `docs/ACCOUNTS.md`, `docs/DAILY.md`, and an accounts line in `doctor`.

### Changed
- `/setup` ends with one application filled and waiting for your yes, not
  with a list of commands.
- The README opens with who the tool is for, what it needs, what it costs
  and one way to start, and no longer says both that it writes cover
  letters and that it will not.
- A Workday job is kept by `discover` once you set an employer up, and
  `apply` takes one job per new employer and no more new accounts than the
  day allows. Without accounts, nothing changes.
- A sign-in the tool cannot finish no longer closes the page: it stays
  open, you get a notification, and the run moves on.
- The dashboard takes a change only with a token it gives its own page,
  and refuses to change a job a run is working on.
- The in-page scripts find a control by Workday's own name for it, never
  read a one-time-code box, and click through the sheet Workday lays over
  its buttons.

### For contributors
- `src/accounts/`: `ensureSignedIn` is the only place a credential is
  typed; an `Adapter` names a board's controls and reads its answers;
  `AuthPage` is the seam the tests script. `src/mail/`: `gmail.ts`,
  `verification.ts`, `status.ts`. `src/run/`: `daily.ts`, `policy.ts`,
  `schedule.ts`, `inbox.ts`. `src/report/needs.ts`.
- Two test files drive real code through headless Chrome on the loopback
  address: the sign-in against a mock board, and the dashboard page
  against made-up records. They are skipped where Chrome is not installed.
- An independent review of the sign-in found nine problems before
  release; all are fixed with tests. The main ones: a refused sign-in is
  never retried, an account is written down only once the board shows it
  exists, and the sender check on a verification email reads the address
  and the mail server's result strictly.
- Not verified against a real account: the wording Workday uses after a
  wrong password, a lockout or a duplicate sign-up; its verification
  emails; and its application pages behind the sign-in. Wording the
  adapter does not know stops the job for the person.

## [1.3.0] - 2026-10-03

### Added
- `resume`: a form that stops at a human check (an emailed code, a robot
  check) stays open and filled. The person gets a notification, their own
  mail opens at a search for the code, and `resume` records the application
  when they finish. The tool still reads and types no such code.
- `reconcile` and the `submission_unknown` status: from the click on, an
  application may be with the employer, so the job is recorded as
  unconfirmed first and is never filled or sent again until settled.
- `apply --resubmit`: a job that was applied to is refused by id or link
  unless this is given.
- `browser reset --yes`: clears the tool's own Chrome when asked.
- New statuses for boards with accounts (`login_required`, `registering`,
  `awaiting_email_verification`, `authenticated`, `awaiting_user_action`).
- The dashboard has a "Waiting for you" tab and an "Unconfirmed" count, and
  answers only its own page.
- A cover letter is checked for what reads as machine-written (stock
  phrases, a dash as punctuation, a semicolon, a sentence that runs on, a
  letter that runs long) and sent back once to be rewritten in the person's
  own register. The list is `DOCUMENTS.machinePhrases`.
- `apply --plain`: the profile's own resume and no cover letter for one
  run, whatever the profile says.

### Changed
- Every record is written whole and every change takes a short lock. A
  search merges into the queue as it is when the search ends, and keeps a
  job that was sent or is waiting even when its posting has left the lists.
  Two browser runs at once are refused.
- Every control is compared with what it was given, choices and checkboxes
  included, after the fill and again right before Submit, with the
  attached file checked too. A short answer must be the whole answer:
  "No" is not "Not applicable".
- An email or phone box that asks for another person (a reference, a
  supervisor, an emergency contact) is never given the applicant's.
- An answer about the right to work must say what the profile says for the
  country the question means, whoever gave it: JEV, the writer or the
  memory. When the country cannot be told, the answer is the person's.
- An agreement is ticked only when it is routine (the application is true,
  a privacy notice) or the person's standing answers allow it.
- A fill that runs out of time is stopped and cannot write over the retry.
- Child processes get an environment with no keys in it, everything printed
  passes a redaction filter, and saved links lose their query strings.
- A page is settled when its labels and options stop changing, not only
  its number of controls.
- A footer "protected by reCAPTCHA" is no longer taken for a robot check.
- A sign-in page is recorded as `login_required`.
- One job at a time by default (`RUN.fillConcurrency` 1): open, fill, send,
  close, next. The pauses between submissions to one site are seconds, not
  most of a minute, since one job at a time is already the pacing. The next
  job's tailored documents are written while the current one is filled.
- The truth gate knows a plural, a thousands separator and a phrase made of
  the profile's own words, so "REST APIs" or "18,000+" no longer refuse a
  draft. A draft it does refuse no longer blocks the job: the profile's own
  resume is sent instead, and the run says so.

### Removed
- Automatic clearing of the browser's cookies after a number of
  applications. It signed the tool out of everything.
- The rule that closed a form at a human check. The form now stays open.

## [1.2.1] - 2026-10-02

### Changed
- A form that stops at a human check (an emailed code, a robot check) is
  closed and listed in `applications/manual.csv` with the reason, and the
  run moves on. The site is no longer rested for the day and no tab is left
  waiting: a run never waits on the person. The `codes` command is gone.

## [1.2.0] - 2026-10-02

### Added
- `/report` and `npx jev report`: a dashboard on your own machine from
  the records, with totals, applications per day and per board, every job
  by status, tabs, a filter, and a status and a note per row that save at
  once. `--static` writes a snapshot page.
- Custom resume and cover letter templates (`npx jev templates --add
  <folder> --name <name>`, `--use <name>`): your own HTML in a small
  placeholder language, checked and test-printed before it is kept. The
  stock pair moved to `src/documents/templates/default/`.
- `/expand`: proposes projects, skills and facts from the public links in
  the profile, each with its source, for the person to confirm.
- `/add-source`: adds a job board or a list as a source, in the shape of the
  shipped ones, with a captured fixture and a live query before it counts.
- `/setup` reads everything in `documents/`: old resumes, a LinkedIn
  export, past applications, as sources for the profile.

## [1.1.0] - 2026-10-02

### Added
- `npx jev <command>`: a `jev` command in place of `npx tsx src/cli.ts`.
- `apply <link>`: a Greenhouse, Lever or Ashby posting link in place of a
  job id is read from the board, rated, queued and filled.
- Tailored documents get a reviewer pass (`DOCUMENTS.review`): a second
  writer call reads the draft as a hiring manager would and tightens it,
  then the truth gate runs on the result. Dates print as "May 2026";
  education shows its span.
- `documents/` at the top of the project holds your resume, your
  transcript and the tailored pairs (`documents/tailored/<Company>_<Role>_<id>/`).
  `data/resume/` and `data/documents/` are gone.
- README rewritten in the structure of MadsLorentzen/ai-job-search: what
  it is, prerequisites, a five-step quick start, other commands, file
  structure, how `/apply` works, customization, costs, tips. The long
  detail moved to `docs/USAGE.md`.

## [1.0.0] - 2026-10-02

The first tagged release: everything built from 1 to 2 October 2026.

### Added
- Fill runner (`src/browser/`): drives its own Chrome window over the
  DevTools protocol with no browser library. A form is dumped, mapped by JEV,
  filled, and every value read back, in 2 to 12 seconds. Forms run side by
  side with pacing per site.
- `apply`, `fill`, `resolve`, `inspect`, `set`, `submit`, `survey` and `close`
  commands. `apply --dry` rehearses without recording or submitting.
- Claude as the fallback writer (`src/answers/resolve.ts`): open questions
  and the fields JEV was unsure of go to a headless Claude Code call pinned
  to Sonnet 5.5 at high effort, with no tools, and come back as JSON.
- Standing answers in the profile (`answers`), read by JEV and by Claude.
- Dropdowns set through the component's own props: react-select on
  Greenhouse, including lazy and paginated lists, and Ashby's search boxes.
  A second JEV look picks among the closest real options when a dropdown
  refuses the first value.
- Readiness and a submit guard: a form is submitted only when every wanted
  value is confirmed on the page and no required field is empty, and the page
  after the click must be a confirmation.
- Per-field save tracking for boards that save as you type (Ashby), with a
  retry when the server refuses a save or an upload.
- `data/bank.json` and `data/voice.local.md`: the candidate's own drafts and
  voice guide, git-ignored, with examples in the repo.
- Sites found behind a login during a run are remembered and skipped by the
  next discover.

- `cost` command and a cost summary at the end of every `apply` run: JEV and
  Claude spend by purpose, per form and per ten forms. Every Claude call is
  logged with its tokens and cost in `data/runs/writer-usage.jsonl`.
- The README is rewritten in plain language, with measured cost and accuracy
  tables. `CONTRIBUTING.md` says how the docs are written.

- `/setup` skill: from a fresh clone to the first rehearsal in one
  conversation. It builds the profile from the resume and a short interview,
  has the user add their own key, finds jobs and rehearses. The questions it
  asks are in `.claude/skills/setup/questions.md`.
- `doctor` command: checks everything a run needs and names the next step.
  `--online` proves the key and the Claude Code sign-in with one tiny call
  each.
- Answer memory (`data/memory.json`, `memory` command, `apply --fresh`): a
  form that was rehearsed is sent with the answers that were read, without
  asking Claude again. An answer the writer marks as true for any company is
  reused on other forms, and JEV decides whether a differently worded
  question is the same one.
- `applications/applied.csv` at the top of the project folder: only the applications
  that were sent, newest first, under plain column names. `log` prints it,
  `log --json` gives the rows as JSON, `log --open` opens it.
- The demographic yes or no questions can be declined in the profile.
- `check` command: reads what a job's tab shows without clicking and records
  the job as applied if it is a confirmation, for forms finished by hand.
- A time limit per form (`RUN.fillTimeoutMs`), so a page that never settles
  is recorded as blocked instead of holding up the run.
- A pause between submissions to the same site (`RUN.submitGapMs`).

- Forms that run over several pages are walked: fill a page, check it, click
  the form's own Next, fill the next page (`nextPage`, up to `RUN.maxPages`).
- Calendar date pickers are clicked through: open, turn to the month, click
  the day, read the box back (`src/browser/calendar.ts`).
- Questions that appear only once another is answered are seen: the page is
  read again after a fill, moved controls keep their answers, and new
  controls are mapped and filled (`followUp`, `comparePages`).
- Before Submit the whole page is read afresh, and any required control that
  shows nothing stops the click.
- A site that asks for an emailed code is left alone for the rest of that
  day. Its jobs stay in the queue.
- A cookie banner that lies over Submit is answered with its most private
  choice (necessary cookies only, or reject). The tool never accepts all.
- The writer runs at low effort instead of high: the same model, fewer
  thinking tokens per call, so a run draws less on a subscription's
  allowance.
- Tailored documents (`src/documents/`, `tailor` command, `apply --tailor
  --cover`, `/tailor` skill): a one-page resume and a cover letter written
  per job from the profile and the posting, every number and name checked
  against the profile in code, rendered to PDF by the runner's own Chrome.
  Off by default. The method follows MadsLorentzen/ai-job-search (MIT).
- The project is now called jev-job-search.
- Your records live in one folder, `applications/`: `applied.csv`,
  `manual.csv`, `takehome.csv` and `all.csv` (was `data/applications.csv`).
  The folder has a README and is git-ignored apart from it and the example.
- Claude can be reached through the Claude API on a key in `.env`
  (`ANTHROPIC_API_KEY`) as well as through Claude Code on a subscription.
  `cost` prices Claude calls only on a key; on a subscription it says so.
- Take-home assignments: a form that asks for one is still sent, and the
  assignment's link and instructions go to `applications/takehome.csv` for the person.
- The runner's cookies, cache and site data are cleared between runs after
  every `RUN.clearBrowsingEvery` applications.
- A required group of checkboxes counts as answered once any box in it is
  ticked, also when each box has a name of its own (Ashby, Notion).
- JazzHR's Submit, drawn as a link, is found.
- A checkbox that acknowledges an agreement, a notice or terms follows the
  person's standing answers. Typing a name to sign, and any NDA, stay the
  person's to do.
- A box that asks for a graduate transcript gets the transcript only when
  the profile holds a graduate degree.
- A "confirm you are not a robot" check after Submit (BambooHR) is left
  for the person like an emailed code: the form stays open, `codes` shows
  it, and the site's other jobs wait for another day.
- Pickers drawn as a button that opens a searchable menu (BambooHR's State
  and Country) and read-only comboboxes (Workable's pickers) are filled.
- A text box that names a date format in its placeholder (MM/DD/YYYY) gets
  the date written that way.
- A typed box or a dropdown must show the value it was given, in whatever
  shape the site writes it. A box that shows something else fails the fill
  and holds the form, where before any non-empty box passed.
- Site notes (`src/knowledge/sites.ts`, `knowledge` command): after every
  form the tool records how the site's controls took their values, whether
  it wants a sign-in, how many pages its form has and what it could not set,
  and starts from those notes next time. `knowledge --share` writes them
  into `knowledge/sites.json` for a pull request.
- `applications/manual.csv` and `log --manual`: the jobs the tool set aside for the
  person, each with the reason and the link.
- JEV's ratings and field mappings are cached under a hash of everything
  that went into them, so an unchanged posting or form is not asked about
  twice.
- `codes`: for forms waiting on a code a board emailed you, shows each form
  in turn while you type the code, then records the application.
- A form whose values did not land is opened and filled a second time
  (`RUN.fillAttempts`). A phone number the page refused is tried again with
  its country code.
- `apply` sends each form as soon as it is ready. Every job moves on its own
  through fill, resolve and submit, and its result is printed and recorded
  when it happens, so a run that is cut short has sent what was done.
- Optional `transcript.path` in the profile, attached only to a file box
  that asks for a transcript.

### Changed
- A site that wants a sign-in is no longer blocked and left open: its tab is
  closed, the job is listed in `applications/manual.csv`, and the site is skipped by later
  searches. The same goes for a form that asks for a signature or for
  something the profile does not say.
- `src/browser/formRunner.ts` and `src/cli.ts` are split into smaller
  modules: `report`, `session`, `dropdowns`, `fill`, `calendar`, `submit`,
  and `src/run/pipeline`, `outcome`, `print`.
- The commands `next`, `map-form`, `page-state` and `answer-context`, left
  from the first version, are removed.
- An optional field the tool could not set, and which the page shows empty,
  is reported as left blank and no longer holds the form.
- A file box is named by the question above it, not by its button. Extra
  file boxes (a transcript, a cover letter) no longer receive the resume.
- A form with a Next button and no Submit is recorded as "runs over several
  pages" after its first page, instead of failing at submit.
- An Apply link that opens a new tab is followed in the same tab.
- Selectors prefer the names a site gives its own controls (`data-testid`),
  which survive a re-render where numbered ids and generated names do not.
- A page that still shows the form after Submit, with no error, is watched a
  little longer before the result is recorded. A slow confirmation was being
  recorded as not sent.
- A board that emails a code to confirm a person is applying is recognised.
  The form is left open for the person and the record says what to do.
- French submit buttons are recognised.
- A candidate who may work in the United States is no longer ruled out by
  postings that refuse sponsorship. The rule now reads the profile.
- The writer runs in an empty folder and on the five-minute cache, and
  returns the sheet notes with its answers. Ten forms cost $0.17 of Claude
  at API prices, down from $0.23.
- The writer costs about half as much: the candidate's context is cached by
  the provider, and the sheet notes for a run are written in one call.
- One posting is one job: ids come from the ATS posting id, so the same job
  linked three ways is no longer queued three times.
- The rating's term and graduation questions are worded from the profile. A
  posting that asks for another graduation date ranks lower instead of being
  judged the same as one that fits.
- Selectors always name exactly one element and avoid ids a UI library
  renumbers on each render.
- Placeholder labels ("Select", "Search") are replaced by the question text
  above the control. Ashby's Yes/No buttons and role-based radio rows are
  read.
- Lists too long to show JEV (countries, schools) are asked as a value and
  matched in code. Probabilities of keys that write the same value add up.
- A required salary box gets `preferences.salaryIfRequired`.
- The CSV dates an application by the local day and keeps one row per
  posting. The "What They Do" and "Why You're a Fit" cells are written when
  an application is sent.
- The project and its skills run Claude Code on Sonnet 5.5 at high effort.

### Fixed
- Several Ashby forms written at once had saves dropped, and a form then
  went to Submit with answers missing. One Ashby job now goes from fill to
  submit before the next starts.
- Ashby's Yes/No rows were found by position, which a new question shifts.
- select2 dropdowns, and radio rows with long labels, were not read.
- A question written as plain text above a group of checkboxes (Rippling)
  was lost, so two "Yes" boxes could not be told apart.
- A required group of radio buttons whose mark sits on the question was
  taken as optional.
- A form too long for one JEV reply is now mapped in smaller pieces.
- A radio button or checkbox is never set from script when its click does
  not take: the fill fails and the form is held.
- Workable forms: Yes/No rows are clicked on their real radio button, a
  required mark before the question is read, and the address parts the site
  fills in itself are left alone.
- The resume box was "not found" on a form reached through a careers page
  (Databricks), and each dropdown there waited three seconds for requests
  the previous page had left unanswered. Filling took 165 seconds; now 5.
- A controls group above the application (a job-alert box) is no longer
  taken for part of it.
- A phone box that throws away a value set by script, or when focus is taken
  from it by script, is typed into and left with the Tab key.
- A location list drawn from a `datalist` is read.
- Typing went nowhere when a click had not yet put the keyboard in the box.
- Work-history dates and the "current role" box are filled from the most
  recent job in the profile instead of being guessed. JEV now sees the work
  history, so "how many internships" is counted, not estimated.
- A field that asks the candidate to type their name to sign an agreement is
  never filled, and Claude never picks an interview or assessment slot. Both
  hold the form for a person.
- A group of checkboxes is one question: a required group is answered once
  any box is ticked.
- A careers page with a search box and a language picker is no longer taken
  for an application form. When a careers page shows no form, the board's own
  form for the same posting is opened.
- Only the form's own saves and uploads are tracked. Analytics and widgets
  from other sites no longer slow a fill down or fail an upload.
- The resume is attached before the fields are filled, so a board that parses
  it cannot overwrite the profile's values.
- Pages with a password box are blocked before anything is typed.
- A place written another way ("Edmonton, AB, Canada") is matched only when
  a region or country of the candidate's is named, never on the city alone.
- A control that vanished is a failure, not "not applicable".
- Jobvite and SmartRecruiters postings, and iCIMS behind a careers page, are
  skipped at discovery instead of failing at the form.

### Added (first version)
- Discover pipeline: SimplifyJobs lists, three community Canadian lists,
  Greenhouse, Lever and Ashby board polling, code filters, JEV fit rating,
  ranked queue, sheet-compatible CSV.
- Forms layer: `dumpFields.js`, `fillFields.js`, JEV form mapping, page
  state classification, direct apply URLs for Greenhouse, Lever and Ashby.
- Answer bank and voice guide for free-text answers.
- Claude Code skills: `/discover`, `/apply`, `/profile`.
- Offline test suite with captured blank-form fixtures.
