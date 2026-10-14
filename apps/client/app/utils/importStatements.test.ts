import { describe, expect, it } from 'vitest';
import { hasSingleLineImportFrom } from './importStatements';
import { replaceDirectTypeObjects } from './toolOutputResultScan';

// Both modules live in @bike4mind/utils, which carries their tests; this only pins the re-exports.
describe('client re-export shims', () => {
  it('re-exports importStatements and toolOutputResultScan from core', () => {
    expect(hasSingleLineImportFrom(`import React from 'react'`, 'react')).toBe(true);
    expect(typeof replaceDirectTypeObjects).toBe('function');
  });
});
