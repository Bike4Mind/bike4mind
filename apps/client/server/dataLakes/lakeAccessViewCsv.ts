import type { LakeAccessView } from '@bike4mind/common';

/**
 * RFC-4180 field escaping: quote a field that contains a comma, quote, CR or LF, and double any
 * embedded quote. Everything else passes through unquoted. Null/undefined -> empty field.
 */
const csvField = (value: string | number | null | undefined): string => {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const row = (fields: (string | number | null | undefined)[]): string => fields.map(csvField).join(',');

const iso = (d: Date | null | undefined): string => (d ? new Date(d).toISOString() : '');

/**
 * Render an assembled access view as a sectioned CSV compliance artifact - three labeled blocks
 * (members & grants, access channels, access history) in one downloadable file. Sectioned rather
 * than one wide sparse table because the audience is human compliance review in a spreadsheet;
 * each block keeps its own header so every column is meaningful. A blank line separates blocks.
 *
 * Pure and deterministic (input order is already stabilized by the assembler), so it is unit-tested
 * directly and the route just streams the string.
 */
export function lakeAccessViewToCsv(view: LakeAccessView): string {
  const lines: string[] = [];

  lines.push(`# Data lake access view: ${view.lakeName} (${view.lakeId})`);
  lines.push(`# Generated at ${iso(view.generatedAt)}`);
  if (view.historyTruncated) {
    lines.push(`# NOTE: access history was truncated to the most recent window; this is not the full trail.`);
  }
  lines.push('');

  lines.push('# Members and grants');
  lines.push(
    row([
      'principalType',
      'principalId',
      'principalName',
      'role',
      'status',
      'grantedByUserId',
      'grantedByName',
      'grantedAt',
      'expiresAt',
    ])
  );
  for (const g of view.grants) {
    lines.push(
      row([
        g.principalType,
        g.principalId,
        g.principalName,
        g.role,
        g.status,
        g.grantedByUserId,
        g.grantedByName,
        iso(g.grantedAt),
        iso(g.expiresAt),
      ])
    );
  }
  lines.push('');

  lines.push('# Access channels (gate-based read paths, resolved live)');
  lines.push(row(['kind', 'value', 'label', 'holderCount']));
  for (const c of view.channels) {
    // holderCount is left blank (not 0) when uncounted - a tag/entitlement channel is never scanned.
    lines.push(row([c.kind, c.value, c.label, c.holderCount ?? '']));
  }
  lines.push('');

  lines.push('# Access history (who actually read the lake)');
  lines.push(
    row([
      'principalKind',
      'principalId',
      'principalName',
      'onBehalfOfUserId',
      'onBehalfOfName',
      'readCount',
      'firstAccessedAt',
      'lastAccessedAt',
      'surfaces',
    ])
  );
  for (const h of view.history) {
    lines.push(
      row([
        h.principalKind,
        h.principalId,
        h.principalName,
        h.onBehalfOfUserId,
        h.onBehalfOfName,
        h.readCount,
        iso(h.firstAccessedAt),
        iso(h.lastAccessedAt),
        h.surfaces.join(';'),
      ])
    );
  }

  return lines.join('\r\n');
}

/** A filesystem-safe export filename for a lake's access view, stamped with the lake id. */
export function lakeAccessViewCsvFilename(view: Pick<LakeAccessView, 'lakeId'>): string {
  return `lake-access-${view.lakeId}.csv`;
}
