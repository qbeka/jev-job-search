/**
 * Questions that come up on most applications. JEV maps a free-text field to
 * one of these intents; Claude adapts the candidate's own draft for it to the
 * company and the field's length. Every claim in a draft traces to the profile.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PATHS } from "../config.js";

export const BANK_INTENTS: Record<string, string> = {
  why_company: "Why do you want to work at this company, or what interests you about us",
  why_role: "Why this role, team or internship specifically",
  about_yourself: "Tell us about yourself, a short bio, or a summary",
  proudest_project: "Describe a project you are proud of, your best work, or something you built",
  challenge: "Describe a hard problem, a challenge you overcame, or a failure and what you learned",
  strengths: "Your strengths, what you are good at, or what you bring",
  weakness: "A weakness or an area you are improving",
  teamwork: "Working in a team, collaboration, handling disagreement or conflict",
  leadership: "A time you led, took initiative or ownership",
  why_hire: "Why should we hire you, what makes you different",
  career_goals: "Career goals, where you see yourself, what you want to learn",
  technical_interest: "A technology, area or problem space you find interesting",
  ai_tools: "How you use AI or coding assistants in your work",
  additional_info: "Anything else you want us to know, additional information, comments",
  availability_details: "Details about availability, start date, work term length or hours",
  relocation_details: "Willingness or plans to relocate, or location preferences in prose",
  how_heard_details: "How you heard about the role, in prose",
  experience_summary: "Summarize your relevant experience with a technology or domain named in the question",
};

export type BankIntent = keyof typeof BANK_INTENTS;

const Drafts = z.record(z.string(), z.string());

/**
 * Starting drafts, one per intent, written by the candidate. They live in
 * data/bank.json, which is git-ignored because every sentence is about one
 * person; data/bank.example.json shows the shape with a made-up candidate.
 * Text in braces is left for Claude to write from the job and the profile.
 */
export function loadBankDrafts(file = existsSync(PATHS.bank) ? PATHS.bank : PATHS.bankExample): Record<BankIntent, string> {
  const given = existsSync(file) ? Drafts.parse(JSON.parse(readFileSync(file, "utf8"))) : {};
  return Object.fromEntries(Object.keys(BANK_INTENTS).map((intent) => [intent, given[intent] ?? ""]));
}

export const BANK_DRAFTS: Record<BankIntent, string> = loadBankDrafts();

/** Cheap keyword match from a question to the closest intents, best first. */
export function closestIntents(question: string, limit = 3): BankIntent[] {
  const q = question.toLowerCase();
  const scores: Array<[BankIntent, number]> = (Object.keys(BANK_INTENTS) as BankIntent[]).map((intent) => {
    const words = `${intent.replace(/_/g, " ")} ${BANK_INTENTS[intent]}`.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const hits = words.filter((w) => q.includes(w)).length;
    return [intent, hits];
  });
  return scores.sort((a, b) => b[1] - a[1]).filter(([, s]) => s > 0).slice(0, limit).map(([i]) => i);
}
