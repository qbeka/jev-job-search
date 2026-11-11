# Making it yours

Everything about you is in data files, not in the code. `/profile` changes any of them with you.

## Which files to edit by hand

| File | What to change |
|---|---|
| `data/profile.json` | Your details, education, experience, projects, skills, work authorization, and `answers`: how recurring questions are answered (relocation, text messages, notice period, pay, agreements). JEV and Claude both follow this list |
| `data/bank.json` | Your starting draft for each common open question ("Why this company?", "Tell us about a project") |
| `data/voice.local.md` | How you write, so the answers read as yours |
| `documents/resume.pdf` | The resume the tool sends when you do not tailor one |
| `src/config.ts` | Every setting in one place: the job lists, the scoring and where ranks highest, how many forms run at once, how fast the tool works on each site, which Claude model writes, the resume and cover letter page limits |

## Where the jobs come from, and adding a board

Jobs come from public lists on GitHub (the SimplifyJobs internship and new-grad lists among them) and from the company boards those lists point at, read through the boards' own APIs for Greenhouse, Lever and Ashby. Workday postings are read from Workday's own posting data and are kept once you allow accounts with `/accounts`; until then they are filtered out. iCIMS, Taleo, Oracle and the other boards that want an account are filtered out, and a site found behind a sign-in during a run is remembered and skipped. [docs/SOURCES.md](SOURCES.md) describes each source and how to add one, and `data/imports/` takes a CSV of your own.

## Which jobs it keeps

The filters and the scoring are in `src/config.ts`: early-career titles only, the countries you may work in, how much a Vancouver, Canadian, remote or US posting is worth to you, and how old a posting may be (`/discover --max-age 30`). A posting that prefers another graduation date is ranked lower, not dropped: whether to apply is your decision.

## Custom resume and cover letter templates

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

## Starting over

Delete `data/profile.json`, `data/bank.json` and `data/voice.local.md` and run `/setup` again. `npx jev memory --clear` forgets the remembered answers; `applications/` and `documents/` are yours to keep or remove.

## Tips for better results

### Profile depth matters

The writer may use only what your profile says. A bullet with a number in it ("cut page load by 44%") gives the writer something to tie to a posting; a vague one gives it nothing. Run `/profile` after each internship, project or course and add the facts. The tailored resume and the cover letter are only as specific as the profile is.

### Standing answers save you from repeating yourself

Every recurring question you answer by hand once (pay, relocation, start date, agreements, skill ratings) belongs in `answers` in your profile. The next form gets it right without you.

### Rehearse after a change

`/apply --dry` fills and checks forms without recording or sending anything. Read the values it reports after you change your profile or the code.

### Stay near your computer the first few runs

Boards sometimes email a code or show a "not a robot" check after Submit. The tool never types such a code or passes a check for you. It leaves that form open and filled, sends you a notification, opens your mail at a search for the code, and moves on to the next job, so a run never waits on you. Type the code or pass the check in the tool's Chrome window, then run `npx jev resume` and it records the application.
