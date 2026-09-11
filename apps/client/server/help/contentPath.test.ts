import { describe, it, expect } from 'vitest';
import { safeHelpContentPath } from './contentPath';

/**
 * This is the shared traversal guard for both server readers of the help content roots, so it is
 * pinned here directly rather than only through the route. `pages/api/help/content.ts` has its own
 * independent `isEscapingPath` check in front of it, which means a hole here would not show up in
 * that route's tests - but `server/help/retrieval.ts` has no such second layer.
 */
describe('safeHelpContentPath', () => {
  it('accepts a plain docs-root-relative path', () => {
    expect(safeHelpContentPath('admin/overview.md')).toBe('admin/overview.md');
    expect(safeHelpContentPath('admin/media/setup.gif')).toBe('admin/media/setup.gif');
  });

  it('normalises a redundant but safe path', () => {
    expect(safeHelpContentPath('./admin/overview.md')).toBe('admin/overview.md');
    expect(safeHelpContentPath('admin//overview.md')).toBe('admin/overview.md');
    // Descends and comes back, never leaving the root.
    expect(safeHelpContentPath('admin/media/../overview.md')).toBe('admin/overview.md');
  });

  it('rejects an absolute path', () => {
    // Unpinned, this is the hole: appended to a root it would be ignored by path.resolve, and a
    // prefix comparison against the root would still pass.
    expect(safeHelpContentPath('/etc/passwd')).toBeNull();
    expect(safeHelpContentPath('/app/apps/client/app/generated/help-index.json')).toBeNull();
  });

  it('rejects traversal out of the root', () => {
    expect(safeHelpContentPath('../generated/help-index.json')).toBeNull();
    expect(safeHelpContentPath('../../.env')).toBeNull();
    expect(safeHelpContentPath('..')).toBeNull();
  });

  it('rejects traversal that only escapes after normalisation', () => {
    // The reason the guard normalises first: this reaches outside the root while containing a
    // legitimate-looking leading segment.
    expect(safeHelpContentPath('admin/../../.env')).toBeNull();
    expect(safeHelpContentPath('admin/x/../../../secrets.md')).toBeNull();
  });

  it('rejects a backslash traversal attempt', () => {
    // On POSIX a backslash is an ordinary filename character, so this normalises to a single
    // segment beginning with `..` and is caught by the same check.
    expect(safeHelpContentPath('..\\..\\.env')).toBeNull();
  });

  it('rejects a NUL byte', () => {
    expect(safeHelpContentPath('admin/overview.md\0.png')).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(safeHelpContentPath('')).toBeNull();
  });

  it('never returns a value that escapes when appended to a root', () => {
    // The property the callers actually depend on, asserted over the whole shape space rather
    // than case by case: whatever comes back is relative and cannot climb out.
    const attempts = [
      'admin/overview.md',
      './admin/overview.md',
      'admin/media/../overview.md',
      '../escape.md',
      '/absolute.md',
      'admin/../../escape.md',
      '..\\..\\escape.md',
      '',
    ];
    for (const attempt of attempts) {
      const result = safeHelpContentPath(attempt);
      if (result === null) continue;
      expect(result.startsWith('/')).toBe(false);
      expect(result.startsWith('..')).toBe(false);
      expect(`/root/${result}`.includes('/../')).toBe(false);
    }
  });
});
