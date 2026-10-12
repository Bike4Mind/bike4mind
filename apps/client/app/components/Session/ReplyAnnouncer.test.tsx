import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { IChatHistoryItem } from '@bike4mind/common';
import ReplyAnnouncer, { replyAnnouncementText } from './ReplyAnnouncer';

const quest = (id: string, reply: string | null): IChatHistoryItem =>
  ({ id, sessionId: 's1', type: 'message', timestamp: new Date(), prompt: 'hi', reply }) as IChatHistoryItem;

const region = () => screen.getByRole('status');

describe('replyAnnouncementText', () => {
  it('flattens markdown to plain text', () => {
    expect(replyAnnouncementText({ reply: '## Title\n\n**Bold** and [a link](https://x.test)' })).toBe(
      'Title Bold and a link'
    );
  });

  it('summarises code blocks instead of reading them', () => {
    expect(replyAnnouncementText({ reply: 'Try:\n```ts\nconst a = 1;\n```' })).toBe('Try: code block');
  });

  it('falls back to replies[] and returns null with no text', () => {
    expect(replyAnnouncementText({ reply: null, replies: ['', 'second'] })).toBe('second');
    expect(replyAnnouncementText({ reply: '' })).toBeNull();
  });

  it('caps long replies', () => {
    const text = replyAnnouncementText({ reply: 'a '.repeat(1000) }) ?? '';
    expect(text.endsWith('...')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(603);
  });
});

describe('ReplyAnnouncer', () => {
  it('is a polite status region', () => {
    render(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[]} />);
    expect(region().getAttribute('aria-live')).toBe('polite');
  });

  it('stays silent while a reply streams and announces it once complete', () => {
    const { rerender } = render(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', 'Hel')]} />
    );
    rerender(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', 'Hello the')]} />);
    expect(region().textContent).toBe('');

    rerender(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[quest('q1', 'Hello there')]} />
    );
    expect(region().textContent).toBe('Hello there');
  });

  it('waits for the finished reply to land in the history', () => {
    const { rerender } = render(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[]} />);
    rerender(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[]} />);
    expect(region().textContent).toBe('');
    rerender(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[quest('q1', 'Done')]} />);
    expect(region().textContent).toBe('Done');
  });

  it('does not announce history that was already there on load', () => {
    render(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[quest('q0', 'Old reply')]} />);
    expect(region().textContent).toBe('');
  });

  it('clears the last announcement when the next reply starts streaming', () => {
    const { rerender } = render(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', '')]} />
    );
    rerender(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[quest('q1', 'First')]} />);
    rerender(
      <ReplyAnnouncer
        sessionId="s1"
        activeStreamingQuestId="q2"
        chatHistory={[quest('q2', ''), quest('q1', 'First')]}
      />
    );
    expect(region().textContent).toBe('');
  });
});
