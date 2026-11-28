import { describe, expect, it } from 'vitest';
import { attachmentMethods } from './attachments';
import { hostMethodRequirements, hostServesMethod } from './methodRequirements';
import { sessionSettingsMethods, turnRevisionMethods } from './sessionSettings';
import { KNOWN_HOST_CAPABILITIES } from './version';

describe('hostMethodRequirements', () => {
  it('gates every method added in 1.4 behind a capability the protocol knows', () => {
    expect(Object.keys(hostMethodRequirements).sort()).toEqual(
      Object.keys({ ...attachmentMethods, ...sessionSettingsMethods, ...turnRevisionMethods }).sort()
    );
    for (const { capability } of Object.values(hostMethodRequirements)) {
      expect(KNOWN_HOST_CAPABILITIES).toContain(capability);
    }
  });

  it('serves a method only with its capability and at its minor', () => {
    const capabilities = ['attachments'];
    expect(hostServesMethod('attachment/uploadBegin', { capabilities, agreedMinor: 4 })).toBe(true);
    expect(hostServesMethod('attachment/uploadBegin', { capabilities, agreedMinor: 3 })).toBe(false);
    expect(hostServesMethod('turn/edit', { capabilities, agreedMinor: 4 })).toBe(false);
  });
});
