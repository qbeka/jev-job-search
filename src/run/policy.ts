/**
 * The person's standing instructions for the daily run: how many applications, which jobs, which
 * documents, how much JEV may cost. `daily` sends applications with nobody watching, so it does
 * nothing until this file exists, and it checks every job against it in code before the form is opened.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DAILY, DISCOVER, PATHS } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";

export const Policy = z.object({
  version: z.literal(1).default(1),
  /** Applications a day. */
  target: z.number().int().min(1).max(DAILY.maxTarget).default(DAILY.target),
  /** Where a job may be: vancouver, canada, remote, us, international, unclear. Empty means anywhere the search kept. */
  where: z.array(z.enum(["vancouver", "canada", "remote", "us", "international", "unclear"])).default([]),
  /** Which kinds of job: internship, new_grad. Empty means both. */
  levels: z.array(z.enum(["internship", "new_grad"])).default([]),
  /** The lowest fit score a job may have. */
  minScore: z.number().min(0).max(1).default(DISCOVER.applyThreshold),
  /** Which job boards, by the name in the queue: greenhouse, lever, ashby, workday and so on. Empty means every board the tool fills. */
  boards: z.array(z.string()).default([]),
  /** Employers never applied to by the daily run. A name here matches any company whose name contains it. */
  excludeEmployers: z.array(z.string()).default([]),
  /** A resume written for each job, and a cover letter where a form has a box for one. */
  documents: z.object({ tailor: z.boolean().default(false), cover: z.boolean().default(false) }).default({}),
  /** The most JEV may cost in one day. The run stops when it is reached. */
  jevBudgetUsd: z.number().min(0).default(DAILY.jevBudgetUsd),
});
export type Policy = z.infer<typeof Policy>;

/** The policy, or null when the person has not written one. A file that is not valid is an error, never a default. */
export function loadPolicy(file = PATHS.policy): Policy | null {
  if (!existsSync(file)) return null;
  const parsed = Policy.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ")}`);
  return parsed.data;
}

/** Why the policy keeps a job out of the daily run, or null when it may go. */
export function policyRefuses(e: QueueEntry, p: Policy): string | null {
  const company = e.job.company.toLowerCase();
  const excluded = p.excludeEmployers.find((x) => x.trim() && company.includes(x.trim().toLowerCase()));
  if (excluded) return `you excluded ${excluded}`;
  if (p.boards.length && !p.boards.includes(e.job.ats)) return `${e.job.ats} is not one of your boards`;
  if ((e.fit?.score ?? 0) < p.minScore) return `its fit score is under ${p.minScore}`;
  const tier = e.fit?.locationTier;
  if (p.where.length && !(tier && (p.where as string[]).includes(tier))) return `it is not in ${p.where.join(", ")}`;
  const level = (e.fit?.answers.level as { choice?: string } | undefined)?.choice;
  if (p.levels.length && !(level && (p.levels as string[]).includes(level))) return `it is not ${p.levels.join(" or ")}`;
  return null;
}
