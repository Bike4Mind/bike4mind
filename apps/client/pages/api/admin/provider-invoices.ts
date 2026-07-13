import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { providerInvoiceRepository } from '@bike4mind/database';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';

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

const handler = baseApi()
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
    return res.json({ invoice });
  });

export default handler;
