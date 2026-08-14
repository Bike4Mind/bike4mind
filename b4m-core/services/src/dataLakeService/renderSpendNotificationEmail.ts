import type {
  DataLakeSpendNotificationDetail,
  DataLakeSpendNotificationKind,
  DataLakeSpendNotificationScope,
} from '@bike4mind/common';

/**
 * Minimal HTML escaper for the values interpolated below (a lake name is user-supplied and
 * lands directly in an HTML email body). Local rather than reusing the app-layer escaper
 * (viewerSecurity.ts) - this module lives in b4m-core/services, which cannot import
 * apps/client code.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Integer micro-USD -> a human dollar figure, one shared formatter so no call site divides ad hoc. */
export function formatMicroUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 4 : 2)}`;
}

export interface SpendNotificationEmailInput {
  kind: DataLakeSpendNotificationKind;
  scope: DataLakeSpendNotificationScope;
  lakeName: string;
  detail: DataLakeSpendNotificationDetail;
}

export interface SpendNotificationEmailContent {
  subject: string;
  html: string;
}

const FOOTER =
  '<p style="color:#666;font-size:12px">You are receiving this because you own or administer this data lake.</p>';

function wrap(lakeNameEscaped: string, bodyHtml: string): string {
  return `<div><p><strong>${lakeNameEscaped}</strong></p>${bodyHtml}${FOOTER}</div>`;
}

/**
 * Render the subject/body for one spend notification. Pure - no I/O, no db/mailer access -
 * so every kind/scope combination is unit-testable in isolation. Never includes chunk/file/
 * query text: only names, ids, and dollar amounts, mirroring the audit-trail rule
 * LakeAccessEventModel already enforces.
 */
export function renderSpendNotificationEmail(input: SpendNotificationEmailInput): SpendNotificationEmailContent {
  const { kind, scope, detail } = input;
  const lake = escapeHtml(input.lakeName);
  const reason = detail.reason ? escapeHtml(detail.reason) : undefined;
  const budget = detail.budgetMicroUsd !== undefined ? formatMicroUsd(detail.budgetMicroUsd) : undefined;
  const spent = detail.spentMicroUsd !== undefined ? formatMicroUsd(detail.spentMicroUsd) : undefined;
  const pct =
    detail.spentMicroUsd !== undefined && detail.budgetMicroUsd
      ? Math.round((detail.spentMicroUsd / detail.budgetMicroUsd) * 100)
      : undefined;
  const windowEndsAt = detail.windowEndsAt ? detail.windowEndsAt.toISOString() : undefined;

  if (kind === 'stopped' && scope === 'switch') {
    return {
      subject: `Indexing paused for "${input.lakeName}" - embedding spend is switched off`,
      html: wrap(
        lake,
        `<p>A platform admin turned embedding spend off for this data lake. Nothing was lost: queued ` +
          `files failed and can be re-indexed once it is back on. No action is available to you.</p>`
      ),
    };
  }

  if (kind === 'stopped' && scope === 'rate') {
    return {
      subject: `Indexing paused for "${input.lakeName}" - the embedding rate limit is set to 0`,
      html: wrap(
        lake,
        `<p>A platform admin set the embedding rate limit to 0, which stops all indexing. ` +
          (reason ? `<p>${reason}</p>` : '') +
          `No action is available to you.</p>`
      ),
    };
  }

  if (kind === 'budget_exhausted' && scope === 'lake') {
    return {
      subject: `"${input.lakeName}" has reached its embedding budget`,
      html: wrap(
        lake,
        `<p>"${lake}" has spent ${spent ?? 'its'} of the ${budget ?? ''} per-lake embedding budget. ` +
          `New files will not be indexed until an admin raises the per-lake budget or resets this lake's meter.</p>`
      ),
    };
  }

  if (kind === 'budget_exhausted' && scope === 'run') {
    return {
      subject: `Upload to "${input.lakeName}" hit the per-run embedding budget`,
      html: wrap(
        lake,
        `<p>This upload batch stopped at ${budget ?? 'its per-run budget'}. Split the upload or ask an admin ` +
          `to raise the per-run budget, then re-index the failed files.</p>`
      ),
    };
  }

  if (kind === 'budget_exhausted' && scope === 'period') {
    return {
      subject: `Platform embedding budget exhausted - "${input.lakeName}" indexing paused`,
      html: wrap(
        lake,
        `<p>The platform-wide embedding budget (${budget ?? ''}${detail.periodHours ? ` per ${detail.periodHours}h` : ''}) ` +
          `is exhausted. This resumes automatically${windowEndsAt ? ` at ${windowEndsAt}` : ''} - re-index then.</p>`
      ),
    };
  }

  if (kind === 'throttled' && scope === 'rate') {
    return {
      subject: `Indexing for "${input.lakeName}" is being throttled`,
      html: wrap(
        lake,
        `<p>The embedding rate limit is saturated; work retries automatically and no action is needed ` +
          `unless it persists.</p>`
      ),
    };
  }

  if (kind === 'approaching_cap' && scope === 'lake') {
    return {
      subject: `"${input.lakeName}" has used ${pct ?? 80}% of its embedding budget`,
      html: wrap(
        lake,
        `<p>${spent ?? ''} of ${budget ?? ''} (${pct ?? 80}%) has been spent. At 100% indexing stops until a ` +
          `lever changes.</p>`
      ),
    };
  }

  // approaching_cap / period
  return {
    subject: `Platform embedding budget is ${pct ?? 80}% used`,
    html: wrap(
      lake,
      `<p>${spent ?? ''} of ${budget ?? ''} for the current${detail.periodHours ? ` ${detail.periodHours}h` : ''} ` +
        `window has been spent${windowEndsAt ? `, ending ${windowEndsAt}` : ''}.</p>`
    ),
  };
}
