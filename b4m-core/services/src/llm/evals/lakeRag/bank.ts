/**
 * The lake-RAG question bank (`bank.json`) and its schema. Validated on load rather than trusted:
 * a row whose pattern does not compile, or a planted case with nothing to reject, would otherwise
 * grade every reply the same way and report a measurement it never made.
 */
import { z } from 'zod';
import bankJson from './bank.json';

export const LAKE_RAG_KINDS = ['fact', 'stale-same-name', 'stale-different-name', 'absent'] as const;
export type LakeRagKind = (typeof LAKE_RAG_KINDS)[number];

const STALE_KINDS: ReadonlySet<LakeRagKind> = new Set(['stale-same-name', 'stale-different-name']);

function compiles(source: string): boolean {
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

/** A regex source, matched case-insensitively and only as a whole token (see `tokenMatcher` in grade.ts). */
const PatternSchema = z.string().min(1).refine(compiles, { message: 'pattern does not compile' });

export const LakeRagBankRowSchema = z
  .object({
    id: z.string().min(1),
    /** Corpus directory under `corpus/`. */
    subject: z.string().min(1),
    kind: z.enum(LAKE_RAG_KINDS),
    question: z.string().min(1),
    /** Every pattern must match the reply. */
    expect: z.array(PatternSchema),
    /** File name of the current document that answers the question; null for `absent`. */
    expectSource: z.string().min(1).nullable(),
    /** The stale value(s). Any match outside a sentence that marks it as outdated fails the reply. */
    rejectTokens: z.array(PatternSchema),
  })
  .superRefine((row, ctx) => {
    const absent = row.kind === 'absent';
    if (absent && (row.expect.length > 0 || row.expectSource !== null)) {
      ctx.addIssue({ code: 'custom', message: `${row.id}: an absent case has no expected answer or source` });
    }
    if (!absent && (row.expect.length === 0 || row.expectSource === null)) {
      ctx.addIssue({ code: 'custom', message: `${row.id}: needs expect patterns and an expectSource` });
    }
    if (STALE_KINDS.has(row.kind) && row.rejectTokens.length === 0) {
      ctx.addIssue({ code: 'custom', message: `${row.id}: a stale case must name the stale value to reject` });
    }
  });

export type LakeRagBankRow = z.infer<typeof LakeRagBankRowSchema>;

export const LakeRagBankSchema = z.array(LakeRagBankRowSchema).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) ctx.addIssue({ code: 'custom', message: `duplicate bank id: ${row.id}` });
    seen.add(row.id);
  }
});

/** Parses `raw` (default: the bundled `bank.json`) and throws on any malformed row. */
export function loadLakeRagBank(raw: unknown = bankJson): LakeRagBankRow[] {
  return LakeRagBankSchema.parse(raw);
}
