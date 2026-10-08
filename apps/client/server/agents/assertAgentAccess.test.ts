import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { assertAgentAccess } from './assertAgentAccess';

const agent = { userId: 'owner', users: [{ userId: 'viewer' }] };

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('assertAgentAccess', () => {
  it('throws NotFoundError for a missing agent', () => {
    expect(() => assertAgentAccess(null, 'owner', 'view')).toThrow(NotFoundError);
    expect(() => assertAgentAccess(undefined, 'owner', 'own')).toThrow(NotFoundError);
  });

  it.each(['view', 'own'] as const)(
    'hides an existing agent from a stranger (%s) behind the same error as a missing one',
    access => {
      const missing = thrownBy(() => assertAgentAccess(null, 'stranger', access));
      const stranger = thrownBy(() => assertAgentAccess(agent, 'stranger', access));

      expect(stranger).toBeInstanceOf(NotFoundError);
      expect((stranger as Error).message).toBe((missing as Error).message);
    }
  );

  it('lets a shared viewer view but not own', () => {
    expect(() => assertAgentAccess(agent, 'viewer', 'view')).not.toThrow();
    expect(() => assertAgentAccess(agent, 'viewer', 'own')).toThrow(ForbiddenError);
  });

  it('uses the caller-provided message for the shared-viewer 403', () => {
    expect(() => assertAgentAccess(agent, 'viewer', 'own', 'nope')).toThrow('nope');
  });

  it('lets the owner do both', () => {
    expect(() => assertAgentAccess(agent, 'owner', 'view')).not.toThrow();
    expect(() => assertAgentAccess(agent, 'owner', 'own')).not.toThrow();
  });

  it('treats an ownerless agent with no shares as hidden', () => {
    expect(() => assertAgentAccess({ userId: undefined }, 'stranger', 'view')).toThrow(NotFoundError);
  });
});
