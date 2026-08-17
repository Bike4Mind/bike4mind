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
  // Subject headers are not HTML (no escapeHtml needed), but a lake name is free-text up to 200
  // chars with no newline restriction - strip CR/LF locally rather than assume the mail
  // transport sanitizes header injection.
  const subjectName = input.lakeName.replace(/[\r\n]+/g, ' ');
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
      subject: `Indexing paused for "${subjectName}" - embedding spend is switched off`,
      html: wrap(
        lake,
        `<p>A platform admin turned embedding spend off for this data lake. Nothing was lost: queued ` +
          `files failed and can be re-indexed once it is back on. No action is available to you.</p>`
      ),
    };
  }

  if (kind === 'stopped' && scope === 'rate') {
    return {
      subject: `Indexing paused for "${subjectName}" - the embedding rate limit is set to 0`,
      html: wrap(
        lake,
        `<p>A platform admin set the embedding rate limit to 0, which stops all indexing. ` +
          (reason ? `${reason} ` : '') +
          `No action is available to you.</p>`
      ),
    };
  }

  if (kind === 'budget_exhausted' && scope === 'lake') {
    // This event's only producer (enforceEmbeddingSpendGate's denial branch) never supplies
    // spentMicroUsd - tryAddEmbeddingSpendMetered returns spendMicroUsd: null on denial, since
    // there is no post-increment total to report when the reservation was refused. The copy
    // must read correctly with `spent` always absent, not reference it at all.
    return {
      subject: `"${subjectName}" has reached its embedding budget`,
      html: wrap(
        lake,
        `<p>"${lake}" has reached its per-lake embedding budget of ${budget ?? ''}. ` +
          `New files will not be indexed until an admin raises the per-lake budget or resets this lake's meter.</p>`
      ),
    };
  }

  if (kind === 'budget_exhausted' && scope === 'run') {
    return {
      subject: `Upload to "${subjectName}" hit the per-run embedding budget`,
      html: wrap(
        lake,
        `<p>This upload batch stopped at ${budget ?? 'its per-run budget'}. Split the upload or ask an admin ` +
          `to raise the per-run budget, then re-index the failed files.</p>`
      ),
    };
  }

  if (kind === 'budget_exhausted' && scope === 'period') {
    // Period scope is platform-wide, shared across every tenant lake - recipients here are
    // lake owners/org admins, not platform admins, so the dollar figure is never shown (it
    // would disclose the platform's aggregate spend/budget to every affected lake's owner).
    return {
      subject: `Platform embedding budget exhausted - "${subjectName}" indexing paused`,
      html: wrap(
        lake,
        `<p>Indexing is paused platform-wide because the shared embedding budget is exhausted. ` +
          `This resumes automatically${windowEndsAt ? ` at ${windowEndsAt}` : ''} - re-index then.</p>`
      ),
    };
  }

  if (kind === 'throttled' && scope === 'rate') {
    return {
      subject: `Indexing for "${subjectName}" is being throttled`,
      html: wrap(
        lake,
        `<p>The embedding rate limit is saturated; work retries automatically and no action is needed ` +
          `unless it persists.</p>`
      ),
    };
  }

  if (kind === 'approaching_cap' && scope === 'lake') {
    return {
      subject: `"${subjectName}" has used ${pct ?? 80}% of its embedding budget`,
      html: wrap(
        lake,
        `<p>${spent ?? ''} of ${budget ?? ''} (${pct ?? 80}%) has been spent. At 100% indexing stops until a ` +
          `lever changes.</p>`
      ),
    };
  }

  if (kind === 'approaching_cap' && scope === 'period') {
    // RESERVED, not dead: enforceEmbeddingSpendGate deliberately never fires this pair (a
    // single global counter means the crossing test is true for exactly one arbitrary tenant
    // platform-wide, never a platform admin - see that file's own comment at the end of the
    // gate function). Kept here rather than removed in case a future version routes this to
    // platform admins instead, which would reuse this exact rendering.
    // Same disclosure concern as budget_exhausted/period above: no dollar or percentage
    // figures, since this is the platform-wide aggregate, not this lake's own spend.
    return {
      subject: `Indexing is approaching the platform embedding budget`,
      html: wrap(
        lake,
        `<p>Indexing is approaching the platform-wide embedding budget for the current` +
          `${detail.periodHours ? ` ${detail.periodHours}h` : ''} window` +
          `${windowEndsAt ? `, ending ${windowEndsAt}` : ''}. It may pause automatically if the budget is reached.</p>`
      ),
    };
  }

  // Every valid kind/scope pair is handled explicitly above; reaching here means a new
  // pairing was introduced without updating this renderer, which would otherwise silently
  // fall through to whichever branch happened to be last.
  throw new Error(`renderSpendNotificationEmail: unhandled kind/scope pair "${kind}"/"${scope}"`);
}
