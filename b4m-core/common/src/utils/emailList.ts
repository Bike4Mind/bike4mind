import { z } from 'zod';

const emailSchema = z.string().email();

/**
 * Splits a stored list of email addresses into usable (trimmed, lowercased, deduped) and invalid
 * entries. Checked one entry at a time so a single typo cannot discard the whole list. Non-array
 * input yields nothing; non-string entries count as invalid.
 */
export function partitionEmailList(entries: unknown): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const email = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (email && emailSchema.safeParse(email).success) valid.add(email);
    else invalid.push(String(entry));
  }
  return { valid: [...valid], invalid };
}
