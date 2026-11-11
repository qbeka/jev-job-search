/**
 * Types for the OpenRouter Decisions API (typesafe/jev-1.13).
 * Reference: https://openrouter.ai/docs/guides/community/jev and docs.typesafe.ai.
 */
import { z } from "zod";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** Ordered from lowest to highest. The score is the probability-weighted index. */
  criteria: string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

/** State may be a string, a JSON object, or an array of strings. */
export type State = string | Record<string, unknown> | string[];

export const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
export const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
export const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
export const Answer = z.discriminatedUnion("type", [NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type Answer = z.infer<typeof Answer>;
export type NoulAnswer = z.infer<typeof NoulAnswer>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;

export const DecisionResponse = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  answers: z.record(z.string(), Answer),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

export type Usage = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
