import { z } from 'zod';
import { isCalendarDate } from './settings';
import { paginatedResponseSchema } from './pagination';

/**
 * Wire schemas for obligations (`/api/v1/obligations`): a scanned bill, receipt or letter the user handed to
 * the assistant. The assistant extracts the amount, payee and due date and suggests a data lake to file it in;
 * nothing is filed or briefed until the user confirms. A confirmed obligation with a due date reaches the
 * user's brief ahead of that date.
 */

export const OBLIGATION_STATUSES = ['pending', 'confirmed', 'dismissed'] as const;
export const ObligationStatusSchema = z.enum(OBLIGATION_STATUSES);
export type ObligationStatus = z.infer<typeof ObligationStatusSchema>;

export const OBLIGATION_DOCUMENT_KINDS = ['invoice', 'receipt', 'letter', 'other'] as const;
export const ObligationDocumentKindSchema = z.enum(OBLIGATION_DOCUMENT_KINDS);
export type ObligationDocumentKind = z.infer<typeof ObligationDocumentKindSchema>;

/** Bounds shared by the route, the stored record and the extractor. */
export const OBLIGATION_LIMITS = {
  payee: 200,
  summary: 400,
  text: 20000,
} as const;

export const ObligationDueDateSchema = z
  .string()
  .refine(isCalendarDate, 'due_date must be a real calendar date as YYYY-MM-DD')
  .describe('Calendar date the payment is due, `YYYY-MM-DD`, with no time zone.');

export const ObligationAmountSchema = z.object({
  value: z.number().finite().nonnegative().describe('Amount in major units, e.g. 120.5 for $120.50.'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code such as USD')
    .describe('ISO 4217 currency code.'),
});
export type ObligationAmount = z.infer<typeof ObligationAmountSchema>;

export const ObligationDestinationSchema = z.object({
  lake_id: z.string().min(1),
  name: z.string(),
});

export const ObligationSchema = z.object({
  id: z.string().min(1),
  status: ObligationStatusSchema.describe(
    '`pending` until you confirm or dismiss it; `confirmed` once you accepted the fields; `dismissed` if you ' +
      'discarded it.'
  ),
  document_kind: ObligationDocumentKindSchema,
  file_id: z.string().min(1).describe('The uploaded scan.'),
  amount: ObligationAmountSchema.nullable(),
  payee: z.string().max(OBLIGATION_LIMITS.payee).nullable(),
  due_date: ObligationDueDateSchema.nullable(),
  destination: ObligationDestinationSchema.nullable().describe(
    'The data lake the document is filed in on confirm. Suggested by the assistant from your own lakes.'
  ),
  summary: z
    .string()
    .max(OBLIGATION_LIMITS.summary)
    .describe('Model-written from the document, so treat it as untrusted text.'),
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
});
export type Obligation = z.infer<typeof ObligationSchema>;

export const ObligationHandoffRequestSchema = z.object({
  file_id: z.string().min(1).describe('A file you uploaded with `POST /api/v1/files`. It must be yours.'),
  text: z
    .string()
    .max(OBLIGATION_LIMITS.text)
    .optional()
    .describe("Text recognized on the device. When absent or blank, the file's indexed text is read instead."),
});
export type ObligationHandoffRequest = z.infer<typeof ObligationHandoffRequestSchema>;

/** Every field is optional; the route rejects a body that sets none of them. */
export const ObligationUpdateRequestSchema = z.object({
  amount: ObligationAmountSchema.nullable().optional(),
  payee: z.string().min(1).max(OBLIGATION_LIMITS.payee).nullable().optional(),
  due_date: ObligationDueDateSchema.nullable().optional(),
  destination_lake_id: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('A data lake you can manage, or null to file nowhere.'),
  status: z.enum(['confirmed', 'dismissed']).optional(),
});
export type ObligationUpdateRequest = z.infer<typeof ObligationUpdateRequestSchema>;

export const ObligationIdParamSchema = z.object({
  id: z.string().min(1).describe('The obligation id returned by `POST /api/v1/obligations`.'),
});

export const ListObligationsQuerySchema = z.object({
  status: ObligationStatusSchema.optional().describe('Only obligations in this status.'),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListObligationsQuery = z.infer<typeof ListObligationsQuerySchema>;

export const ListObligationsResponseSchema = paginatedResponseSchema(ObligationSchema);
export type ListObligationsResponse = z.infer<typeof ListObligationsResponseSchema>;
