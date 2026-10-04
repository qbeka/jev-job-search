/**
 * Careers sites that put a sign-in or an account in front of the form. The
 * tool signs in only on a board it has an adapter for, with an account the
 * person set up (src/accounts/). Jobs on every other such site are skipped
 * before rating. The list starts from config and grows: when a run meets
 * such a page, the site goes into the site knowledge (src/knowledge/sites.ts)
 * and the next discover skips it.
 */
import { existsSync, readFileSync } from "node:fs";
import { DISCOVER, PATHS } from "../config.js";
import { learn, signInHosts } from "../knowledge/sites.js";
import { hostIs } from "./normalize.js";

/** One company's settings on a shared board say nothing about the other companies there. */
const SHARED_BOARDS = ["greenhouse.io", "lever.co", "ashbyhq.com", "rippling.com", "bamboohr.com", "smartrecruiters.com", "jobvite.com", "workable.com"];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Sites an earlier version noted in its own file. Still honoured. */
function legacyWalledHosts(file = PATHS.walledHosts): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

export const learnedWalledHosts = (known: string[] = signInHosts()): string[] => [...new Set([...known, ...legacyWalledHosts()])];

export function isWalled(url: string, learned: string[] = learnedWalledHosts()): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return DISCOVER.accountWalledHosts.some((h) => hostIs(host, h)) || learned.includes(host);
}

/** Notes that a job's site wanted a sign-in, so the next discover skips it. */
export function rememberWalledHost(url: string, notes: string = PATHS.knowledgeLocal): void {
  const host = hostOf(url);
  if (!host || SHARED_BOARDS.some((d) => hostIs(host, d))) return;
  learn(url, { signIn: true }, notes);
}
