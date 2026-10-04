# Sources

*What is read, how, and how fresh. Last verified 2026-10-02.*

Every source produces the same `Job` shape (`src/jobs/normalize.ts`) and
is deduplicated by canonical URL (tracking parameters stripped), so a
posting found by three lists is rated once.

| Source | Read how | Freshness | Notes |
|---|---|---|---|
| SimplifyJobs Summer2027-Internships | `listings.json` behind the README (`.github/scripts/listings.json`, dev branch). Fields: category, company, title, active, terms, date_posted, url, locations, sponsorship, degrees | Updated continuously; about 17,000 rows, 4,500 active, about 1,000 posted in the last two weeks | Only `Software` and `Software Engineering` categories. `sponsorship` and `degrees` flags feed the pre-filter. |
| SimplifyJobs New-Grad-Positions | Same format, no `terms` | About 19,600 rows | New-grad roles for a May 2027 start. |
| negarprh/Canadian-Tech-Internships-2027 | README markdown table, badge links, `MMM DD, YYYY` dates, `↳` for repeated companies, 🔒 closed | 450+ rows, most Workday | Canada only. |
| vanshb03/Summer2027-Internships | README table, `<a href>` links, `MMM DD` dates, 🛂 and 🇺🇸 flags | About 200 rows | US and Canada. |
| michelleokolie/canada-tech-internships-summer-2027 | README table, `<a href>` links | Small | Canada only. |
| Greenhouse boards | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Live | Polled for every company the lists mention plus the seed list in `src/sources/companies.ts`. Full description included. |
| Lever boards | `api.lever.co/v0/postings/{slug}?mode=json` | Live | Same. |
| Ashby boards | `api.ashbyhq.com/posting-api/job-board/{slug}` | Live | Same. Includes `descriptionPlain`. |
| Your tracking sheet | CSV files in `data/imports/` with at least Company and Job Link columns | When you export it | Rows already marked applied are ignored. |

Board polling matters because the lists lag by a day or two and the user
wants the freshest postings. On one run, boards contributed about 2,000
early-career postings on top of the lists, of which a few hundred were
new.

## Descriptions

The rating needs the posting text. `src/jobs/describe.ts` gets it from the
ATS API when the URL is Greenhouse, Lever or Ashby (clean text, cached six
hours) and otherwise fetches the page and strips it to text. Pages that
render only in JavaScript (some Tesla, Rubrik, Epic careers pages) come
back empty and are rated from the title and company alone.

## Workday

Workday postings come from the public lists. Each posting's text is read
from Workday's own posting data (`src/sources/ats/workday.ts`), the same
data its careers page shows, with no sign-in. Applying needs an account
with that employer, so these jobs are kept only once the person has
allowed accounts ([ACCOUNTS.md](ACCOUNTS.md)). In one run 876 of the
postings found were on Workday, across 290 employers.

## Deliberately not read yet

| Source | Why not yet | How it would be added |
|---|---|---|
| LinkedIn Jobs, Indeed, Glassdoor | They need a sign-in or block automated reading. The tool does not sign in anywhere | Not planned |
| iCIMS, Taleo, Oracle, SuccessFactors, Amazon Jobs | Every one needs an account | An adapter in `src/accounts/`, like the one for Workday. Until then these jobs are skipped |
| SmartRecruiters | Its form is drawn inside components the page scripts cannot read yet | Reading through shadow roots in `dumpFields.js` and `fillFields.js` |
| German-language boards | English only for version one | A `lang` field on `Job` and a German `voice.md` |
| Company careers pages with no public API | No structured feed | Per-company HTML parsers; the board APIs cover most of the early-career market |

## Adding a source

1. Write `src/sources/<name>.ts` exporting `fetch<Name>(): Promise<Job[]>`.
   Use `getText`/`getJson` from `src/util/http.ts` so caching and timeouts
   apply.
2. Set `source` to a short stable name, `postedAt` to an ISO date when
   known, and run every URL through `canonicalUrl`.
3. Call it from `collectJobs` in `src/discover.ts`.
4. Add a fixture under `tests/fixtures/` and a parser test.
