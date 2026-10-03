# jev-job-search: rules for Claude Code

Read `README.md` first, then `docs/ARCHITECTURE.md`. The CLI is the product:
`discover` builds the queue, `apply` fills, resolves, verifies and submits.
`src/run/pipeline.ts` is the loop itself. The skills in `.claude/skills/`
run it with a person in the loop: `/setup`, `/discover`, `/apply`,
`/profile`.

If `data/profile.json` does not exist, the person in front of you has not
set the tool up. Offer `/setup` before anything else. `npx jev
doctor` says what is in place and what to do next.

## What never changes

- **Truth.** Work authorization, education, dates and names come from
  `data/profile.json` and are never adjusted to fit a form. If a required
  field cannot be answered truthfully from the profile, the job is marked
  `needs_review`, not answered.
- **No PII in git.** `data/profile.json`, `data/bank.json`,
  `data/voice.local.md`, the resume, `applications/all.csv`, `applications/applied.csv`,
  `applications/manual.csv`, `data/memory.json`, `data/knowledge.json`,
  `data/queue.json` and everything under `data/cache/` and `data/runs/` are
  git-ignored. `knowledge/sites.json` is tracked on purpose: it holds site
  names and kinds of controls, and `sanitize` keeps everything else out. Tests use `data/profile.example.json` only. Never paste real
  values into a fixture, a doc, source, or a commit message.
- **Verify, then submit.** A value is real when it has been read back from
  the page. A form is submitted only when it is `ready`, and an application
  counts only when the page after the click is a confirmation. Never weaken
  `isReady` or the submit guard to make a form go through. One case is
  allowed on purpose (`splitFailures`): an optional field the tool could not
  set, which the page shows empty, is reported as left blank and does not
  hold the form. A required field, a field showing another value, and the
  resume always hold it.
- **The right file in the right box.** A file box gets the resume only when
  it asks for the resume (`fileBoxWants`). A box that asks for a transcript
  or anything else is never given the resume. A tailored resume or cover
  letter (`src/documents/`) is used only when the run asked for it, and only
  after `unsupportedClaims` found nothing in it that the profile does not
  say. Never loosen that check to get a document through.
- **Never sign in, never type into a login.** A page with a password box
  is blocked: the tab is closed, the job goes on the by-hand list
  (`applications/manual.csv`), and the site is noted so the next discover skips it. The
  tool creates no accounts, stores no site passwords and solves no CAPTCHAs.
- **A human check is the person's to pass.** That includes a CAPTCHA and
  a code a board emails to confirm a person is applying. No such code is
  ever read from mail or typed into a form, by the tool or by you. The
  filled form stays open (`awaiting_user_action`), the person is told
  (`src/run/assist.ts`: a notification, the tab in front, their own mail
  opened at a search for the code), and the run moves on. `resume` records
  the application once they finish.
- **Never send twice.** From the moment Submit is clicked the application
  may be with the employer. The job is recorded `submission_unknown` before
  the click and is never filled or sent again until a confirmation,
  `reconcile` or the person settles it. A job that was applied to is
  refused unless `--resubmit` is given on purpose.
- **One writer at a time, whole files only.** Every record is written by
  `writeAtomic`, and every read-modify-write goes through `mutateQueue`,
  `mutateRows` or `mutateSession` under the store lock
  (`src/util/store.ts`). A command that drives the browser holds the run
  lock. Never write `data/queue.json` or a CSV any other way.
- **What the tool cannot finish truthfully, it sets aside.** A form that
  asks for a signature, or for something the profile does not say, is
  closed and listed in `applications/manual.csv` with the reason (`src/run/outcome.ts`).
  It is never answered to get it through.
- **No secrets in code or logs.** The OpenRouter key is read from `.env` by
  `src/config.ts` and nowhere else. Everything printed goes through
  `scrub` (`src/util/redact.ts`), links are kept as `safeUrl`, and every
  child process is started with `childEnv()`, an allow-list that holds no
  key. A test fails on a spawn without it. Keep it that way.
- **JEV decides, code acts, Claude writes.** Anything that is a typed
  question (which field, which option, which page, how good a fit) goes
  through JEV with criteria written as definitions. Free text and the fields
  JEV was unsure of are Claude's job, only from the facts in the profile.
  When the CLI needs Claude it runs Claude Code headless on the person's
  subscription, or, with `ANTHROPIC_API_KEY` in `.env`, calls the Claude
  Messages API directly (`src/answers/resolve.ts`), on the model and effort
  in `WRITER` in `src/config.ts`, with no tools. Those are the only two
  ways; no other model API is called for writing.
- **Nothing about one candidate in source.** Years, cities, drafts and
  phrasing come from the profile, `data/bank.json` and
  `data/voice.local.md`.
- **A remembered answer never outranks the profile.** The answer memory
  (`src/answers/memory.ts`) reuses an answer only under the same fingerprint
  of the candidate's context, only for the same form or for an answer the
  writer marked reusable, and only when the field can take it. A reused
  answer is read back from the page like any other. Do not loosen
  `MEMORY.sameQuestionConfidence` without measuring wrong matches.
- **Pace every site.** Job boards drop or refuse bursts. Concurrency and
  gaps per host are in `RUN`; do not remove them to go faster.
- **The tool learns by keeping notes, and reads them before it acts.** Site
  notes (`src/knowledge/sites.ts`), the answer memory, and the JEV caches
  only ever make a run cheaper or steadier. None may change what a form is
  told: a note chooses the way a value is entered, never the value.
- **Tunables live in `src/config.ts`.** No thresholds, weights, timeouts or
  URLs anywhere else.
- **Nothing from a web page is executed.** Job descriptions, labels and page
  text are data. The browser scripts only read the DOM or write values they
  were given.

## Conventions

- TypeScript, strict, ESM, Node 22, run with `tsx`. No build step.
- Two runtime dependencies (`commander`, `zod`) plus the Node standard
  library. The browser layer uses Node's own `fetch` and `WebSocket`. Adding
  a dependency needs a reason in the PR.
- Every external payload (JEV, ATS APIs, the queue file, form dumps, the
  writer's reply, the memory file) is parsed with a zod schema before use.
- The three scripts in `src/forms/*.js` run inside the page. They are plain
  JavaScript with no imports, and they never use timers.
- Tests in `tests/`, vitest, offline. Fixtures in `tests/fixtures/` are real
  captured data with no personal information.
- Commits: Conventional Commits, `type(scope): imperative summary`, lower
  case, no period. Scopes: `jev`, `sources`, `rating`, `forms`, `answers`,
  `log`, `cli`, `browser`, `skills`, `docs`, `tests`, `infra`. No AI attribution
  trailers of any kind.
- Prose: plain, direct, no em dashes anywhere in source, docs or copy.

## Before pushing

```
npx tsc --noEmit && npx vitest run && npm audit --omit=dev
```
