# Setup (macOS)

*About twenty minutes the first time. Last verified 2026-10-02.*

## The short way

```bash
git clone https://github.com/qbeka/jev-job-search && cd jev-job-search && npm install && claude
```

Then type `/setup`. Claude asks for your resume, asks what the resume does
not say, opens `.env` for you to paste your OpenRouter key, finds jobs,
rehearses three forms, and waits for you to say "go". The questions it asks
are listed in `.claude/skills/setup/questions.md`.

At any point, this command lists what is in place and names the next step:

```bash
npx jev doctor
```

Add `--online` to also make one tiny JEV call and one tiny Claude call,
which proves the key and the sign-in work.

The rest of this page is the same setup done by hand.

## 1. Prerequisites

- **Node 22 or newer**: `node --version`. Install from nodejs.org or `brew install node`.
- **Google Chrome**. The runner starts its own window with its own profile; your everyday Chrome is not touched.
- **Claude**, one of two ways. Either **Claude Code** installed and signed in with `/login`: the tool runs it headless (`claude -p`) on Sonnet 5.5 at low effort, on your subscription. Or a **Claude API key** in `.env` as `ANTHROPIC_API_KEY`: the tool calls the Claude API directly, billed to the key. The skills need Claude Code; the commands work either way.
- An **OpenRouter** account and key from https://openrouter.ai/keys. Put a few dollars of credit on it; a full run costs cents.

## 2. Clone and install

```bash
git clone https://github.com/qbeka/jev-job-search
cd jev-job-search
npm install
npx vitest run        # everything should pass offline
```

## 3. The key

```bash
cp .env.example .env
```

Edit `.env` and set `OPENROUTER_API_KEY=sk-or-v1-…`. The file is
git-ignored. If a key has ever been pasted into a chat, an issue, or a
screenshot, rotate it at openrouter.ai/keys first.

## 4. Your profile

```bash
cp data/profile.example.json data/profile.json
```

Fill in every field. The schema is in `src/profile/schema.ts`; the
important choices:

- `education[0].gpa.volunteer`: `false` means the GPA is only entered when a
  form will not submit without it.
- `workAuthorization`: list only the countries where you can work without
  sponsorship. `statement` is used verbatim when a form asks you to explain.
- `demographics`: answer as you want them answered, including "Prefer not
  to say".
- `preferences.salaryExpectation`: leave empty to never volunteer a number.
- `facts`: the only claims Claude may make in a written answer. Keep every
  number exact.
- `summary`: three or four sentences; this is the candidate side of every
  fit rating, so say what you want, where, and when.

Then put your resume at `documents/resume.pdf` and set `resume.path` to
its absolute path, for example `/Users/you/jev-job-search/documents/resume.pdf`.

Check it: `npx jev doctor` reads the profile and the resume; a
schema error names the field to fix.

## 5. Your voice, your drafts, your standing answers

```bash
cp data/voice.md data/voice.local.md
cp data/bank.example.json data/bank.json
```

- `data/voice.local.md` is the style guide for every written answer. Edit it
  until a sample answer sounds like you.
- `data/bank.json` holds your starting draft for each common question (why
  this company, a project you are proud of, how you use AI tools). Text in
  braces is left for Claude to write from the posting.
- `answers` in the profile are your standing answers to questions that
  recur: which area of engineering, relocation, notice period, text-message
  consent, what to do when a posting wants another graduation date. JEV and
  Claude both follow them.

All three are git-ignored. Run `/profile` inside Claude Code to do this
interactively.

## 6. Optional: your existing tracker

Export your tracking sheet as CSV (File → Download → CSV) into
`data/imports/`. Rows not marked applied join the queue on the next
discover. The output CSV uses the same first fifteen columns, so it pastes
back into the sheet.

## 7. First discover

```bash
npx jev discover
```

About a minute. It prints totals and the top 50. `npx jev status`
shows skip reasons. `data/queue.json` and `applications/all.csv` now exist.

## 8. Rehearse, then apply

```bash
npx jev apply --dry --count 5
```

A Chrome window opens. Five forms are filled and resolved, nothing is
recorded, nothing is submitted, and the tabs close. Read the output: one line
per field with the value the page shows. Fix anything wrong in the profile
and rehearse again.

```bash
npx jev apply --count 5             # fill and verify, leave the forms open to look at
npx jev submit <id> <id> ...        # send the ones you are happy with
npx jev apply --count 10 --submit   # or do it all in one go
```

Stay near the computer: a "prove you are human" test or an emailed code is
yours to handle, in the runner's window. `npx jev log` lists what you
sent; the same list is `applications/applied.csv`, and
`applications/all.csv` is the full record of every job considered. Inside
Claude Code, `/apply` runs the same loop and deals with what needs a second
look.

A rehearsal is not wasted work. The tool remembers the answers Claude wrote
(`data/memory.json`), so the real run reuses them and does not ask Claude
again. Changing your profile, drafts or voice guide makes it start over.
`npx jev memory` shows what is remembered.

## 9. What the tool leaves for you

- A job on a site that wants a sign-in you did not set up, a form that asks for a signature,
  and a form with a required question your profile cannot answer are not
  sent. They are listed in `applications/manual.csv`,
  each with the reason and the link. `npx jev log --manual`
  prints the list.
- When a board emails you a code after you send, or shows a robot check,
  the filled form stays open in the tool's window and you get a
  notification. Type the code or pass the check, click Submit, and run
  `npx jev resume`: the tool records the application. It does not read or
  type the code.

## 10. What the tool learns

After every form the tool notes how the site's controls took their values
(`data/knowledge.json`). `npx jev knowledge` shows the notes.
`knowledge --share` writes them into `knowledge/sites.json`, which you can
commit and send as a pull request. The notes hold nothing about you.

## Updating

```bash
git pull && npm install
```

Your `data/` files are untouched by updates.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Not sure what is wrong | `npx jev doctor --online` names it |
| `OPENROUTER_API_KEY is not set` | Create `.env` as in step 3 |
| An answer is stale after you changed something on the form by hand | `npx jev apply --fresh <id>`, or `memory --forget <company>` |
| `No profile at data/profile.json` | Step 4 |
| `Chrome did not start on port 9333` | Install Google Chrome, or set `BROWSER.chromePath` in `src/config.ts` |
| `could not run claude` | Install Claude Code and run `claude` once to log in, or put `ANTHROPIC_API_KEY` in `.env` |
| A form comes back `blocked: no form found` | The page was a login, a closed posting, or a board the runner does not walk yet. The reason is in the CSV |
| A form comes back `filled, not ready` | The reason names the field. Add a standing answer to the profile, or finish it by hand in the window and `submit <id> --force` |
| Forms on one site start failing with `refused` | The site is rate-limiting. Wait a few minutes; add its host to `RUN.gentleHosts` |
| `AWJ_TRACE=1` before any command | Prints step timings and the page's own network writes |
| JEV 429 | The client retries; if it keeps failing, lower `rateConcurrency` in `src/config.ts` |
