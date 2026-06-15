import { createAtom } from "rxfy";

export type RateLimitEvent = {
  resetAt: Date;
  used: number;
  limit: number;
};

export const rateLimitEvent$ = createAtom<RateLimitEvent | null>(null);
