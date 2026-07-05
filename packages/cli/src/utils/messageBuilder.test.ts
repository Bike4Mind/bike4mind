/**
 * Tests multimodal message construction with text and images.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageBuilder, type MultimodalMessage } from './messageBuilder';
import { ImageRenderer } from './imageRenderer';
import { ImageStore } from '../storage/ImageStore';
import type { ImageMetadata } from '../storage/ImageStore';

describe('MessageBuilder', () => {
  let messageBuilder: MessageBuilder;
  let mockImageStore: ImageStore;
  let mockImageRenderer: ImageRenderer;

  beforeEach(() => {
    mockImageStore = {
      readImage: vi.fn(),
      getMetadata: vi.fn(),
    } as any;

    mockImageRenderer = {
      extractImageHashes: vi.fn(),
      getHashFromPlaceholder: vi.fn(),
      createPlaceholder: vi.fn(),
    } as any;

    messageBuilder = new MessageBuilder(mockImageStore, mockImageRenderer);
  });

  describe('buildMessage - text only', () => {
    it('should build simple text message without images', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const result = await messageBuilder.buildMessage('Hello, world!');

      expect(result).toEqual({
        message: {
          role: 'user',
          content: 'Hello, world!',
        },
        uploadedImages: [],
      });
    });

    it('should support different roles', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const userResult = await messageBuilder.buildMessage('User message', 'user');
      expect(userResult.message.role).toBe('user');

      const assistantResult = await messageBuilder.buildMessage('Assistant message', 'assistant');
      expect(assistantResult.message.role).toBe('assistant');

      const systemResult = await messageBuilder.buildMessage('System message', 'system');
      expect(systemResult.message.role).toBe('system');
    });

    it('should handle empty string', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const result = await messageBuilder.buildMessage('');

      expect(result.message.content).toBe('');
    });

    it('should handle multiline text', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const multilineText = `Line 1
Line 2
Line 3`;

      const result = await messageBuilder.buildMessage(multilineText);

      expect(result.message.content).toBe(multilineText);
    });

    it('should handle special characters', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const specialText = 'Special chars: <>&"\'`{}[]()';
      const result = await messageBuilder.buildMessage(specialText);

      expect(result.message.content).toBe(specialText);
    });
  });

  describe('buildMessage - with images', () => {
    it('should build multimodal message with single image', async () => {
      const imageHash = 'abc123';
      const imageData = Buffer.from('fake-image-data');
      const metadata: ImageMetadata = {
        hash: imageHash,
        format: 'png',
        size: 1000,
        timestamp: Date.now(),
        uploaded: false,
      };

      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(imageData);
      vi.mocked(mockImageStore.getMetadata).mockReturnValue(metadata);

      const result = await messageBuilder.buildMessage('Check this image: [Image 1]');

      expect(result.message).toMatchObject({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Check this image: ',
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageData.toString('base64'),
            },
          },
        ],
      });
      expect(result.uploadedImages).toEqual([]);
    });

    it('should handle multiple images in message', async () => {
      const hash1 = 'image1';
      const hash2 = 'image2';
      const imageData1 = Buffer.from('image-data-1');
      const imageData2 = Buffer.from('image-data-2');

      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([hash1, hash2]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValueOnce(hash1).mockReturnValueOnce(hash2);

      vi.mocked(mockImageStore.readImage).mockReturnValueOnce(imageData1).mockReturnValueOnce(imageData2);

      vi.mocked(mockImageStore.getMetadata)
        .mockReturnValueOnce({ hash: hash1, format: 'png', size: 100, timestamp: 0, uploaded: false })
        .mockReturnValueOnce({ hash: hash2, format: 'jpg', size: 200, timestamp: 0, uploaded: false });

      const result = await messageBuilder.buildMessage('[Image 1] and [Image 2]');

      expect(result.message).toMatchObject({
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
            },
          },
          {
            type: 'text',
            text: ' and ',
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
            },
          },
        ],
      });
    });

    it('should handle text before, between, and after images', async () => {
      const imageHash = 'hash1';
      const imageData = Buffer.from('image');

      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(imageData);
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: imageHash,
        format: 'png',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('Before [Image 1] After');

      expect(result.message).toMatchObject({
        content: [{ type: 'text', text: 'Before ' }, { type: 'image' }, { type: 'text', text: ' After' }],
      });
    });

    it('should skip empty text sections', async () => {
      const imageHash = 'hash1';
      const imageData = Buffer.from('image');

      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(imageData);
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: imageHash,
        format: 'png',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('[Image 1]');

      // Should only have image, no empty text sections
      const content = (result.message as any).content;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('image');
    });

    it('should handle missing image data gracefully', async () => {
      const imageHash = 'missing-hash';

      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(null);
      vi.mocked(mockImageStore.getMetadata).mockReturnValue(null);

      const result = await messageBuilder.buildMessage('Image here: [Image 1] End');

      // Should only include text, skip missing image
      expect(result.message).toMatchObject({
        content: [
          { type: 'text', text: 'Image here: ' },
          { type: 'text', text: ' End' },
        ],
      });
    });
  });

  describe('getMediaType', () => {
    it('should return correct MIME types for common formats', async () => {
      const testCases = [
        { format: 'png', expected: 'image/png' },
        { format: 'jpg', expected: 'image/jpeg' },
        { format: 'jpeg', expected: 'image/jpeg' },
        { format: 'gif', expected: 'image/gif' },
        { format: 'webp', expected: 'image/webp' },
      ];

      for (const { format, expected } of testCases) {
        vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue(['hash']);
        vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue('hash');
        vi.mocked(mockImageStore.readImage).mockReturnValue(Buffer.from('data'));
        vi.mocked(mockImageStore.getMetadata).mockReturnValue({
          hash: 'hash',
          format,
          size: 100,
          timestamp: 0,
          uploaded: false,
        });

        const result = await messageBuilder.buildMessage('[Image 1]');
        const imageContent = (result.message as any).content[0];

        expect(imageContent.source.media_type).toBe(expected);
      }
    });

    it('should default to image/png for unknown formats', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue(['hash']);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue('hash');
      vi.mocked(mockImageStore.readImage).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: 'hash',
        format: 'unknown',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('[Image 1]');
      const imageContent = (result.message as any).content[0];

      expect(imageContent.source.media_type).toBe('image/png');
    });

    it('should handle case-insensitive formats', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue(['hash']);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue('hash');
      vi.mocked(mockImageStore.readImage).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: 'hash',
        format: 'PNG',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('[Image 1]');
      const imageContent = (result.message as any).content[0];

      expect(imageContent.source.media_type).toBe('image/png');
    });
  });

  describe('hasImages', () => {
    it('should return false for text-only messages', () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const result = messageBuilder.hasImages('Just text');

      expect(result).toBe(false);
    });

    it('should return true for messages with images', () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue(['hash1']);

      const result = messageBuilder.hasImages('Text with [Image 1]');

      expect(result).toBe(true);
    });

    it('should return true for messages with multiple images', () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue(['hash1', 'hash2']);

      const result = messageBuilder.hasImages('[Image 1] and [Image 2]');

      expect(result).toBe(true);
    });
  });

  describe('messageToString', () => {
    it('should return content as-is for simple string messages', () => {
      const message = {
        role: 'user',
        content: 'Simple text message',
      };

      const result = messageBuilder.messageToString(message);

      expect(result).toBe('Simple text message');
    });

    it('should convert multimodal message with text only', () => {
      const message: MultimodalMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' world' },
        ],
      };

      const result = messageBuilder.messageToString(message);

      expect(result).toBe('Hello world');
    });

    it('should convert multimodal message with base64 images', () => {
      const message: MultimodalMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'Check this: ' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'fake-base64-data',
            },
          },
          { type: 'text', text: ' Cool!' },
        ],
      };

      const result = messageBuilder.messageToString(message);

      expect(result).toBe('Check this: [Image: base64 image/png] Cool!');
    });

    it('should convert multimodal message with URL images', () => {
      const message: MultimodalMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'See: ' },
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/image.png',
            },
          },
        ],
      };

      const result = messageBuilder.messageToString(message);

      expect(result).toBe('See: [Image: https://example.com/image.png]');
    });

    it('should handle empty content array', () => {
      const message: MultimodalMessage = {
        role: 'user',
        content: [],
      };

      const result = messageBuilder.messageToString(message);

      expect(result).toBe('');
    });

    it('should handle message with only images', () => {
      const message: MultimodalMessage = {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'data1',
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'data2',
            },
          },
        ],
      };

      const result = messageBuilder.messageToString(message);

      expect(result).toBe('[Image: base64 image/jpeg][Image: base64 image/png]');
    });
  });

  describe('splitMessageByPlaceholders', () => {
    it('should handle message with no placeholders', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const result = await messageBuilder.buildMessage('No placeholders here');

      expect(result.message.content).toBe('No placeholders here');
    });

    it('should split message with placeholder at start', async () => {
      const imageHash = 'hash1';
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: imageHash,
        format: 'png',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('[Image 1] followed by text');

      const content = (result.message as any).content;
      expect(content[0].type).toBe('image');
      expect(content[1]).toMatchObject({ type: 'text', text: ' followed by text' });
    });

    it('should split message with placeholder at end', async () => {
      const imageHash = 'hash1';
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: imageHash,
        format: 'png',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('Text before [Image 1]');

      const content = (result.message as any).content;
      expect(content[0]).toMatchObject({ type: 'text', text: 'Text before ' });
      expect(content[1].type).toBe('image');
    });

    it('should handle consecutive placeholders', async () => {
      const hash1 = 'hash1';
      const hash2 = 'hash2';
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([hash1, hash2]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValueOnce(hash1).mockReturnValueOnce(hash2);
      vi.mocked(mockImageStore.readImage).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: 'hash',
        format: 'png',
        size: 100,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('[Image 1][Image 2]');

      const content = (result.message as any).content;
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe('image');
      expect(content[1].type).toBe('image');
    });
  });

  describe('edge cases', () => {
    it('should handle very long text messages', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const longText = 'a'.repeat(10000);
      const result = await messageBuilder.buildMessage(longText);

      expect(result.message.content).toBe(longText);
    });

    it('should handle Unicode characters', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const unicodeText = '你好 мир 🌍 emoji';
      const result = await messageBuilder.buildMessage(unicodeText);

      expect(result.message.content).toBe(unicodeText);
    });

    it('should handle placeholder-like text that is not a real placeholder', async () => {
      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([]);

      const result = await messageBuilder.buildMessage('This [Image 1] is not a real image');

      // Since extractImageHashes returns empty, should treat as plain text
      expect(result.message.content).toBe('This [Image 1] is not a real image');
    });

    it('should properly encode large base64 images', async () => {
      const largeImageData = Buffer.alloc(100000, 'x'); // 100KB of data
      const imageHash = 'large-image';

      vi.mocked(mockImageRenderer.extractImageHashes).mockReturnValue([imageHash]);
      vi.mocked(mockImageRenderer.getHashFromPlaceholder).mockReturnValue(imageHash);
      vi.mocked(mockImageStore.readImage).mockReturnValue(largeImageData);
      vi.mocked(mockImageStore.getMetadata).mockReturnValue({
        hash: imageHash,
        format: 'png',
        size: largeImageData.length,
        timestamp: 0,
        uploaded: false,
      });

      const result = await messageBuilder.buildMessage('[Image 1]');

      const imageContent = (result.message as any).content[0];
      expect(imageContent.source.data).toBe(largeImageData.toString('base64'));
      expect(imageContent.source.data.length).toBeGreaterThan(100000);
    });
  });
});
