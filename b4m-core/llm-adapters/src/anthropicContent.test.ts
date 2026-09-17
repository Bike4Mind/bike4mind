import { describe, it, expect, vi } from 'vitest';
import { toAnthropicContent } from './anthropicContent';

const PNG = 'iVBORw0KGgo=';

describe('toAnthropicContent', () => {
  it('passes string content through', () => {
    expect(toAnthropicContent('hello')).toBe('hello');
  });

  it('turns a data URL into a base64 image source', () => {
    expect(
      toAnthropicContent([
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ] as never)
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
  });

  it('reads the media type out of a data URL carrying extra parameters', () => {
    expect(
      toAnthropicContent([
        { type: 'image_url', image_url: { url: `data:image/jpeg;charset=utf-8;base64,${PNG}` } },
      ] as never)
    ).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } }]);
  });

  it('turns an http(s) URL into a url image source', () => {
    expect(toAnthropicContent([{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] as never)).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
    ]);
  });

  it('keeps cache_control across the translation', () => {
    expect(
      toAnthropicContent([
        { type: 'image_url', image_url: { url: 'https://x.test/a.png' }, cache_control: { type: 'ephemeral' } },
      ] as never)
    ).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' }, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('drops an untranslatable image but keeps the rest of the message', () => {
    const logger = { warn: vi.fn() };
    expect(
      toAnthropicContent(
        [
          { type: 'text', text: 'still here' },
          { type: 'image_url', image_url: { url: 'ftp://x.test/a.png' } },
        ] as never,
        logger
      )
    ).toEqual([{ type: 'text', text: 'still here' }]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('replaces a sole untranslatable image with a visible placeholder instead of empty content', () => {
    const logger = { warn: vi.fn() };
    expect(
      toAnthropicContent([{ type: 'image_url', image_url: { url: 'ftp://x.test/a.png' } }] as never, logger)
    ).toEqual([{ type: 'text', text: '[image omitted: unsupported image format]' }]);
  });

  it('leaves inline images and tool blocks untouched', () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
    ];
    expect(toAnthropicContent(content as never)).toEqual(content);
  });
});
