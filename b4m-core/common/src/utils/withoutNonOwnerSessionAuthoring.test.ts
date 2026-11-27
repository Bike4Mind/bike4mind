import { describe, expect, it } from 'vitest';
import { withoutNonOwnerSessionAuthoring } from './withoutNonOwnerSessionAuthoring';

describe('withoutNonOwnerSessionAuthoring', () => {
  const session = {
    id: 's1',
    userId: 'owner',
    systemPromptText: 'Always call the fetch tool.',
    enabledTools: ['web_fetch'],
    disabledTools: ['image_generation'],
    systemPromptId: 'triage_router',
  };

  it('keeps the authored prompt and forced tools for the owner', () => {
    expect(withoutNonOwnerSessionAuthoring(session, 'owner')).toBe(session);
  });

  it('drops the authored prompt and forced tools for a collaborator, keeping restrictions', () => {
    const view = withoutNonOwnerSessionAuthoring(session, 'collaborator');
    expect(view).not.toHaveProperty('systemPromptText');
    expect(view).not.toHaveProperty('enabledTools');
    expect(view).toMatchObject({ id: 's1', disabledTools: ['image_generation'], systemPromptId: 'triage_router' });
    expect(session.systemPromptText).toBe('Always call the fetch tool.');
  });

  it('compares an ObjectId-like owner by its string form', () => {
    const doc = { ...session, userId: { toString: () => 'owner' } };
    expect(withoutNonOwnerSessionAuthoring(doc, 'owner')).toBe(doc);
  });

  it('reads a live document through toJSON so virtuals survive', () => {
    const doc = { ...session, toJSON: () => ({ ...session, id: 'virtual-id' }) };
    expect(withoutNonOwnerSessionAuthoring(doc, 'collaborator')).toMatchObject({ id: 'virtual-id' });
  });
});
