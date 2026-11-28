import type { ChatImportOrigin } from '@shared/claudeImport';
import { describe, expect, it } from 'vitest';
import { importedBadgeLabel } from './ImportedBadge';

const origin = (kind: ChatImportOrigin['kind'], forkedAt?: string): ChatImportOrigin => ({
  kind,
  sourceId: 's',
  importedAt: '',
  sourceUpdatedAt: '',
  ...(forkedAt ? { forkedAt } : {}),
});

describe('importedBadgeLabel', () => {
  it('reads as synced for a web chat, which sending here keeps in sync', () => {
    expect(importedBadgeLabel(origin('b4m-web'))).toBe('Synced with web');
    expect(importedBadgeLabel(origin('b4m-web', '2026-01-01'))).not.toContain('Continued here');
  });

  it('keeps the Claude Code and Claude copy', () => {
    expect(importedBadgeLabel(origin('claude-code'))).toBe(
      'Imported from Claude Code. Kept in sync until you continue it here.'
    );
    expect(importedBadgeLabel(origin('claude-code', '2026-01-01'))).toBe(
      'Imported from Claude Code. Continued here, so it no longer syncs.'
    );
    expect(importedBadgeLabel(origin('claude-chat'))).toBe('Imported from Claude.');
  });
});
