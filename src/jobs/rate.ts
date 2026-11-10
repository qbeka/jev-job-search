/**
 * The fit rating. One JEV call per job with every question the pipeline
 * might need (speculative fan-out). Code turns the typed answers into a
 * composite score, hard skips, and human-readable reasons.
 */
import { FIT_WEIGHTS, GRADUATION_MISMATCH_MULTIPLIER, LOCATION_MULTIPLIER, RECENCY_FLOOR, DISCOVER } from "../config.js";
import type { JevClient } from "../jev/client.js";
import { choice, noul, score, scoreToUnit } from "../jev/questions.js";
import type { Answer, ChoiceAnswer, NoulAnswer, Questions, ScoreAnswer } from "../jev/types.js";
import { monthName, sponsorshipLater, usStatus, type Profile } from "../profile/schema.js";
import { locationTier, type LocationTier } from "./hardFilters.js";
import { ageDays, type Job } from "./normalize.js";
import { hashOf, type KeyedCache } from "../util/cache.js";

const LEVELS5 = ["None", "Weak", "Partial", "Strong", "Near exact"];

/** The term criteria, worded for the candidate's own graduation year so the same code serves any class. */
function termCriteria(gradMonth: number, gradYear: number): Record<string, string> {
  const grad = `${monthName(gradMonth)} ${gradYear}`;
  return {
    summer: `Summer ${gradYear} internship or co-op (roughly May to August ${gradYear})`,
    new_grad: `Full-time role a candidate graduating in ${grad} could start by mid ${gradYear}`,
    winter: `Winter or Spring ${gradYear} term (January to April ${gradYear})`,
    earlier: `Fall ${gradYear - 1} or starts before January ${gradYear}`,
    other: "A different term, rolling with no term stated, or unclear",
  };
}

/** Every question for one posting, with the term and graduation wording taken from the profile. */
export function fitQuestions(profile: Pick<Profile, "education">): Questions {
  const edu = profile.education[0];
  const month = edu?.gradMonth ?? 4;
  const year = edu?.gradYear ?? new Date().getUTCFullYear() + 1;
  return {
    ...FIT_QUESTIONS,
    term: choice("Which term or start does this posting target?", termCriteria(month, year)),
    graduation_excluded: noul(`Does the posting require a graduation date or year of study that a candidate graduating in ${monthName(month)} ${year} does not meet?`, {
      true: `It names a graduation window, class year or "returning to school after" rule that excludes ${monthName(month)} ${year}`,
      false: `No graduation requirement is stated, or ${monthName(month)} ${year} fits it`,
    }),
  };
}

export const FIT_QUESTIONS: Questions = {
  is_software_role: noul("Is this a software engineering or software developer role (writing application, backend, frontend, mobile, infrastructure or platform code)?", {
    true: "The day-to-day work is writing software",
    false: "Hardware, data science, analytics, product, research, IT support, or anything else",
  }),
  level: choice("What level is this posting?", {
    internship: "Internship, co-op, student or work term",
    new_grad: "New grad, early career, entry level, or junior with 0 to 2 years",
    experienced: "Requires 3 or more years of professional experience, or is mid, senior or staff",
    other: "Unclear or not a job posting",
  }),
  is_unpaid: noul("Does the posting say the role is unpaid, volunteer, or for academic credit only?"),
  needs_advanced_degree: noul("Does the posting require (not merely prefer) a Master's degree or PhD?"),
  work_auth: choice("What does the posting require for work authorization?", {
    canada_ok: "Canadian work authorization is enough, or the role is in Canada with no restriction stated",
    us_sponsors: "The role is in the United States and the posting says sponsorship is available or possible",
    us_no_sponsorship: "The role is in the United States and the posting says no sponsorship, or must be authorized without sponsorship",
    us_citizenship_required: "US citizenship, a security clearance, or ITAR eligibility is required",
    remote_global: "Remote and open to candidates in any country",
    unclear: "Not stated and not inferable",
  }),
  term: choice("Which term or start does this posting target?", termCriteria(4, new Date().getUTCFullYear() + 1)),
  graduation_excluded: noul("Does the posting require a graduation date or year of study the candidate does not meet?"),
  returning_student_required: noul("Does the posting require the candidate to return to school after the internship?"),
  stack_match: score("How well does the candidate's technical stack match what the posting asks for?", LEVELS5),
  experience_match: score("How well does the candidate's experience level and background match what the posting asks for?", LEVELS5),
  location_tier: choice("Where is the role?", {
    vancouver: "Vancouver or the Lower Mainland, BC",
    canada: "Elsewhere in Canada",
    remote: "Remote, and not restricted to the United States",
    us: "In the United States, or remote restricted to the United States",
    international: "Outside Canada and the United States",
    unclear: "Not stated",
  }),
  interview_practical: noul("Does the posting describe a practical interview process (take-home, pair programming, project review, or AI tools permitted) rather than algorithm puzzles?"),
  callback_likelihood: score("Given everything, how likely is this candidate to be invited to interview if they apply?", [
    "Very unlikely", "Unlikely", "Possible", "Likely", "Very likely",
  ]),
  needs_account: noul("Does applying require creating an account or logging in on the company's own careers portal (as opposed to a single form)?"),
  requires_references: noul("Does the posting say references are required with the application?"),
};

export type FitResult = {
  score: number;
  decision: "apply" | "below_threshold" | "skip";
  skipReason: string | null;
  reasons: string[];
  components: Record<string, number>;
  locationTier: LocationTier;
  answers: Record<string, Answer>;
};

export function buildFitState(job: Job, profile: Profile, now = new Date()): Record<string, unknown> {
  const age = ageDays(job, now);
  return {
    job: {
      company: job.company,
      title: job.title,
      locations: job.locations,
      posted_days_ago: age,
      terms_from_source: job.terms,
      sponsorship_flag_from_source: job.sponsorship,
      description: job.description || "(no description available; judge from the title and company)",
    },
    candidate: {
      summary: profile.summary,
      skills: profile.skills,
      facts: profile.facts,
      graduation: profile.education[0] ? `${monthName(profile.education[0].gradMonth)} ${profile.education[0].gradYear}` : "not given",
      citizenship: profile.workAuthorization.citizenships,
      authorized_to_work_in: profile.workAuthorization.authorizedCountries,
      // Only when the profile lists any, so the ratings cached for every other profile stay valid.
      ...(sponsorshipLater(profile).length ? { authorized_now_but_needs_sponsorship_later_in: sponsorshipLater(profile) } : {}),
      preferred_locations: profile.preferences.preferredLocations,
    },
  };
}

/**
 * What a rating depends on: the posting as JEV sees it, the candidate, and the questions. The
 * posting's age is left out. It changes every day, it is not what the questions are about, and
 * the score takes it from the date, not from JEV.
 */
export function ratingKey(job: Job, profile: Profile): string {
  const state = buildFitState(job, profile, new Date(0)) as { job: Record<string, unknown>; candidate: unknown };
  const { posted_days_ago: _age, ...posting } = state.job;
  return hashOf({ id: job.id, posting, candidate: state.candidate, questions: fitQuestions(profile) });
}

/** Rates a posting. With a cache, an unchanged posting gets the answers JEV gave before, and the score is worked out afresh for today. */
export async function rateJob(jev: JevClient, job: Job, profile: Profile, now = new Date(), cache?: KeyedCache<Record<string, Answer>>): Promise<FitResult> {
  const key = cache ? ratingKey(job, profile) : "";
  let answers = cache?.get(key);
  if (!answers) {
    answers = await jev.decide(buildFitState(job, profile, now), fitQuestions(profile), `rate:${job.company}:${job.title}`);
    cache?.set(key, answers);
  }
  return scoreFromAnswers(job, answers, now, usStatus(profile));
}

export function scoreFromAnswers(job: Job, answers: Record<string, Answer>, now = new Date(), us: { authorized: boolean; citizen: boolean } = { authorized: false, citizen: false }): FitResult {
  // A rating saved before a question existed simply lacks it; that reads as "no".
  const n = (k: string) => (answers[k] as NoulAnswer | undefined)?.noul ?? 0;
  const c = (k: string) => answers[k] as ChoiceAnswer;
  const s = (k: string) => answers[k] as ScoreAnswer;
  const reasons: string[] = [];

  const codeTier = locationTier(job.locations);
  const tier: LocationTier = codeTier !== "unclear" ? codeTier : (c("location_tier").choice as LocationTier);

  let skipReason: string | null = null;
  if (n("is_software_role") < 0.5) skipReason = "not a software role";
  else if (c("level").choice === "experienced" && c("level").confidence >= 0.6) skipReason = "requires professional experience";
  else if (n("is_unpaid") > 0.7) skipReason = "unpaid";
  else if (n("needs_advanced_degree") > 0.7) skipReason = "advanced degree required";
  else if (c("work_auth").choice === "us_no_sponsorship" && c("work_auth").confidence >= 0.5 && !us.authorized) skipReason = "US role, no sponsorship";
  else if (c("work_auth").choice === "us_citizenship_required" && c("work_auth").confidence >= 0.5 && !us.citizen) skipReason = "US citizenship or clearance required";
  else if (job.ats === "other" && n("needs_account") > 0.9) skipReason = "needs an account to apply";
  else if (n("requires_references") > 0.85) skipReason = "references required";

  const levelFit = { internship: 1, new_grad: 1, experienced: 0.1, other: 0.3 }[c("level").choice] ?? 0.3;
  const termFit = { summer: 1, new_grad: 1, winter: 0.8, earlier: 0.3, other: 0.5 }[c("term").choice] ?? 0.5;
  const components = {
    stackMatch: scoreToUnit(s("stack_match").score, LEVELS5.length),
    experienceMatch: scoreToUnit(s("experience_match").score, LEVELS5.length),
    callbackLikelihood: scoreToUnit(s("callback_likelihood").score, 5),
    levelFit,
    termFit,
    interviewPractical: n("interview_practical"),
  };
  let base = 0;
  for (const [k, w] of Object.entries(FIT_WEIGHTS)) base += w * (components[k as keyof typeof components] ?? 0);
  const age = ageDays(job, now);
  const recency = age === null ? 0.85 : 1 - (1 - RECENCY_FLOOR) * Math.min(1, age / DISCOVER.maxAgeDays);
  // The candidate may still apply, so a graduation window that excludes them lowers the rank instead of dropping the job.
  const gradExcluded = n("graduation_excluded") > 0.7;
  const scoreValue = Math.round(base * LOCATION_MULTIPLIER[tier] * recency * (gradExcluded ? GRADUATION_MISMATCH_MULTIPLIER : 1) * 1000) / 1000;

  if (c("work_auth").choice === "us_sponsors" && !us.authorized) reasons.push("US role, sponsorship offered");
  if (c("work_auth").choice === "unclear" && tier === "us" && !us.authorized) reasons.push("US role, sponsorship not stated");
  if (gradExcluded) reasons.push("asks for a different graduation date");
  if (n("returning_student_required") > 0.6) reasons.push("may require returning to school after the term");
  if (n("interview_practical") > 0.6) reasons.push("practical interview process");
  reasons.push(`stack ${LEVELS5[Math.round(s("stack_match").score)] ?? ""}`.toLowerCase());
  reasons.push(`callback ${s("callback_likelihood").legend[String(Math.round(s("callback_likelihood").score))] ?? ""}`.toLowerCase());

  const decision: FitResult["decision"] = skipReason ? "skip" : scoreValue >= DISCOVER.applyThreshold ? "apply" : "below_threshold";
  return { score: scoreValue, decision, skipReason, reasons, components, locationTier: tier, answers };
}
