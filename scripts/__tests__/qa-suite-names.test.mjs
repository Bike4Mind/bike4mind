import { describe, it, expect } from 'vitest';
import { suiteDisplayName } from '../qa-report.mjs';
// testGroups keeps its own copy of suiteDisplayName (the client cannot import the .mjs); this pins the two together.
import { testGroupName } from '../../apps/client/app/components/QaStatus/testGroups.ts';

const FILES = [
  'auth.spec.ts',
  'e2e/mfa-setup.spec.ts',
  'e2e/prompt_library.spec.ts',
  'e2e/mixed-dash_and_underscore.spec.ts',
  'e2e/e2e/double-prefix.spec.ts',
  'e2e/-leading-dash_.spec.ts',
  'no-extension',
  'notes.spec.tsx',
  'x.spec.ts.spec.ts',
  'AlreadyCapitalized.spec.ts',
  'lower-UPPER_Mixed.spec.ts',
  'e2e/nested/dir-name.spec.ts',
  'unicode-\u00fcber.spec.ts',
  '',
];

describe('suite display names', () => {
  it.each(FILES)('the client group name agrees with qa-report.mjs for %j', file => {
    expect(testGroupName(`${file} > Suite > test`)).toBe(suiteDisplayName(file));
  });

  it.each(['tenant-a', 'chromium', 'ml_team'])('the client prefixes label %j the way qa-report.mjs does', label => {
    const file = 'e2e/prompt_library.spec.ts';
    expect(testGroupName(`${label}::${file} > Suite > test`)).toBe(`${label} ${suiteDisplayName(file)}`);
  });
});
