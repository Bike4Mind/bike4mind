import { describe, expect, it } from 'vitest';
import { HOST_PROTOCOL_VERSION, hasHostCapability, negotiateHostProtocol } from './version';

describe('negotiateHostProtocol', () => {
  it('agrees on equal versions', () => {
    expect(negotiateHostProtocol({ major: 1, minor: 2 }, { major: 1, minor: 2 })).toEqual({ ok: true, minor: 2 });
  });

  it('settles on the client minor when the client is older', () => {
    expect(negotiateHostProtocol({ major: 1, minor: 1 }, { major: 1, minor: 4 })).toEqual({ ok: true, minor: 1 });
  });

  it('settles on the host minor when the host is older', () => {
    expect(negotiateHostProtocol({ major: 1, minor: 5 }, { major: 1, minor: 2 })).toEqual({ ok: true, minor: 2 });
  });

  it('reports an older client major', () => {
    expect(negotiateHostProtocol({ major: 1, minor: 9 }, { major: 2, minor: 0 })).toEqual({
      ok: false,
      reason: 'client-too-old',
    });
  });

  it('reports an older host major', () => {
    expect(negotiateHostProtocol({ major: 2, minor: 0 }, { major: 1, minor: 9 })).toEqual({
      ok: false,
      reason: 'host-too-old',
    });
  });

  it('negotiates with itself', () => {
    expect(negotiateHostProtocol(HOST_PROTOCOL_VERSION, HOST_PROTOCOL_VERSION).ok).toBe(true);
  });
});

describe('hasHostCapability', () => {
  it('finds an advertised capability and ignores names this client does not know', () => {
    const advertised = ['queue', 'holograms', 'loops'];
    expect(hasHostCapability(advertised, 'queue')).toBe(true);
    expect(hasHostCapability(advertised, 'loops')).toBe(true);
    expect(hasHostCapability(advertised, 'terminals')).toBe(false);
  });
});
