import { ImageRenderer } from './imageRenderer.js';
import { ImageStore } from '../storage/ImageStore.js';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source:
    | {
        type: 'base64';
        media_type: string;
        data: string;
      }
    | {
        type: 'url';
        url: string;
      };
}

export type MessageContent = TextContent | ImageContent;

export interface MultimodalMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent[];
}

/**
 * Builds messages with multimodal content support
 * Converts images to base64 for Claude's vision API
 */
export class MessageBuilder {
  private imageStore: ImageStore;
  private imageRenderer: ImageRenderer;

  constructor(imageStore: ImageStore, imageRenderer: ImageRenderer) {
    this.imageStore = imageStore;
    this.imageRenderer = imageRenderer;
  }

  /**
   * Build a multimodal message from user input
   * Extracts image placeholders and creates proper message structure with base64-encoded images
   */
  async buildMessage(
    userInput: string,
    role: 'user' | 'assistant' | 'system' = 'user'
  ): Promise<{
    message: MultimodalMessage | { role: string; content: string };
    uploadedImages: string[];
  }> {
    // Extract image hashes from placeholders in the message
    const imageHashes = this.imageRenderer.extractImageHashes(userInput);

    // If no images, return simple text message
    if (imageHashes.length === 0) {
      return {
        message: {
          role,
          content: userInput,
        },
        uploadedImages: [],
      };
    }

    // Build multimodal content array
    const content: MessageContent[] = [];

    // Split message by image placeholders to interleave text and images
    const parts = this.splitMessageByPlaceholders(userInput);

    for (const part of parts) {
      if (part.type === 'text' && part.content.trim()) {
        content.push({
          type: 'text',
          text: part.content,
        });
      } else if (part.type === 'image') {
        const hash = this.imageRenderer.getHashFromPlaceholder(part.content);
        if (hash) {
          // Get image from local store and encode as base64
          const imageData = this.imageStore.readImage(hash);
          const metadata = this.imageStore.getMetadata(hash);

          if (imageData && metadata) {
            const base64Data = imageData.toString('base64');
            const mediaType = this.getMediaType(metadata.format);

            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            });
          }
        }
      }
    }

    return {
      message: {
        role,
        content,
      },
      uploadedImages: [],
    };
  }

  /**
   * Get MIME type for image format
   */
  private getMediaType(format: string): string {
    switch (format.toLowerCase()) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/png';
    }
  }

  /**
   * Split message text by image placeholders
   * Returns array of text and image parts in order
   */
  private splitMessageByPlaceholders(message: string): Array<{ type: 'text' | 'image'; content: string }> {
    const parts: Array<{ type: 'text' | 'image'; content: string }> = [];
    const placeholderRegex = /(\[Image \d+\])/g;

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(message)) !== null) {
      // Add text before the placeholder
      if (match.index > lastIndex) {
        const text = message.substring(lastIndex, match.index);
        if (text) {
          parts.push({ type: 'text', content: text });
        }
      }

      // Add the image placeholder
      parts.push({ type: 'image', content: match[0] });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last placeholder
    if (lastIndex < message.length) {
      const text = message.substring(lastIndex);
      if (text) {
        parts.push({ type: 'text', content: text });
      }
    }

    // If no matches found, return entire message as text
    if (parts.length === 0) {
      parts.push({ type: 'text', content: message });
    }

    return parts;
  }

  /**
   * Check if a message contains images
   */
  hasImages(message: string): boolean {
    return this.imageRenderer.extractImageHashes(message).length > 0;
  }

  /**
   * Convert multimodal message back to simple string (for display/logging)
   */
  messageToString(message: MultimodalMessage | { role: string; content: string }): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    return message.content
      .map(item => {
        if (item.type === 'text') {
          return item.text;
        } else if (item.type === 'image') {
          if (item.source.type === 'url') {
            return `[Image: ${item.source.url}]`;
          } else {
            return `[Image: base64 ${item.source.media_type}]`;
          }
        }
        return '';
      })
      .join('');
  }
}
