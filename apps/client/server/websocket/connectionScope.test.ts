import { describe, expect, it } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { connectionHoldsScope } from './connectionScope';

describe('connectionHoldsScope', () => {
  it('passes a JWT socket, which records no scopes at all', () => {
    expect(connectionHoldsScope({}, [ApiKeyScope.AI_CHAT])).toBe(true);
    expect(connectionHoldsScope({ scopes: undefined }, [ApiKeyScope.AI_CHAT])).toBe(true);
    // Mongoose materialises an unset array path as [], so absent and empty must behave alike.
    expect(connectionHoldsScope({ scopes: [] }, [ApiKeyScope.AI_CHAT])).toBe(true);
  });

  it('refuses a bridge-only key for an action it was not minted for', () => {
    // The whole point: $connect admits cc-bridge:connect, so this socket exists and is
    // authenticated - it just has no authority over voice billing or notebook state.
    expect(connectionHoldsScope({ scopes: [ApiKeyScope.CC_BRIDGE] }, [ApiKeyScope.AI_CHAT])).toBe(false);
    expect(connectionHoldsScope({ scopes: [ApiKeyScope.CC_BRIDGE] }, [ApiKeyScope.WRITE_NOTEBOOKS])).toBe(false);
  });

  it('passes a key holding any one of the required scopes', () => {
    expect(connectionHoldsScope({ scopes: [ApiKeyScope.AI_CHAT] }, [ApiKeyScope.AI_CHAT])).toBe(true);
    expect(
      connectionHoldsScope({ scopes: [ApiKeyScope.CC_BRIDGE, ApiKeyScope.AI_CHAT] }, [
        ApiKeyScope.AI_GENERATE,
        ApiKeyScope.AI_CHAT,
      ])
    ).toBe(true);
  });

  it('does not treat admin:* as a wildcard', () => {
    // decideScopeGate uses a plain `includes`, and this gate must not be more permissive than it.
    expect(connectionHoldsScope({ scopes: [ApiKeyScope.ADMIN] }, [ApiKeyScope.AI_CHAT])).toBe(false);
  });

  it("says nothing about a missing connection - that is the caller's check", () => {
    // Every caller rejects an unknown connectionId before reaching this gate; the null tolerance
    // exists so a future caller cannot crash here, NOT so a missing row can authorize anything.
    expect(connectionHoldsScope(null, [ApiKeyScope.AI_CHAT])).toBe(true);
  });
});
