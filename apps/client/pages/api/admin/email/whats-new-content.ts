import { ModalModel } from '@bike4mind/database';
import { IModalDocument } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { marked } from 'marked';
import { MODAL_SAFE_DEFAULT_KEY } from '@bike4mind/services';

/**
 * Fetches recent What's New modals and renders them as HTML for email content
 *
 * Query params:
 * - days: number of days to look back (default: 7)
 * - ids: comma-separated list of specific modal IDs to fetch (overrides days filter)
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { days = '7', ids, limit: limitParam = '1' } = req.query as { days?: string; ids?: string; limit?: string };

  // Look for modals with whats-new related tags
  const whatsNewTags = ['whatsnew', 'whatsNew', 'whats-new', 'whats_new', 'WhatsNew', 'WHATSNEW', 'WHATS_NEW'];

  let modals;

  if (ids) {
    // Fetch specific modals by ID
    const modalIds = ids
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);
    modals = await ModalModel.find({
      _id: { $in: modalIds },
      tags: { $in: whatsNewTags },
      enabled: true,
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();
  } else {
    // Fetch modals from the last N days
    const daysAgo = parseInt(days, 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);

    const queryLimit = limitParam ? parseInt(limitParam, 10) : 20;
    modals = await ModalModel.find({
      tags: { $in: whatsNewTags },
      enabled: true,
      createdAt: { $gte: startDate },
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean();
  }

  // Exclude internal-only modals (variants map present but no 'customer' key).
  // This endpoint reads top-level fields directly with no leak guard; an
  // internal-only modal has internal text at top-level and must not appear
  // in customer-facing email content.
  const customerModals = modals.filter((modal: IModalDocument) => {
    const v = modal.variants;
    return !v || MODAL_SAFE_DEFAULT_KEY in v;
  });

  if (customerModals.length === 0) {
    return res.json({
      html: '<p>No new updates this period.</p>',
      count: 0,
      modals: [],
    });
  }

  // Render modals as HTML
  const htmlParts = customerModals.map((modal: IModalDocument) => {
    let html = '<div style="margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid #eee;">';

    if (modal.title) {
      // Title is plain text, escape it
      html += `<h3 style="margin: 0 0 8px 0; color: #333;">${escapeHtml(modal.title)}</h3>`;
    }

    if (modal.subtitle) {
      // Subtitle is plain text, escape it
      html += `<p style="margin: 0 0 12px 0; color: #666; font-style: italic;">${escapeHtml(modal.subtitle)}</p>`;
    }

    if (modal.imageUrl) {
      html += `<img src="${escapeHtml(modal.imageUrl)}" alt="${escapeHtml(modal.title || '')}" style="max-width: 100%; height: auto; margin-bottom: 12px; border-radius: 8px;" />`;
    }

    if (modal.description) {
      // Description is Markdown, convert to HTML
      const descriptionHtml = marked.parse(modal.description, { async: false }) as string;
      html += `<div style="margin: 0; color: #444; line-height: 1.6;">${descriptionHtml}</div>`;
    }

    if (modal.textMessage) {
      // textMessage is Markdown, convert to HTML
      const textMessageHtml = marked.parse(modal.textMessage, { async: false }) as string;
      html += `<div style="margin: 12px 0 0 0; color: #444; line-height: 1.6;">${textMessageHtml}</div>`;
    }

    html += '</div>';
    return html;
  });

  const fullHtml = htmlParts.join('\n');

  return res.json({
    html: fullHtml,
    count: customerModals.length,
    modals: customerModals.map((m: IModalDocument) => ({
      id: m.id,
      title: m.title,
      subtitle: m.subtitle,
      createdAt: m.createdAt,
    })),
  });
});

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
