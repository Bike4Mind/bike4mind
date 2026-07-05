type ExtendedMessageRole = 'user' | 'assistant' | 'system' | 'error' | 'function';

export interface IExtendedMessage extends Omit<IMessage, 'role'> {
  role: ExtendedMessageRole;
}

export type MessageContentTypes = 'text' | 'image' | 'image_url' | 'tool_use' | 'tool_result' | 'thinking';

type ChatCompletionMessageRole = 'user' | 'assistant' | 'system' | 'function' | 'tool';

interface MessageContentBase {
  type: MessageContentTypes;
  text?: string;
  image_url?: {
    url: string;
  };

  // tool_use
  id?: string;
  name?: string;
  input?: {
    [key: string]: unknown;
  };

  // thinking
  thinking?: string;
}

export interface MessageContentText extends MessageContentBase {
  type: 'text';
  text: string;
}

export interface MessageContentImageUrl extends MessageContentBase {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface MessageContentInlineImage extends MessageContentBase {
  type: 'image';
  source: {
    // "base64" for base64-encoded image:
    type: 'base64';
    // MIME type of the content, eg "image/jpeg" "image/png"
    media_type: string;
    // Base64-encoded image
    data: string;
  };
}

export interface MessageContentToolUse extends MessageContentBase {
  type: 'tool_use';
  id: string;
  name: string;
  input: {
    [key: string]: unknown;
  };
  thought_signature?: string; // Required by Gemini API for function calling
}

export interface MessageContentToolResult extends MessageContentBase {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface MessageContentThinking extends MessageContentBase {
  type: 'thinking';
  thinking: string;
  signature?: string; // Required by Anthropic API for verification
}

export type MessageContentObject =
  | MessageContentText
  | MessageContentImageUrl
  | MessageContentInlineImage
  | MessageContentToolUse
  | MessageContentToolResult
  | MessageContentThinking;

export type MessageContent = string | MessageContentObject[];

export interface IMessage {
  role: ChatCompletionMessageRole;
  content: MessageContent | string;
  fabFileIds?: string[];
  /**
   * Mark this message as a cache breakpoint. Anthropic translates this to
   * `cache_control: { type: 'ephemeral' }` on the content block; other providers
   * ignore the flag. Setting on a message also auto-attaches the prompt-caching
   * beta header.
   */
  cache?: boolean;
}
