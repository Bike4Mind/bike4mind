import { describe, it, expect } from 'vitest';
import { resolveVisibility } from './resolveVisibility';

describe('resolveVisibility', () => {
  it('returns the per-tier default when no override is requested', () => {
    expect(resolveVisibility('user', undefined)).toEqual({ ok: true, visibility: 'private' });
    expect(resolveVisibility('project', undefined)).toEqual({ ok: true, visibility: 'project' });
    expect(resolveVisibility('organization', undefined)).toEqual({ ok: true, visibility: 'organization' });
  });

  it('allows an override that is in the tier allowlist', () => {
    expect(resolveVisibility('user', 'public')).toEqual({ ok: true, visibility: 'public' });
    expect(resolveVisibility('user', 'organization')).toEqual({ ok: true, visibility: 'organization' });
    expect(resolveVisibility('project', 'public')).toEqual({ ok: true, visibility: 'public' });
    expect(resolveVisibility('organization', 'public')).toEqual({ ok: true, visibility: 'public' });
  });

  it('rejects an override not allowed for the tier', () => {
    // user tier cannot go to 'project'
    const r1 = resolveVisibility('user', 'project');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('invalid_override');

    // organization tier cannot go down to 'private' or 'project'
    expect(resolveVisibility('organization', 'private').ok).toBe(false);
    expect(resolveVisibility('organization', 'project').ok).toBe(false);

    // project tier cannot go down to 'private'
    expect(resolveVisibility('project', 'private').ok).toBe(false);
  });
});
