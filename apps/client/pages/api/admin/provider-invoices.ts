import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { providerInvoiceRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError, BadRequestError } from '@bike4mind/server-utils/utils/errors';

/**
 * Admin surface for monthly provider invoice reconciliation. An admin enters
 * each provider's invoice total; the Margins dashboard computes the delta
 * against recorded COGS at read time. Append-only: corrections are new rows.
 *
 * GET  -> { invoices } newest row per (month, provider)
 * POST { month, provider, invoiceUsd, note } -> { invoice }
 */
const InvoiceBody = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
  provider: z.string().min(1),
  invoiceUsd: z.number().finite().nonnegative(),
  note: z.string(),
});

// requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key
// before req.user is set, so a key issued for a narrow integration can't read or
// enter provider invoices just because its owner is an admin. JWT/browser admins
// skip that check and still pass the isAdmin gates below.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    return res.json({ invoices: await providerInvoiceRepository.newestPerMonthProvider() });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const parsed = InvoiceBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'invalid invoice entry');
    const note = parsed.data.note.trim();
    if (!note) throw new BadRequestError('note is required: name the invoice and its billing period');

    const invoice = await providerInvoiceRepository.append({
      month: parsed.data.month,
      provider: parsed.data.provider,
      invoiceUsd: parsed.data.invoiceUsd,
      note,
      enteredBy: req.user.id,
    });
    await recordAdminActionFromRequest(req, {
      action: 'settings.provider_invoice.recorded',
      target: {
        kind: 'settings',
        id: `${parsed.data.month}:${parsed.data.provider}`,
        displayName: `${parsed.data.provider} invoice ${parsed.data.month}`,
      },
      summary: `recorded ${parsed.data.provider} invoice for ${parsed.data.month}`,
      details: { month: parsed.data.month, provider: parsed.data.provider, invoiceUsd: parsed.data.invoiceUsd, note },
    });
    return res.json({ invoice });
  });

export default handler;
