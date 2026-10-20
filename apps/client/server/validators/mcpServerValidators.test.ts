// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mcpServerCreateBodySchema, mcpServerUpdateBodySchema } from './mcpServerValidators';

describe('mcpServerUpdateBodySchema', () => {
  // An edit sends a stored key back without a value, which the handler keeps the stored value
  // for; requiring one here would 400 every save that does not retype a credential.
  it('accepts a stored key with no value', () => {
    expect(mcpServerUpdateBodySchema.safeParse({ envVariables: [{ key: 'NOTION_ACCESS_TOKEN' }] }).success).toBe(true);
  });

  it('accepts a stored key with a blank value', () => {
    expect(
      mcpServerUpdateBodySchema.safeParse({ envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: '' }] }).success
    ).toBe(true);
  });

  it('accepts a key with a replacement value', () => {
    expect(
      mcpServerUpdateBodySchema.safeParse({ envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: 'new' }] }).success
    ).toBe(true);
  });
});

describe('mcpServerCreateBodySchema', () => {
  // A create has no stored value to fall back on, so a key alone is not a complete credential.
  it('still requires a value', () => {
    expect(
      mcpServerCreateBodySchema.safeParse({ name: 'notion', envVariables: [{ key: 'NOTION_ACCESS_TOKEN' }] }).success
    ).toBe(false);
  });

  it('accepts a key with a value', () => {
    expect(
      mcpServerCreateBodySchema.safeParse({
        name: 'notion',
        envVariables: [{ key: 'NOTION_ACCESS_TOKEN', value: 'secret' }],
      }).success
    ).toBe(true);
  });
});
