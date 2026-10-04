# Using jev-job-search day to day

What the tool handles, what it leaves to you, where your records are, and
how it learns. The README has the short version; this is the long one.

## How `/apply` works, step by step

`/setup` takes you through these steps the first time. After that, type
`/discover` and `/apply` in Claude Code, or run the commands yourself.

1. **Find jobs.** This takes about a minute and does not open a browser.

   ```bash
   npx jev discover
   ```

2. **Rehearse.** The tool fills five forms, sends nothing, and closes them.
   Read the output. Each line shows one question and the answer the page
   holds.

   ```bash
   npx jev apply --dry --count 5
   ```

   If an answer is wrong, correct your profile and rehearse again.

3. **Apply.** Choose one of two ways.

   Fill the forms and look at them before anything is sent:

   ```bash
   npx jev apply --count 5
   ```

   ```bash
   npx jev submit <job id> <job id>
   ```

   Or fill and send in one step:

   ```bash
   npx jev apply --count 10 --submit
   ```

4. **Check the result.**

   ```bash
   npx jev log
   ```

Stay near your computer while the tool runs. Some forms show a "prove you
are not a robot" test or email you a code. Only you can do those.

### Codes and checks that are yours

After several applications in a short time, Greenhouse sometimes emails
an 8-character code and waits for it. BambooHR and JazzHR show a "confirm
you are not a robot" check. The tool does not read such a code, does not
type it, and does not pass a robot check.

What it does: the filled form stays open in its Chrome window, you get a
notification, your own mail opens at a search for the code email, and the
run goes on with the next job. When you have typed the code or passed the
check and clicked Submit:

```bash
npx jev resume
```

It watches each waiting form, sees the confirmation, and records the
application. A form left waiting for more than half a day is closed and
moved to `applications/manual.csv`.

### A click with no confirmation

Now and then a board shows neither a confirmation nor the form after
Submit: an error page, a blank page, a timeout. The application may or may
not be with the employer, so the tool records it as unconfirmed, keeps the
tab, and never fills or sends that job again by itself. To settle it:

```bash
npx jev reconcile
```

It reads the tab again. A confirmation records the application; the form
still open means it was not sent. If the page proves neither, look for the
employer's confirmation email and run `npx jev mark <id> --status applied`,
or `--status queued` to try again.

## What the tool handles

### Where it finds jobs

| Source | What it is |
|---|---|
| [SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships) | The largest public list of software internships. The tool reads the data file behind the list, so it also sees each job's sponsorship and degree flags. |
| [SimplifyJobs/New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions) | The same, for new-grad jobs. |
| [negarprh/Canadian-Tech-Internships-2027](https://github.com/negarprh/Canadian-Tech-Internships-2027) | Internships in Canada. |
| [vanshb03/Summer2027-Internships](https://github.com/vanshb03/Summer2027-Internships) | Internships in the United States and Canada. |
| [michelleokolie/canada-tech-internships-summer-2027](https://github.com/michelleokolie/canada-tech-internships-summer-2027) | Internships in Canada. |
| Company job boards | The tool asks Greenhouse, Lever and Ashby directly for the jobs of every company the lists name, and of 65 more companies. This finds jobs a day or two before the lists do. |
| Your own list | Put a CSV file with a company column and a link column in `data/imports/`. |

On one search, these sources gave 4,748 different jobs. The tool counts a
job once, however many lists link to it.

To add a list or a company, see [docs/SOURCES.md](docs/SOURCES.md).

### Which jobs it keeps

Before it spends anything, the tool removes jobs that:

- need an account to apply, unless it is a Workday job and you allowed
  accounts (see [ACCOUNTS.md](ACCOUNTS.md))
- were posted more than 14 days ago
- are not software jobs, by their title
- have a French title (the tool writes in English only)
- require a master's degree or a doctorate
- are unpaid
- are in the United States and refuse visa sponsorship, if your profile
  says you would need it

JEV then reads each remaining job and answers 15 questions about it. They
cover the level, the term, how well your skills and experience match, where
the job is, and whether it asks for a graduation date that is not yours.
The answers become one score, and the queue is ranked by that score.

The tool does not drop a job only because it asks for another graduation
date. It ranks the job lower and leaves the choice to you.

### Which job boards it can fill

| Job board | What to expect |
|---|---|
| Greenhouse | Works well. After several applications in a short time it sometimes emails a code to confirm a person is applying; that form stays open for you to type the code, and the run goes on. |
| Ashby | Works well. Ashby saves each field as you type, so the tool fills these forms one field at a time, and one form at a time. |
| Lever | Works well. |
| Rippling, Workable | Works. Tested on a few forms each. |
| BambooHR | Works. Its "confirm you are not a robot" check after Submit is yours: that form stays open for you, and the run goes on. |
| Jobvite, Tesla, and other forms that run over several pages | Works. The tool fills a page, checks it, clicks the form's own Next, and fills the next page, up to 8 pages. |
| SmartRecruiters | Not supported yet. The tool cannot read its form. It skips these jobs. |
| Workday | Off until you allow it with `/accounts`. Then the tool signs in with your account at that employer, or makes one if you said it may, and fills the form page by page. The sign-in is tested against scripted pages only, and Workday's own application pages have not been seen, so rehearse first. See [ACCOUNTS.md](ACCOUNTS.md). |
| iCIMS, Taleo, Oracle, SuccessFactors, Amazon, LinkedIn, and any other site that wants a sign-in | The tool does not sign in there. It skips these jobs. If it meets a sign-in page during a run, it closes the page, puts the job on your by-hand list, and skips that site from then on. |

### Which parts of a form it fills

- text boxes and long-answer boxes
- dropdown lists, including the kind you type into to search
- long lists that load as you type, such as schools and cities
- Yes and No buttons, and other button groups
- single-choice options and groups of checkboxes
- the resume upload. A box that asks for another file, such as a
  transcript, never gets the resume. It gets your transcript if you added
  one to your profile, and otherwise the form is held
- dates, and dates split into a month box and a year box
- calendars that cannot be typed into: the tool opens the calendar, turns
  to the month, and clicks the day
- phone numbers with a country picker
- consent boxes
- questions that only appear once another is answered: the tool reads the
  page again after it fills, and answers what has appeared
- a cookie banner that covers the Submit button: the tool picks the banner's
  most private choice (necessary cookies only, or reject) and never
  "accept all"

### Which questions it answers

| Kind of question | Where the answer comes from |
|---|---|
| Your name, contact details, address and links | Your profile |
| School, degree, field of study, start and graduation dates | Your profile |
| Jobs you have held, with their dates | Your profile |
| "Are you authorized to work here?" and "Will you need sponsorship?" | Your profile, worked out for the country of each job |
| Gender, ethnicity, veteran status, disability | Your profile. You can decline each one. |
| Relocation, office days, start date, availability | Your standing answers |
| "How did you hear about us?" | Your standing answers |
| Text messages, marketing, keeping your details for later | Your standing answers |
| Pay | Left empty. If the box is required, the words you chose, such as "Negotiable" |
| GPA | Left empty unless the form cannot be sent without it, or you chose to always give it |
| "Why do you want to work here?", "Describe a project", "Which AI tools do you use?" and other open questions | Claude writes them from your facts, your drafts and the job text |

### What it leaves to you

The tool does not send a form, closes it, and puts the job on your by-hand
list with the reason when:

- the site wants a sign-in or an account, and it is not one you set up
  with `/accounts`
- the form asks you to sign: to type your name under an NDA or another
  contract, or to tick that you agree to be bound by one
- a required question has no true answer in your profile, such as a
  specific incident it does not record, a rating of a skill you never
  listed, or an address in a country you do not live in
- the form asks you to pick a date or a time for an interview or a test
- the form requires a transcript and your profile has none
- the form requires a pay figure as a number and your profile gives none

It leaves the filled form open for you when the site emails you a code or
shows a "prove you are human" test after you send. On 2 October 2026
Greenhouse asked for a code on 7 of 13 forms sent within a few minutes.

A sign-in the tool started and could not finish is different: the page
stays **open** in the tool's window, you get a notification, and the run
goes on to the next job. That happens for a robot check, a phone code, a
passkey, single sign-on, account terms you did not approve, a password the
board refused, and a verification email the tool could not use. Finish it
there, then run `npx jev resume --submit`.

## Find your applications

Every record is a CSV in the **`applications/`** folder at the top of the
project. The one you want most is **`applications/applied.csv`**: one row
for each application you sent, newest first. Open it in any spreadsheet
program, or run:

```bash
npx jev log --open
```

| Column | What it holds |
|---|---|
| `applied_on` | The date you applied, as year-month-day |
| `company`, `role`, `location` | The job |
| `job_link` | The link to the posting |
| `work_auth` | What the posting says about visas |
| `term`, `level` | For example "Summer 2027" and "internship" |
| `ats`, `source` | The job board, and the list the job came from |
| `fit_score` | The tool's score for the job, from 0 to 1 |
| `what_they_do` | One sentence about the company |
| `why_fit` | One sentence on why you suit the job |
| `notes` | The reasons behind the score |
| `job_id` | The tool's id for the job, which the commands accept |

The column names never change, so a script can rely on them. For the same
rows as JSON, run `npx jev log --json`.

### Jobs left for you

`applications/manual.csv` lists the jobs the tool opened and could not
finish. Each row has the company, the role, the
reason, and the link, best fit first. Apply to these by hand if you want
them.

```bash
npx jev log --manual
```

### Take-home assignments

Some companies ask for a take-home assignment next to the application. The
tool sends the application anyway and lists the assignment in
`applications/takehome.csv`: the company, the role, the assignment's
link, and what the form said about it. Do these by
hand; the company will only read your application once it has the
assignment.

### Every job considered

`applications/all.csv` is the full record. It lists every job the tool
looked at, including the ones it skipped, with the reason. Its first 15
columns match a common job-tracking sheet, so you can paste it into one.
To print it, run `npx jev log --all`.

## How well it works

We rehearsed every form in the queue on the three job boards the tool
supports best: Greenhouse, Ashby and Lever. A rehearsal fills the form and
sends nothing.

| Measured on 2 October 2026 | Result |
|---|---|
| Forms in the queue | 53 |
| Forms opened (2 jobs had closed) | 51 |
| Answers the tool meant to enter | 1,002 |
| Answers confirmed on the page | 1,000 (99.8%) |
| Forms ready to send with no help | 45 of 51 |
| Forms the tool held for you, with the reason | 4 |
| Forms with an answer the tool could not confirm | 2 |
| Time to fill one form | about 7 seconds |
| Time for all 53 forms, with the written answers | about 5 minutes |

"Confirmed" means the answer is on the page. It does not mean the answer
is the right one. To check that, we read every answer in an earlier
rehearsal, one by one. That found seven wrong answers in about 500. Each
one pointed to a cause, such as a checkbox named after the option above it,
and each cause is now fixed. A rehearsal shows you every answer before
anything is sent, so read it the first time you use the tool.

A form is "ready" only when every answer is confirmed and no required
question is empty. The tool will not send any other form. Just before it
sends, it reads the whole page once more, and any required question that
is empty stops it. One case does not hold a form: one or two optional
questions the tool could not answer are left empty, and the report says so.

## How the tool learns

The tool does not train a model. It keeps notes, and it reads them before
it acts. There are three kinds.

| What it keeps | Where | What it is for |
|---|---|---|
| **Site notes** | `knowledge/sites.json` in the repository, and `data/knowledge.json` on your computer | How each site's forms behave |
| **Answer memory** | `data/memory.json` | Answers Claude wrote for you, so the same question is not paid for twice |
| **JEV's earlier answers** | `data/cache/` | Ratings of postings and field mappings of forms that have not changed |

### Site notes

After every form, the tool writes down what it found out about the site:

- for each kind of control, the way that got a value into it: set from
  script, typed with real keys, clicked, or picked in a calendar
- whether the site wants a sign-in
- how many pages its form has
- whether it emails a code after you send
- which controls it could not set, and why

The next time it meets that site, it starts with the way that worked. A
phone box that ignored a value set from script is typed into at once, with
no failed first try. A site that wanted a sign-in is skipped when jobs are
found. A site that emailed a code gets a longer pause between applications.

To see the notes, and the list of controls the tool has not learned yet:

```bash
npx jev knowledge
```

```bash
npx jev knowledge --trouble
```

### Share what your runs learned

The notes hold site names, kinds of controls and counts. They hold nothing
about you: no answers, no names, and every quoted value is taken out of a
reason before it is kept.

To add your notes to the copy that ships with the repository:

```bash
npx jev knowledge --share
```

Then commit `knowledge/sites.json` and open a pull request. Every person who
does this makes the tool better on the sites they applied to, for everyone.

## Where your information goes

- Your profile, your drafts, your resume, your record of applications and
  the answers the tool remembers stay on your computer. Git ignores all of
  them, so you cannot commit them by accident.
- The job text and the facts in your profile go to OpenRouter when JEV rates
  a job or maps a form.
- The job text, your facts and the open questions go to Anthropic, through
  your own Claude Code sign-in or your own Claude API key, when a form has
  questions for Claude.
- Your answers go to the employer's job board.
- What the tool learns about sites stays on your computer unless you choose
  to share it. See [How the tool learns](#how-the-tool-learns).
- Nothing goes anywhere else. The tool collects no usage data.

One thing to know before you rehearse: some job boards save each answer as
it is typed, before you send the form. Ashby does this. A rehearsal on such
a board leaves an unsent draft on that board. The employer is not told, and
it is not an application.

## What is planned

None of this is built yet.

- **`/outcome`**: record what came of an application (interview stage,
  offer, rejection, silence), archive what was sent per company, and
  surface open applications that went quiet with a drafted follow-up.
- **`/interview`**: a prep pack for a scheduled interview from the exact
  posting and the documents they read, and a mock interview in chat.
- **SmartRecruiters.** Its form is drawn in a way the tool cannot read yet.
- **Windows and Linux.** The tool is tested only on a Mac.

- **More boards with accounts.** Workday is the first; each further board
  is one adapter in `src/accounts/`.
- **Download and open.** Today the tool is a repository you clone, with
  Node and Claude Code installed first. A packaged desktop app, with the
  dashboard as its window, would remove that. The command line would stay.
- **One connection for both models.** Setup asks for Claude and for an
  OpenRouter key. Writing through OpenRouter as well would make that one
  key, billed there and not to a Claude subscription. Not built or tested.
- **A shared Google sign-in for verification emails**, so nobody needs a
  Google Cloud project of their own. That takes Google's review of the
  app, which this project has not done.

LinkedIn is not planned: its terms forbid automation.
