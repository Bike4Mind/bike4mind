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

  it.each([
    ['think only', '<think>secret reasoning</think>', null],
    ['think then answer', '<think>Let me work through this</think>The answer is 4', 'The answer is 4'],
    ['unclosed think', 'Intro <think>still reasoning', 'Intro'],
    ['artifact only', '<artifact type="text/html" title="x"><html>body</html></artifact>', 'artifact'],
    ['text around an artifact', 'Here: <artifact type="code">const a = 1;</artifact> Enjoy', 'Here: artifact Enjoy'],
    ['unclosed artifact', 'Here: <artifact type="code">const a', 'Here: artifact'],
  ])('keeps reasoning and artifact bodies out of the announcement: %s', (_label, reply, expected) => {
    expect(replyAnnouncementText({ reply })).toBe(expected);
  });

  it.each([
    ['C#', 'I like C# and F#', 'I like C# and F#'],
    ['snake_case', 'Call snake_case_name now', 'Call snake_case_name now'],
    ['comparison', 'Is 5 > 3 and 2 * 3 = 6', 'Is 5 > 3 and 2 * 3 = 6'],
    ['inline code', 'Run `npm test` first', 'Run npm test first'],
    ['emphasis', 'This is *very* _really_ **bold**', 'This is very really bold'],
    ['list and quote', '- one\n- two\n> quoted', 'one two quoted'],
    ['table', '| a | b |\n| - | - |\n| 1 | 2 |', 'a b 1 2'],
  ])('only strips markdown syntax, not content: %s', (_label, reply, expected) => {
    expect(replyAnnouncementText({ reply })).toBe(expected);
  });

  it('gives image- and video-only replies a cue, and text wins over media', () => {
    expect(replyAnnouncementText({ reply: '', images: ['a.png'] })).toBe('Image ready');
    expect(replyAnnouncementText({ reply: null, videos: ['a.mp4'] })).toBe('Video ready');
    expect(replyAnnouncementText({ reply: 'Here you go', images: ['a.png'] })).toBe('Here you go');
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

  it('drops a pending or announced reply when the session changes', () => {
    const { rerender } = render(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', '')]} />
    );
    rerender(<ReplyAnnouncer sessionId="s2" activeStreamingQuestId={null} chatHistory={[quest('q1', 'Late')]} />);
    expect(region().textContent).toBe('');

    rerender(<ReplyAnnouncer sessionId="s2" activeStreamingQuestId="q2" chatHistory={[quest('q2', '')]} />);
    rerender(<ReplyAnnouncer sessionId="s2" activeStreamingQuestId={null} chatHistory={[quest('q2', 'Fresh')]} />);
    expect(region().textContent).toBe('Fresh');
    rerender(<ReplyAnnouncer sessionId="s3" activeStreamingQuestId={null} chatHistory={[]} />);
    expect(region().textContent).toBe('');
  });

  it('announces the authored message of an errored quest', () => {
    const { rerender } = render(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', '')]} />
    );
    rerender(
      <ReplyAnnouncer
        sessionId="s1"
        activeStreamingQuestId={null}
        chatHistory={[{ ...quest('q1', 'Something went wrong.'), status: 'error' } as IChatHistoryItem]}
      />
    );
    expect(region().textContent).toBe('Something went wrong.');
  });

  it('stays silent for a finished quest with no text and no media, then speaks if the reply lands', () => {
    const { rerender } = render(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', '')]} />
    );
    rerender(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[quest('q1', '')]} />);
    expect(region().textContent).toBe('');
    rerender(<ReplyAnnouncer sessionId="s1" activeStreamingQuestId={null} chatHistory={[quest('q1', 'Late text')]} />);
    expect(region().textContent).toBe('Late text');
  });

  it('announces a cue for an image-only reply', () => {
    const { rerender } = render(
      <ReplyAnnouncer sessionId="s1" activeStreamingQuestId="q1" chatHistory={[quest('q1', '')]} />
    );
    rerender(
      <ReplyAnnouncer
        sessionId="s1"
        activeStreamingQuestId={null}
        chatHistory={[{ ...quest('q1', ''), images: ['a.png'] } as IChatHistoryItem]}
      />
    );
    expect(region().textContent).toBe('Image ready');
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
