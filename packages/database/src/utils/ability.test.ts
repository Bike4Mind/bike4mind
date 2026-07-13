import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// The ability builder pulls in the Mongoose models purely as CASL subject types;
// stub them so this stays a pure permission-rule unit test (no DB).
vi.mock('../models', () => ({
  Session: class Session {},
  User: class User {},
  FabFile: class FabFile {},
  Organization: class Organization {},
  AdminSettings: class AdminSettings {},
  ModalModel: class ModalModel {},
  CounterLog: class CounterLog {},
  FeedbackModel: class FeedbackModel {},
  Invite: class Invite {},
  Prompt: class Prompt {},
  UserActivityCounter: class UserActivityCounter {},
}));

import { defineAbilitiesFor } from './ability';
import { Prompt } from '../models';

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({ id: 'u1', isAdmin: false, tags: [], groups: [], email: 'user@example.com', ...overrides }) as IUserDocument;

// Mirrors the HTTP ability (apps/client/server/auth/ability.ts) - both must gate
// Prompt writes on admin-or-developer and stay in sync (the two definitions
// diverging on the retired 'Analyst' tag is exactly what this guards against).
describe('db-core defineAbilitiesFor - Prompt library', () => {
  it('lets any authenticated user read Prompts', () => {
    expect(defineAbilitiesFor(makeUser()).can('read', Prompt)).toBe(true);
  });

  it('lets an admin create/update/delete Prompts', () => {
    const a = defineAbilitiesFor(makeUser({ isAdmin: true }));
    expect(a.can('create', Prompt)).toBe(true);
    expect(a.can('update', Prompt)).toBe(true);
    expect(a.can('delete', Prompt)).toBe(true);
  });

  it('lets a developer-tagged user create/update/delete Prompts (case-insensitive per hasDeveloperUserTag)', () => {
    expect(defineAbilitiesFor(makeUser({ tags: ['Developer'] })).can('create', Prompt)).toBe(true);
    expect(defineAbilitiesFor(makeUser({ tags: ['developer'] })).can('delete', Prompt)).toBe(true);
  });

  it('denies a plain user Prompt writes', () => {
    const a = defineAbilitiesFor(makeUser({ tags: ['Customer'] }));
    expect(a.can('create', Prompt)).toBe(false);
    expect(a.can('update', Prompt)).toBe(false);
    expect(a.can('delete', Prompt)).toBe(false);
  });

  it('no longer grants Prompt writes on the retired "Analyst" tag alone', () => {
    const a = defineAbilitiesFor(makeUser({ tags: ['Analyst'] }));
    expect(a.can('create', Prompt)).toBe(false);
    expect(a.can('update', Prompt)).toBe(false);
    expect(a.can('delete', Prompt)).toBe(false);
  });

  it('grants nothing to an undefined user', () => {
    expect(defineAbilitiesFor(undefined).can('read', Prompt)).toBe(false);
  });
});
