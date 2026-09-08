import type { LakeAccessView } from '@bike4mind/common';
import { describeLakeAccessChannel, lakeAccessChannelsComposeConjunctively } from '@bike4mind/common';
import { escapeCsvCell } from '@client/app/utils/csv';

/**
 * Render one CSV row. Every field is escaped via the shared `escapeCsvCell`, which quotes the cell
 * AND defuses spreadsheet formula injection (a leading =,+,-,@,tab in a user-controlled name or org
 * name would otherwise execute on open). This is a compliance artifact carrying user-supplied text,
 * so it must not be the one CSV surface in the repo that skips that guard.
 */
const row = (fields: (string | number | null | undefined)[]): string => fields.map(escapeCsvCell).join(',');

const iso = (d: Date | null | undefined): string => (d ? new Date(d).toISOString() : '');

/**
 * Render an assembled access view as a sectioned CSV compliance artifact - a metadata block plus
 * four labeled blocks (members & grants, access channels, candidate-cap pressure, access history)
 * in one downloadable file.
 * Sectioned rather than one wide sparse table because the audience is human compliance review in a
 * spreadsheet; each block keeps its own header so every column is meaningful. A blank line separates
 * blocks. Static section labels are raw `#` comments; every value that could carry user input goes
 * through an escaped field (never an interpolated comment), so a lake name with a newline or comma
 * cannot inject or corrupt rows.
 *
 * Pure and deterministic (input order is already stabilized by the assembler), so it is unit-tested
 * directly and the route just streams the string.
 */
export function lakeAccessViewToCsv(view: LakeAccessView): string {
  const lines: string[] = [];

  lines.push('# Data lake access view');
  lines.push(row(['lakeName', view.lakeName]));
  lines.push(row(['lakeId', view.lakeId]));
  lines.push(row(['generatedAt', iso(view.generatedAt)]));
  if (view.historyTruncated) {
    lines.push(row(['historyNote', 'access history truncated to the most recent window; not the full trail']));
    if (view.windowStartsAt) {
      // The per-row readCount/firstAccessedAt below cover only reads at or after this instant.
      lines.push(row(['historyWindowStartsAt', iso(view.windowStartsAt)]));
    }
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
  if (lakeAccessChannelsComposeConjunctively(view.channels)) {
    // These channels are not independent read paths: org membership is a prerequisite and a
    // tag/entitlement narrows it further, so effective access is their intersection and a holderCount
    // is an upper bound on that one channel. Mirrors the gate (assertLakeAccess).
    lines.push(
      '# NOTE: channels compose conjunctively - effective access is their intersection, not the sum; a holderCount bounds one channel only'
    );
  }
  // `description` carries the SAME text the access modal renders for the row (via the shared
  // describer), so a reader holding the export beside the screen sees them agree. The columns before
  // it stay machine-readable: `label` is only a resolved name (an org's), blank where none resolves.
  lines.push(row(['kind', 'value', 'label', 'holderCount', 'description']));
  for (const c of view.channels) {
    // holderCount is left blank (not 0) when uncounted - a tag/entitlement channel is never scanned.
    lines.push(row([c.kind, c.value, c.label, c.holderCount ?? '', describeLakeAccessChannel(c)]));
  }
  lines.push('');

  lines.push('# Candidate-cap pressure (turns that read this lake and hit the forced-retrieval candidate cap)');
  // Exported even at zero, with the reason: a section that vanished when nothing was reported would
  // be indistinguishable from a lake whose reads all had full candidate coverage.
  lines.push(
    '# NOTE: turnsWithSignal counts reads whose surface reports this at all - turnsWithSignal 0 means not reported, which is not the same as no read hitting the cap'
  );
  lines.push(
    '# NOTE: attribution is approximate - the cap applies to the whole candidate listing for a turn, across every source that turn could read; read this as turns that read this lake hit the cap, not as this lake causing it'
  );
  if (view.historyTruncated) {
    lines.push('# NOTE: these counts cover only the truncated window above, not all time');
  }
  lines.push(row(['turnsWithSignal', 'turnsAtCap', 'lastAtCapAt']));
  lines.push(
    row([
      view.candidateCapPressure.turnsWithSignal,
      view.candidateCapPressure.turnsAtCap,
      iso(view.candidateCapPressure.lastAtCapAt),
    ])
  );
  lines.push('');

  lines.push('# Access history (who actually read the lake)');
  // Unconditional, exported populated or empty: only instrumented retrieval surfaces emit events and
  // events age out on their retention TTL, so this section is a lower bound. Without the note an
  // empty section reads as "nobody touched it" - a claim this file cannot support.
  lines.push(
    '# NOTE: covers reads through instrumented retrieval surfaces within the audit retention window - a lower bound; an empty section is not proof that no one read this lake'
  );
  if (view.historyTruncated) {
    // readCount/firstAccessedAt are window-scoped when truncated - label them so, never as all-time.
    lines.push('# NOTE: readCount and firstAccessedAt below cover only the truncated window above, not all time');
  }
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
