import { describe, expect, it } from 'vitest';
import {
  CreateProjectInviteRequestSchema,
  MAX_PROJECT_INVITE_MESSAGE_LENGTH,
  MAX_PROJECT_INVITE_RECIPIENTS,
} from './projectSharingPublic';

const recipients = (count: number) => Array.from({ length: count }, (_, index) => `person-${index}@example.com`);

describe('CreateProjectInviteRequestSchema', () => {
  it.each([undefined, [], ['']])('requires at least one non-empty recipient (%j)', recipientList => {
    expect(
      CreateProjectInviteRequestSchema.safeParse({ permissions: ['read'], recipients: recipientList }).success
    ).toBe(false);
  });

  it.each([1, MAX_PROJECT_INVITE_RECIPIENTS])('accepts %i named recipients', count => {
    expect(
      CreateProjectInviteRequestSchema.safeParse({ permissions: ['read'], recipients: recipients(count) }).success
    ).toBe(true);
  });

  it('rejects more recipients than the shared limit', () => {
    expect(
      CreateProjectInviteRequestSchema.safeParse({
        permissions: ['read'],
        recipients: recipients(MAX_PROJECT_INVITE_RECIPIENTS + 1),
      }).success
    ).toBe(false);
  });

  it('accepts the shared message limit and rejects longer messages', () => {
    const input = { permissions: ['read'], recipients: recipients(1) };
    expect(
      CreateProjectInviteRequestSchema.safeParse({
        ...input,
        description: 'a'.repeat(MAX_PROJECT_INVITE_MESSAGE_LENGTH),
      }).success
    ).toBe(true);
    expect(
      CreateProjectInviteRequestSchema.safeParse({
        ...input,
        description: 'a'.repeat(MAX_PROJECT_INVITE_MESSAGE_LENGTH + 1),
      }).success
    ).toBe(false);
  });
});
