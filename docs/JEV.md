# JEV: what it is and how this tool uses it

*Research notes and the question schemas. Sources: the OpenRouter guide at
openrouter.ai/docs/guides/community/jev, the tutorial at
openrouter.ai/docs/guides/community/jev-tutorial, docs.typesafe.ai
(introduction, primitives, confidence, patterns), the model page
openrouter.ai/typesafe/jev-1.13, and live calls made while building this.
The TypeSafe API section follows docs.typesafe.ai/api and
api.typesafe.ai/openapi.json. Last verified 2026-10-02 (TypeSafe API:
2026-11-11, from the documentation, no live call).*

## What JEV is

JEV (`typesafe/jev-1.13`) is TypeSafe's "System One" decision model. You
send it a **state** (the thing to judge) and a map of **typed questions**;
it returns a typed answer per question with a probability distribution.
It never writes prose, never explains itself, and cannot see images. It
is for the part of a workflow where a human would glance and decide, not
the part where they would write.

Why it fits this project: an application form is a long list of small
decisions (which value goes here, which option is right, is this page the
success page) and a job list is a long list of small judgements (is this
software, is it paid, does the stack match). Each is a typed question.
Claude is reserved for the two or three sentences per application that
need writing.

## The API

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json

{ "model": "typesafe/jev-1.13", "state": <string | object | string[]>, "questions": { <key>: <question> } }
```

An alias `~typesafe/jev-latest` exists.

The same model is sold directly by TypeSafe, and the tool uses that when
`TYPESAFE_API_KEY` is in `.env` (`jevProvider()` in `src/config.ts`; with
both keys TypeSafe wins unless `JEV_PROVIDER=openrouter`):

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json

{ "model": "jev-1.13.0", "state": <string | object | string[]>, "questions": { <key>: <question> } }
```

`jev-1.13.0` is the versioned id of the model OpenRouter calls
`typesafe/jev-1.13`. TypeSafe's aliases (`jev-latest`, `jev-preview`) move
to new releases, so the tool pins the version. The price is the same,
$0.042 per million input tokens with output free. TypeSafe's response has
`model`, `answers` and `usage: { input_tokens, output_tokens }`, with no
`id`, `provider` or `cost`; the client works the cost out from the input
tokens at `JEV.inputUsdPerToken` and logs it with `cost_estimated: true`.

Response from OpenRouter (observed):

```json
{
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "id": "gen-dec-…",
  "answers": {
    "is_software_role": { "type": "noul", "noul": 0.98 },
    "level": { "type": "choice", "choice": "internship", "probabilities": { "internship": 1, "new_grad": 0, "experienced": 0, "other": 0 }, "confidence": 1 },
    "stack_match": { "type": "score", "score": 2.15, "legend": { "0": "No overlap", "1": "Weak overlap", "2": "Partial overlap", "3": "Strong overlap", "4": "Near exact match" }, "probabilities": { "0": 0.01, "1": 0.13, "2": 0.56, "3": 0.29, "4": 0.01 }, "confidence": 0.62 }
  },
  "usage": { "input_tokens": 716, "output_tokens": 163, "cost": 0.000030072 }
}
```

`src/jev/types.ts` holds the zod schema; `src/jev/client.ts` validates
every response against it, checks that every question was answered with
the right type, retries 429 and 5xx with backoff, and refuses to exceed a
per-run spend cap.

## The three question types

| Type | Asks | Required fields | Returns |
|---|---|---|---|
| `noul` | Is this true? | `instructions`; optional `criteria: { true, false }` | `noul`: probability 0 to 1 that the answer is yes. No separate confidence. |
| `choice` | Which one of these? | `instructions`, `criteria: { key: description }` | `choice` (the winning key), `probabilities` over all keys, `confidence` |
| `score` | Where on this ordered scale? | `instructions`, `criteria: [lowest … highest]` | `score` (probability-weighted index, e.g. 2.15 on 0..4), `legend`, `probabilities` per level, `confidence` |

Rules learned writing criteria:

- Criteria are **definitions**, not labels. "payments: Payments, invoicing,
  refunds" works; "payments: Payments" works less well. Every choice in this
  repo describes what would make that option correct.
- One question, one judgement. A question that weighs two things gets
  decomposed into two questions and combined in code (TypeSafe's own
  guidance).
- Ask every question you might need in the same call (their "speculative
  fan-out" pattern). Cost is per input token and the state is the expensive
  part, so twelve questions cost about the same as one.
- Score levels are ordered low to high and the numeric answer is the
  expectation over levels, so a 2.15 on a five-level scale means "mostly
  partial, leaning strong".

## Confidence

For `choice` and `score`, `confidence` summarizes how concentrated the
distribution is: 1.0 means all mass on one option. It is not a calibrated
probability of being right, and the docs are explicit that it says nothing
about whether acting is safe. TypeSafe's suggested gates, which this tool
follows (`FORM` in `src/config.ts`):

| Confidence | Action here |
|---|---|
| ≥ 0.9 | Apply the mapping silently |
| 0.5 to 0.9 | Apply it, note the confidence in the plan |
| < 0.5 | Do not act; Claude reads the field and decides |

Noul has no confidence field. The tool treats values near 0 or 1 as
decisive and the middle (0.3 to 0.7) as "unsure", exactly as a distribution
would be read.

## Limits, pricing, latency

| Fact | Value |
|---|---|
| Context length | 32,000 tokens |
| Max completion tokens | 28,800 (irrelevant; output is typed) |
| Price | $0.042 per million input tokens; output free |
| Observed latency | 0.5 to 1.3 s per call, regardless of question count |
| Observed cost | $0.00003 per rating call, $0.0006 to $0.0025 per form mapping |
| Rate limits | Not documented. Six concurrent calls ran clean for 478 jobs. |
| Input | Text only. No images, no files. |
| Output | Typed answers only. No explanations, no free text. |

A full discover run (about 480 ratings) costs about seven cents. Fifty
applications cost a few cents more. The $1 per-run cap in `config.ts` is a
guard against a bug, not a budget.

## Every question this tool asks

### Fit rating (`src/jobs/rate.ts`, one call per job)

State: `{ job: { company, title, locations, posted_days_ago, terms_from_source, sponsorship_flag_from_source, description }, candidate: { summary, skills, facts, graduation, citizenship, authorized_to_work_in, authorized_now_but_needs_sponsorship_later_in?, preferred_locations } }` (the `?` key only when the profile lists such a country)

| Key | Type | Why |
|---|---|---|
| `is_software_role` | noul | Hard skip below 0.5. Title filters miss "Member of Technical Staff" and catch "Software" in "Software Sales"; the description settles it. |
| `level` | choice: internship, new_grad, experienced, other | `experienced` with confidence ≥ 0.6 is a skip. |
| `is_unpaid` | noul | Skip above 0.7. |
| `needs_advanced_degree` | noul | "Require", not "prefer". Skip above 0.7. |
| `work_auth` | choice: canada_ok, us_sponsors, us_no_sponsorship, us_citizenship_required, remote_global, unclear | The two US negatives are skips. Everything else is applied to truthfully. |
| `term` | choice: summer_2027, new_grad_2027, winter_2027, fall_2026, other | Feeds the term component of the score. |
| `returning_student_required` | noul | Not a skip; recorded in the notes because the candidate may extend a term. |
| `stack_match` | score 0..4 | Score component. |
| `experience_match` | score 0..4 | Score component. |
| `location_tier` | choice: vancouver, canada, remote, us, international, unclear | Used only when code cannot classify the location strings. |
| `interview_practical` | noul | Small bonus; the user prefers practical loops. |
| `callback_likelihood` | score 0..4 | The heaviest component: the composite judgement a recruiter would make. |
| `needs_account` | noul | Trusted only when the ATS is unknown to code and the value is above 0.9. |
| `requires_references` | noul | Skip above 0.85; the user does not supply references. |

Composite: weights in `FIT_WEIGHTS`, multiplied by a location tier factor
and a recency factor (1.0 today, 0.7 at fourteen days). Hard rules are
skips, not low scores, so the threshold only trims weak matches.

### Form mapping (`src/forms/mapForm.ts`, one call per 40 fields)

State: the page context, the job's company and country, the candidate's
flattened facts, work authorization resolved for this country, education,
demographics, preferences, the GPA policy, four rules, and the list of
fields (id, kind, label, hint, placeholder, name, autocomplete, required,
option labels).

| Field kind | Question | Criteria |
|---|---|---|
| text, email, tel, url, number, date, textarea | "Field X: which value should fill it?" | Every profile key in `src/profile/fieldKeys.ts` with its description, every answer-bank intent as `bank:<intent>`, plus `free_text`, `resume_upload`, `leave_blank`, `unknown`, `answer_yes`, `answer_no` |
| select, radio, combobox with visible options | "Field X: which option is correct for the candidate?" | The options themselves (`o0`, `o1`, …) plus `__none__` |
| combobox with no visible options (react-select, typeaheads) | Same as text | The value is typed and the matching option clicked by `fillFields.js` |
| checkbox | "Should this be checked for the candidate?" (noul) | true: consent or a true statement; false: opt-in or untrue |
| file | No question | Resume uploads are detected in code; cover letters and autofill helpers are skipped |

Observed on real blank forms (Pinterest on Greenhouse, Match Group on
Lever, Superhuman on Ashby): Greenhouse 24 fields → 21 fills, 1 upload, 2
reviews, about $0.002; Lever 29 fields → 16 fills, 1 upload, 1 draft, 0
reviews, $0.0012; Ashby 10 fields → 8 fills, 1 upload, $0.0006. Each
mapping call took about one second.

### Page state (`src/forms/pageState.ts`, one call per navigation)

State: `{ url, text }` with the page's visible text capped at 8,000 characters.

| Key | Type |
|---|---|
| `state` | choice: job_description, application_form, submitted, login_required, captcha, closed, error, other |
| `has_apply_button` | noul |
| `has_more_pages` | noul |
| `requires_references` | noul |
| `requires_cover_letter` | noul |

## What JEV is not used for

- Writing anything. Free-text answers come from Claude, from the profile's
  facts and `data/voice.md`.
- Reading screenshots. Pages are serialized to text or to a field list first.
- Final authority on truth. Work authorization and GPA are resolved in code
  from the profile; JEV only picks which field they belong in.
