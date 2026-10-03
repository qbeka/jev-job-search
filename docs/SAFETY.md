# Safety

*What this tool will not do, how it treats personal data, and what to
check before you publish a fork.*

## Never automated

| Rule | Where it lives |
|---|---|
| Lying on a form. Work authorization, citizenship, education, graduation date and employment dates come from `data/profile.json` and are not changed to fit a posting. | `src/forms/mapForm.ts` resolves authorization per country in code; the `/apply` skill forbids overriding it |
| Claiming a fact that is not in the profile. Free-text answers may use only `facts`, `experience`, `projects`, and the posting. | `data/voice.md`, `src/answers/context.ts`, the skill |
| Creating accounts on careers portals. Workday, iCIMS, Taleo, Oracle, SuccessFactors and Amazon Jobs are filtered out before rating. | `src/jobs/hardFilters.ts` |
| Passing a human check. This covers CAPTCHAs and the code a board emails to confirm a person is applying. The tool reads no email for these and types no code: the filled form stays open, the person is notified, and `resume` records the application once they finish. | `submitJob` reports the page as it is; `submitAndRecord` in `src/run/pipeline.ts` records `awaiting_user_action` and calls `assist` |
| Sending an application twice. From the click on, a job is `submission_unknown` until a confirmation is read; it is never filled or sent again before that. A job already applied to is refused without `--resubmit`. | `submitAndRecord`, `reconcile` and `pickJobs` in `src/run/pipeline.ts` |
| Signing in. A page with a password box is closed, the job is listed in `applications/manual.csv`, and the site is skipped from then on. No password is stored or typed. | `fillJob` in `src/browser/formRunner.ts`, `outcomeOf` in `src/run/outcome.ts` |
| Signing a contract. A form that asks the candidate to type their name under an agreement, or to tick that they are bound by one, is set aside for them. | `SIGNATURE_LABEL` in `src/forms/mapForm.ts`, the writer's rules in `src/answers/resolve.ts` |
| Submitting a form it has not verified. Every wanted value must be read back from the page and no required field may be empty. | `isReady`, `submitJob` in `src/browser/formRunner.ts` |
| Calling an application sent because the button was clicked. The page after the click is classified, and only a confirmation counts. | `submitJob`, `decidePageState` |
| Paying for anything, or entering payment details. | The skill |
| Writing cover letters or volunteering a GPA. A required cover letter skips the job; a required GPA field gets the real number. | `src/profile/fieldKeys.ts`, `planField` |
| Supplying references. A posting that requires them is skipped and logged. | `src/jobs/rate.ts`, the skill |
| Clicking "Apply with LinkedIn" or resume-autofill helpers that would overwrite the plan. | `mapForm` skips autofill inputs; the skill |
| Submitting without being told to. `apply` fills and verifies; only `--submit` or `submit` sends. | `src/cli.ts`, the skill |

The user can still misrepresent themselves by putting false data in the
profile. The tool makes that the only way.

## Personal data

- The profile, resume, queue, both CSV files, the answer memory, HTTP cache
  and run logs are git-ignored (`.gitignore`). `data/profile.example.json`
  is fictional.
- The answer memory (`data/memory.json`) holds answers Claude wrote for you
  and the questions they answered. It never leaves the machine.
  `npx jev memory --clear` empties it.
- The OpenRouter key is read from `.env` only. Error bodies are redacted
  before they are printed (`src/jev/client.ts`).
- What leaves the machine: job text and the profile's facts go to
  OpenRouter (JEV) on every rating and form-mapping call; the facts, the
  posting and the open questions go to Anthropic through your own Claude Code
  login when a form has fields left for Claude; the form values go to the
  employer's ATS; nothing goes anywhere else. There is no telemetry.
- Some boards save each field to their server as it is typed, before
  anything is submitted. Ashby does. A rehearsal (`--dry`) on such a board
  therefore sends the values to that board as an unsubmitted draft. It is not
  an application and the employer is not notified, but it is not nothing.
- A cookie banner is touched only when it covers the Submit button, and it
  is answered with its most private choice (necessary only, or reject).
  The tool never clicks "accept all".
- Tailored resumes and cover letters (`documents/tailored/`) are written from
  the profile only, checked in code for any number or name the profile does
  not hold, and git-ignored.
- The runner's Chrome profile lives in `data/runs/chrome-profile`, apart
  from your own browser. It keeps its cookies between runs; nothing
  clears them by itself. `npx jev browser reset --yes` clears them when you
  ask. The window can be driven only from your own machine.
- Every record is written whole (a temp file, then a rename) and every
  change takes a short lock, so a dashboard, a search and a run can work at
  the same time without losing each other's writes. Two browser runs at
  once are refused.
- Everything the tool prints passes a filter that replaces keys, tokens and
  anything registered as secret. Child processes (Claude Code, Chrome) get
  an environment with no keys in it.
- JEV usage is appended to `data/runs/jev-usage.jsonl` (ids, token counts,
  cost; no content).
- What the tool learns about sites (`data/knowledge.json`) holds host names,
  kinds of controls, counts, and reasons with every quoted value taken out.
  It leaves the machine only if you run `knowledge --share` and commit the
  file it writes.

## Terms of service

Automated form submission may be against the terms of a given job board
or ATS. The tool uses a browser on the user's own machine and their own
identity, submits one application per posting, paces itself per site, and
does not try to look like anything it is not: no stealth flags, no CAPTCHA
solving, no account creation. Read the terms of the sites you use and decide
for yourself.

## Before open-sourcing a fork

```bash
git status --ignored | grep -E "data/|applications/applied.csv|applications/manual.csv"   # profile.json, bank.json, voice.local.md, memory.json, knowledge.json, resume, the csv files, queue, runs must be ignored
git log -p | grep -i -E "sk-or-v1-|@gmail|phone" # nothing should match
npm audit --omit=dev
```

Replace the seed company list in `src/sources/companies.ts` if it does not
match your market, and rewrite `data/voice.md` in your own words.
