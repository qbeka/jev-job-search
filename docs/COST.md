# What it costs

Two services do the thinking.

- **JEV** answers the questions that have a fixed set of answers, such as
  "which of my details goes in this box?" and "how good a fit is this
  job?" You pay for it through your OpenRouter key. **This is the only
  separate bill.**
- **Claude** writes the answers that need sentences, such as "Why do you
  want to work here?" It runs on the Sonnet 5.5 model at low effort,
  through Claude Code on your own Claude subscription, so there is no
  separate bill for it. A Claude API key, the Codex CLI on a ChatGPT plan,
  or any service that speaks OpenAI's chat completions can write instead.
  See [Choosing the writer](SETUP.md#choosing-the-writer).

## What JEV costs

Measured on three real batches on 2 October 2026, every call recorded:

| Batch | Forms filled | Applications sent | JEV cost | Per 10 forms |
|---|---:|---:|---:|---:|
| 1 | 15 | 10 | $0.022 | $0.015 |
| 2 | 27 | 16 | $0.037 | $0.014 |
| 3 | 36 | 18 | $0.037 | $0.010 |

So **1 to 1.5 cents for every 10 forms**. Most of that is one call per
form that decides what goes in each field; reading the page after Submit
and matching remembered answers add a tenth of a cent.

A search is separate: rating 350 to 460 new postings costs $0.06 to
$0.09, and a second search on the same day costs close to nothing, because
a posting that has not changed keeps its rating.

Five dollars of OpenRouter credit pays for about 60 searches and 3,000
applications.

For the record, everything we spent while building and testing the tool
from 1 to 2 October came to $1.43: 4 searches ($0.35), 118 applications
sent, and 67 forms that were rehearsed over and over while fixing bugs
($0.67 of it). Normal use does not do that.

What changes these numbers:

- **Forms with more fields cost more to map.** A long form is one JEV call
  of a few thousand tokens; a short one is a fraction of a cent. A form
  with several pages is one call per page.
- **A rehearsal costs the same as a real fill**, except the "read the page
  after Submit" step, which only a real application reaches. Sending a
  form you rehearsed does not map it again.
- **Writer calls count toward your subscription's usage allowance** with
  Claude Code or Codex. On an API key, `cost` shows what they cost
  instead, where the service reports it.

To see what you have spent, run `npx jev cost`. Every run that
fills forms also prints its own cost at the end.

## How the tool keeps the cost down

- **It remembers answers.** Every answer Claude writes is kept on your
  computer. When you rehearse a form and then send it, the tool reuses the
  answers you read in the rehearsal and does not ask Claude again. We ran
  the same 10 forms a second time: Claude was asked about 1 form instead of
  6.
- **It reuses an answer on another company's form only when that is safe.**
  Claude marks an answer as reusable only if it would be true for any
  company. JEV then checks that the new question asks for the same thing.
  Most open questions name the company, so expect this to save a little,
  not a lot: in our test, 1 answer in 8 was reusable.
- **It forgets when you change your profile.** A remembered answer is used
  only while your profile, your drafts and your voice guide are unchanged.
  A corrected fact is never overruled by an old answer.
- **It does not ask JEV the same thing twice.** A posting that has not
  changed keeps its rating from the last search, and a form that has not
  changed keeps its field mapping. A second search on the same day costs
  close to nothing.
- **It sends Claude only what Claude needs.** Your profile is sent once per
  run and reused from a cache for the following forms.
- **JEV does everything it can.** On a typical form JEV settles all but one
  or two fields, for about a tenth of a cent.

To see or clear what the tool remembers, run `npx jev memory`.
