import type { IMessage } from '@bike4mind/common';

const URL_TOKEN = /https?:\/\/[^\s"'<>`\\{}|^]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** Tools whose output an LLM writes from the call's input, so it can never vouch for a URL. */
const MODEL_AUTHORED_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'blog_draft',
  'decide',
  'deep_research',
  'edit_file',
  'generate_jupyter_notebook',
  'prompt_enhancement',
]);

function trimUnbalanced(token: string, open: string, close: string): string {
  let trimmed = token;
  while (trimmed.endsWith(close) && trimmed.split(open).length < trimmed.split(close).length) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/** The comparable form of a URL: prose punctuation and a trailing slash dropped, `&amp;` decoded. */
export function normalizeUrl(url: string): string {
  let token = url.trim().replace(/&amp;/g, '&');
  for (let previous = ''; previous !== token;) {
    previous = token;
    token = trimUnbalanced(trimUnbalanced(token.replace(TRAILING_PUNCTUATION, ''), '(', ')'), '[', ']');
  }
  return token.replace(/\/+$/, '');
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 20 || value == null) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

/** Every http(s) URL in `value` (a string, or any nesting of arrays and objects), normalized. */
export function urlsIn(value: unknown): Set<string> {
  const strings: string[] = [];
  collectStrings(value, strings);
  const urls = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(URL_TOKEN)) urls.add(normalizeUrl(match[0]));
  }
  return urls;
}

/**
 * The URLs a turn may fetch: those that appear word for word in text the model did not write - the
 * user's prompts, attachments, system context and tool results. A model-chosen URL (one that carries
 * conversation data in its path or query) appears in none of them, so it is refused. A tool result
 * counts minus the URLs its own call passed in, so a tool that echoes its input cannot vouch for one.
 *
 * One instance per turn or agent run, shared by every tool built for it (subagents included);
 * consumers are web_fetch and edit_image (ToolContext.urlProvenance).
 */
export class UrlProvenance {
  private readonly seen = new Set<string>();

  recordText(value: unknown): void {
    for (const url of urlsIn(value)) this.seen.add(url);
  }

  recordToolResult(toolName: string, args: unknown, result: unknown): void {
    if (MODEL_AUTHORED_RESULT_TOOLS.has(toolName)) return;
    const echoed = urlsIn(args);
    for (const url of urlsIn(result)) if (!echoed.has(url)) this.seen.add(url);
  }

  /**
   * Seeds from a message list: every message the model did not write, with each tool result paired
   * to its call (by id) so the call's own URLs are subtracted as in `recordToolResult`.
   */
  recordMessages(messages: readonly IMessage[]): void {
    const calls = new Map<string, { name: string; input: unknown }>();
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
      }
    }
    for (const message of messages) {
      if (message.role === 'assistant') continue;
      if (!Array.isArray(message.content)) {
        this.recordText(message.content);
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          const call = calls.get(block.tool_use_id);
          this.recordToolResult(call?.name ?? '', call?.input, block.content);
        } else if (block.type === 'text') {
          this.recordText(block.text);
        }
      }
    }
  }

  allows(url: string): boolean {
    return this.seen.has(normalizeUrl(url));
  }
}

export const URL_NOT_IN_CONVERSATION_MESSAGE =
  'This URL does not appear in anything the user sent or in an earlier search, page, file or tool result in ' +
  'this conversation, so it was not fetched. Only fetch URLs exactly as they appear there; to find a page, use ' +
  'web_search, or ask the user to paste the link.';
