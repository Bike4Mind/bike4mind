import { describe, expect, it } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { withholdIdentityTool } from './ChatCompletionProcess';
import { CURRENT_MODEL_DETAILS_TOOL_NAME } from './tools/implementation/currentModelDetails';

const identityOnly = [CURRENT_MODEL_DETAILS_TOOL_NAME];

describe('withholdIdentityTool', () => {
  it('withholds the identity tool from a hardcoded effort-incompatible model when it would be the only tool', () => {
    expect(withholdIdentityTool({ id: ChatModels.GPT5_4, supportsTools: true }, identityOnly)).toBe(true);
  });

  it('withholds it from a catalog-only model whose record states the tools quirk', () => {
    expect(
      withholdIdentityTool(
        {
          id: 'gpt-6-sol',
          supportsTools: true,
          effortIncompatibleWithTools: true,
          dispatchProfile: { toolTransport: 'chat' },
        },
        identityOnly
      )
    ).toBe(true);
  });

  it('offers it to a catalog-only model that states nothing', () => {
    expect(withholdIdentityTool({ id: 'gpt-6-sol', supportsTools: true }, identityOnly)).toBe(false);
  });

  it('lets an explicit catalog false win over the hardcoded set', () => {
    expect(
      withholdIdentityTool(
        { id: ChatModels.GPT5_4, supportsTools: true, effortIncompatibleWithTools: false },
        identityOnly
      )
    ).toBe(false);
  });

  it('never withholds when other tools are present', () => {
    expect(withholdIdentityTool({ id: ChatModels.GPT5_4, supportsTools: true }, [...identityOnly, 'web_search'])).toBe(
      false
    );
  });
});
