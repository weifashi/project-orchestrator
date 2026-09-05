import { z } from 'zod';
import { DIMENSIONS } from './recording.js';

const score = z.number().int().min(1).max(5);
const perDimension = <T extends z.ZodTypeAny>(inner: T) =>
  z.object(Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, inner])) as Record<(typeof DIMENSIONS)[number], T>);

export const JudgeOutput = z.object({
  scores: perDimension(score),
  rationale: perDimension(z.string().min(1)),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;
