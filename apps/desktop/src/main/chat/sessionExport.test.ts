import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from '@shared/chat';
import { sanitizeFilename, sessionToJson, sessionToMarkdown } from './sessionExport';

describe('sanitizeFilename', () => {
  it('replaces path separators and reserved characters', () => {
    expect(sanitizeFilename('a/b:c')).toBe('a-b-c');
    expect(sanitizeFilename('what? "now" <x>|y*z\\w')).toBe('what- -now- -x--y-z-w');
  });

  it('replaces control characters and collapses whitespace', () => {
    expect(sanitizeFilename('one\u0000two\n\nthree   four')).toBe('one-two three four');
  });

  it('trims dots and spaces from both ends', () => {
    expect(sanitizeFilename('  ..hidden. ')).toBe('hidden');
  });

  it('falls back when nothing usable is left', () => {
    expect(sanitizeFilename('')).toBe('notebook');
    expect(sanitizeFilename(' . . ')).toBe('notebook');
  });

  it('caps the length', () => {
    expect(sanitizeFilename('x'.repeat(500))).toHaveLength(100);
  });
});

const message = (extra: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'm', role: 'user', content: '', createdAt: '2026-10-01T00:00:00.000Z', ...extra }) as ChatMessage;

const session = (messages: ChatMessage[]): ChatSession =>
  ({
    id: 's1',
    title: 'Plan the trip',
    model: 'test-model',
    createdAt: '2026-10-01T12:30:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    mode: 'chat',
    messageCount: messages.length,
    messages,
  }) as unknown as ChatSession;

describe('sessionToMarkdown', () => {
  const fence = '```';
  const full = session([
    message({
      id: 'u1',
      role: 'user',
      content: 'Look at this file',
      attachments: [
        { id: 'a1', kind: 'pdf', name: 'trip.pdf', mediaType: 'application/pdf', byteSize: 1, sourceBytes: 1 },
      ],
    }),
    message({
      id: 'a1',
      role: 'assistant',
      content: `Here is code:\n${fence}ts\nconst x = 1;\n${fence}`,
      toolCalls: [
        {
          id: 't1',
          name: 'read_file',
          input: { path: '/tmp/trip.md', extra: 'ignored' },
          status: 'done',
          preview: 'FULL OUTPUT SHOULD NOT APPEAR',
        },
      ],
      artifacts: [
        {
          id: 'art1',
          type: 'html',
          title: 'Itinerary',
          content: '<p>hi</p>',
          mimeType: 'text/html',
        },
      ],
    }),
  ]);

  it('writes the header and one section per turn', () => {
    const out = sessionToMarkdown(full);
    expect(out.startsWith('# Plan the trip\n\nCreated 2026-10-01 - Model: test-model\n\n## User\n')).toBe(true);
    expect(out).toContain('## User\n\nLook at this file');
    expect(out).toContain('## Assistant\n\nHere is code:');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('lists attachments by name and kind', () => {
    expect(sessionToMarkdown(full)).toContain('- Attachment: trip.pdf (pdf)');
  });

  it('keeps fenced code in message text intact', () => {
    expect(sessionToMarkdown(full)).toContain(`${fence}ts\nconst x = 1;\n${fence}`);
  });

  it('summarizes a tool call on one line without its output', () => {
    const out = sessionToMarkdown(full);
    expect(out).toContain('- Tool: `read_file` - /tmp/trip.md');
    expect(out).not.toContain('FULL OUTPUT');
  });

  it('renders an artifact as a fenced block under its title', () => {
    expect(sessionToMarkdown(full)).toContain('**Artifact: Itinerary**\n\n```html\n<p>hi</p>\n```');
  });

  it('uses a longer fence when an artifact body contains one', () => {
    const out = sessionToMarkdown(
      session([
        message({
          role: 'assistant',
          artifacts: [
            { id: 'x', type: 'code', title: 'Doc', content: `${fence}\ninner\n${fence}`, mimeType: 'text/x' },
          ],
        }),
      ])
    );
    expect(out).toContain(`\`\`\`\`code\n${fence}\ninner\n${fence}\n\`\`\`\``);
  });

  it('shows app notices and boundaries but not an empty assistant turn', () => {
    const out = sessionToMarkdown(
      session([
        message({ role: 'user', system: true, content: 'model copy', display: 'Report came back' }),
        message({ role: 'user', boundary: { kind: 'clear' } }),
        message({ role: 'assistant', content: '' }),
      ])
    );
    expect(out).toContain('## Notice\n\nReport came back');
    expect(out).toContain('_Context cleared._');
    expect(out).not.toContain('model copy');
    expect(out).not.toContain('## Assistant');
  });

  it('draws rounds in the order they happened', () => {
    const out = sessionToMarkdown(
      session([
        message({
          role: 'assistant',
          content: 'first second',
          toolCalls: [{ id: 't', name: 'bash', input: { command: 'ls' }, status: 'error' }],
          rounds: [
            { text: 'first', toolCallIds: ['t'] },
            { text: 'second', toolCallIds: [] },
          ],
        }),
      ])
    );
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('- Tool: `bash` - ls [error]'));
    expect(out.indexOf('- Tool')).toBeLessThan(out.indexOf('second'));
  });
});

describe('sessionToJson', () => {
  it('is the record the renderer sees, indented', () => {
    const record = session([message({ content: 'hi' })]);
    expect(sessionToJson(record)).toBe(JSON.stringify(record, null, 2));
  });

  it('leaves out per-round request payloads', () => {
    const record = session([
      message({
        role: 'assistant',
        content: 'done',
        rounds: [{ text: 'done', toolCallIds: [], sent: { assistant: { role: 'assistant' } } } as never],
      }),
    ]);
    const out = sessionToJson(record);
    expect(out).not.toContain('"sent"');
    expect(JSON.parse(out).messages[0].rounds[0].text).toBe('done');
  });
});
