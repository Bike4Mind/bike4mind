import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({
  AdminSettings: class AdminSettings {},
  CounterLog: class CounterLog {},
  Session: class Session {
    static find() {
      return { select: () => [] };
    }
  },
  User: class User {},
  Invite: class Invite {},
  Prompt: class Prompt {},
  UserActivityCounter: class UserActivityCounter {},
  FeedbackModel: class FeedbackModel {},
  ModalModel: class ModalModel {},
  Organization: class Organization {},
  FabFile: class FabFile {},
  Memento: class Memento {},
  Project: class Project {},
  QuestMasterPlan: class QuestMasterPlan {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  SecretRotation: class SecretRotation {},
}));

vi.mock('@server/models/Subscription', () => ({
  Subscription: class Subscription {},
}));

import defineAbilitiesFor from '../ability';
import { Prompt } from '@bike4mind/database';

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({
    id: 'u1',
    isAdmin: false,
    tags: [],
    groups: [],
    email: 'user@example.com',
    ...overrides,
  }) as IUserDocument;

describe('defineAbilitiesFor - Prompt library permissions', () => {
  it('everyone (any authenticated user) can read Prompts', () => {
    const ability = defineAbilitiesFor(makeUser());
    expect(ability.can('read', Prompt)).toBe(true);
  });

  it('an admin can create/update/delete Prompts', () => {
    const ability = defineAbilitiesFor(makeUser({ isAdmin: true }));
    expect(ability.can('create', Prompt)).toBe(true);
    expect(ability.can('update', Prompt)).toBe(true);
    expect(ability.can('delete', Prompt)).toBe(true);
  });

  it('a developer-tagged user can create/update/delete Prompts', () => {
    const ability = defineAbilitiesFor(makeUser({ tags: ['Developer'] }));
    expect(ability.can('create', Prompt)).toBe(true);
    expect(ability.can('update', Prompt)).toBe(true);
    expect(ability.can('delete', Prompt)).toBe(true);
  });

  it('matches the developer tag case-insensitively, mirroring hasDeveloperUserTag', () => {
    const ability = defineAbilitiesFor(makeUser({ tags: ['developer'] }));
    expect(ability.can('delete', Prompt)).toBe(true);
  });

  it('a plain user (neither admin nor developer) cannot create/update/delete Prompts', () => {
    const ability = defineAbilitiesFor(makeUser({ tags: ['Customer'] }));
    expect(ability.can('create', Prompt)).toBe(false);
    expect(ability.can('update', Prompt)).toBe(false);
    expect(ability.can('delete', Prompt)).toBe(false);
  });

  it('the literal "Analyst" tag alone (no admin, no developer) no longer grants Prompt write access', () => {
    // The gate used to be Analyst-tag-only, with no admin fallback - replaced
    // with admin-or-developer (2026-07-08). A lone Analyst tag is not developer.
    const ability = defineAbilitiesFor(makeUser({ tags: ['Analyst'] }));
    expect(ability.can('create', Prompt)).toBe(false);
    expect(ability.can('update', Prompt)).toBe(false);
    expect(ability.can('delete', Prompt)).toBe(false);
  });

  it('undefined user gets no abilities at all', () => {
    const ability = defineAbilitiesFor(undefined);
    expect(ability.can('read', Prompt)).toBe(false);
    expect(ability.can('create', Prompt)).toBe(false);
  });
});
