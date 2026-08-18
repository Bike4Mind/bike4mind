import { describe, it, expect } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { stripToolDependentMessages } from './toolPairingUtils';

describe('stripToolDependentMessages', () => {
  const imagePrompt: IMessage = {
    role: 'system',
    content: 'When the user requests an image, you MUST use the image_generation tool to create it.',
    requiresTool: 'image_generation',
  };

  it('drops a message that names a required tool', () => {
    expect(stripToolDependentMessages([imagePrompt])).toEqual([]);
  });

  it('keeps every message that names none, in order', () => {
    const kept: IMessage[] = [
      { role: 'system', content: 'Format replies as markdown.' },
      { role: 'user', content: 'draw me a picture of a cat' },
      { role: 'assistant', content: 'Sure.' },
    ];
    expect(stripToolDependentMessages([kept[0], imagePrompt, kept[1], kept[2]])).toEqual(kept);
  });

  it('leaves the caller its own array', () => {
    const input: IMessage[] = [imagePrompt];
    stripToolDependentMessages(input);
    expect(input).toHaveLength(1);
  });

  // An empty string is not a tool name, so it must not be read as "depends on a tool" - the falsy
  // check has to agree with that or a mis-set marker would silently drop a prompt.
  it('keeps a message whose marker is an empty string', () => {
    const odd: IMessage = { role: 'system', content: 'still wanted', requiresTool: '' };
    expect(stripToolDependentMessages([odd])).toEqual([odd]);
  });

  it('returns an empty array unchanged', () => {
    expect(stripToolDependentMessages([])).toEqual([]);
  });
});
