import { baseApi } from '@server/middlewares/baseApi';
import { creditTransactionRepository } from '@bike4mind/database';
import {
  CreditHolderType,
  COMPLETION_SOURCES,
  type CreditTransactionType,
  type IAdminLedgerResponse,
  type ILedgerRow,
} from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { resolveUserNames } from '@server/utils/resolveUserNames';
import { z } from 'zod';

/** Accept a repeated (`type=a&type=b`) or comma-joined (`type=a,b`) query param as a string array. */
const csvArray = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform(v => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).map(s => s.trim()).filter(Boolean)));

const QuerySchema = z.object({
  organizationId: z.string().min(1),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  type: csvArray,
  source: z.enum(COMPLETION_SOURCES).optional(),
  model: z.string().min(1).optional(),
});

/**
 * Admin endpoint: one organization's credit-transaction ledger, paginated and
 * filterable (date / type / source / model). Owner-scoped to the org's pool,
 * newest first. Reads CreditTransactionModel (the signed ledger) so totals
 * reconcile with the org's currentCredits.
 *
 * The acting member is surfaced only where the write path recorded it
 * (metadata.actingUserId - API/CLI org-billed rows); web org-billed usage does
 * not carry it, so those rows have no member.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { organizationId, page = 1, limit = 25, days, type, source, model } = QuerySchema.parse(req.query);

  const { data, total } = await creditTransactionRepository.queryLedgerPage(
    organizationId,
    CreditHolderType.Organization,
    { days, transactionTypes: type as CreditTransactionType[], source, model, limit, skip: (page - 1) * limit }
  );

  // Resolve the acting-member ids that some rows carry to display names.
  const actingIds = data
    .map(t => (t.metadata as { actingUserId?: string } | undefined)?.actingUserId)
    .filter((id): id is string => !!id);
  const nameById = await resolveUserNames(actingIds);

  const rows: ILedgerRow[] = data.map(t => {
    const actingUserId = (t.metadata as { actingUserId?: string } | undefined)?.actingUserId;
    // model/questId/sessionId/apiKeyId live only on the usage variants of the
    // discriminated union; read them through an optional view rather than narrow per type.
    const usage = t as Partial<{ model: string; questId: string; sessionId: string; apiKeyId: string }>;
    return {
      id: String(t.id),
      createdAt: t.createdAt.toISOString(),
      type: t.type,
      credits: t.credits,
      source: t.source,
      model: usage.model,
      questId: usage.questId,
      sessionId: usage.sessionId,
      apiKeyId: usage.apiKeyId,
      description: t.description,
      actingUserId,
      actingUserName: actingUserId ? nameById.get(actingUserId) : undefined,
    };
  });

  const response: IAdminLedgerResponse = {
    organizationId,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    rows,
  };

  return res.json(response);
});

export default handler;
