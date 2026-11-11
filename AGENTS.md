# jev-job-search: for Codex and any other coding agent

This file is read by Codex, Cursor, Gemini CLI and other agents that look for
`AGENTS.md`. Claude Code reads `CLAUDE.md`. The rules are the same for every
agent and they live in one place:

**Read `CLAUDE.md` now, all of it, before you do anything in this repository.**
Where it says "Claude" or "you", it means you. The section "What never
changes" is not advice: it is what keeps a person's applications truthful and
their passwords out of your sight.

## Running the tool for a person

The person does not type `npx`. They say what they want, and you run the CLI
from the repository root with `npx jev <command>`. Each workflow is written
down as a skill:

| They say | Read and follow |
|---|---|
| set this up, get me started | `.claude/skills/setup/SKILL.md` |
| find jobs, refresh the queue | `.claude/skills/discover/SKILL.md` |
| apply, start applying | `.claude/skills/apply/SKILL.md` |
| I typed the code, I signed in, continue | `.claude/skills/resume/SKILL.md` |
| where am I, what is waiting | `.claude/skills/status/SKILL.md` |
| open the dashboard | `.claude/skills/report/SKILL.md` |
| change my profile, an answer was wrong | `.claude/skills/profile/SKILL.md` |
| tailor my resume, write a cover letter | `.claude/skills/tailor/SKILL.md` |
| Workday, accounts, sign in | `.claude/skills/accounts/SKILL.md` |
| run it every day | `.claude/skills/daily/SKILL.md` |
| did anyone reply | `.claude/skills/inbox/SKILL.md` |
| add my GitHub projects | `.claude/skills/expand/SKILL.md` |
| add this job board | `.claude/skills/add-source/SKILL.md` |

Codex finds the same skills on its own under `.agents/skills`, which is a link
to `.claude/skills`: type `$apply`, or `/skills` to list them. On a checkout
without symbolic links (Windows without developer mode), open the files in
the table directly.

Where a skill says "Claude Code", read your own name. Where it says to show a
command in a `bash` block for the person to run, do exactly that: those are
the commands that sign in at an employer, and they are never yours to start.

If `data/profile.json` does not exist, the person has not set the tool up.
Offer the setup skill before anything else. `npx jev doctor` says what is in
place and what to do next.

## Writing with your own model

By default the tool's writer is Claude. A person who works with Codex or
another model sets `WRITER_BACKEND` in `.env` (see `.env.example` and
`docs/SETUP.md`). Do not set it for them without asking: it decides which
company reads their profile.

## Before pushing

```
npx tsc --noEmit && npx vitest run && npm audit --omit=dev
```

Commits follow Conventional Commits and carry no AI attribution of any kind.
