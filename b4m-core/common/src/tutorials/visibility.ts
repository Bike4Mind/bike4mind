import { z } from 'zod';

/** Who may see a core tutorial. The entitlement is a plain key, so common names no entitlement. */
export type CoreTutorialVisibility = { entitlement: string; public?: never } | { public: true; entitlement?: never };

export const CoreTutorialVisibilitySchema: z.ZodType<CoreTutorialVisibility> = z.union([
  z.object({ entitlement: z.string().trim().min(1).max(100) }).strict(),
  z.object({ public: z.literal(true) }).strict(),
]);
