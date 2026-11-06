import { describe, expect, it } from 'vitest';
import {
  CreateAdminSavedViewRequestSchema,
  UpdateAdminSavedViewRequestSchema,
  parseSavedView,
} from './adminSavedViews';

const PARAMS = { sortField: 'name', sortOrder: 'asc', limit: 50, status: 'suspended', tags: ['Beta'] };

describe('parseSavedView', () => {
  it('reads a version 1 users view', () => {
    expect(parseSavedView('users', { version: 1, params: PARAMS })).toEqual({
      ok: true,
      view: { version: 1, params: PARAMS },
    });
  });

  it('skips, never throws on, an unknown version or a malformed payload', () => {
    expect(parseSavedView('users', { version: 2, params: PARAMS })).toEqual({
      ok: false,
      reason: 'unknown-version',
      version: 2,
    });
    expect(parseSavedView('users', null)).toMatchObject({ ok: false, reason: 'unknown-version' });
    expect(parseSavedView('users', 'garbage')).toMatchObject({ ok: false, reason: 'unknown-version' });
    expect(parseSavedView('users', { version: 1, params: { ...PARAMS, limit: 7 } })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parseSavedView('users', { version: 1, params: { ...PARAMS, status: 'gone' } })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('drops keys the version does not define', () => {
    const parsed = parseSavedView('users', { version: 1, params: { ...PARAMS, columns: ['email'] } });
    expect(parsed.ok && parsed.view.params).toEqual(PARAMS);
  });
});

describe('request schemas', () => {
  it('trims and bounds the name and defaults to personal', () => {
    const parsed = CreateAdminSavedViewRequestSchema.parse({
      surface: 'users',
      name: '  Suspended  ',
      view: { version: 1, params: PARAMS },
    });
    expect(parsed).toMatchObject({ name: 'Suspended', shared: false });
    for (const name of ['   ', 'x'.repeat(61)]) {
      expect(
        CreateAdminSavedViewRequestSchema.safeParse({ surface: 'users', name, view: { version: 1, params: PARAMS } })
          .success
      ).toBe(false);
    }
  });

  it('needs at least one field to update and refuses others', () => {
    expect(UpdateAdminSavedViewRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateAdminSavedViewRequestSchema.safeParse({ ownerId: 'x' }).success).toBe(false);
    expect(UpdateAdminSavedViewRequestSchema.parse({ shared: true })).toEqual({ shared: true });
  });
});
