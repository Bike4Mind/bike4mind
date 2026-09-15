import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildFeedbackDeepLinks } from './feedbackDeepLinks';

describe('buildFeedbackDeepLinks', () => {
  const originalAppUrl = process.env.APP_URL;

  beforeEach(() => {
    process.env.APP_URL = 'https://app.example.com';
  });

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });

  it('links the admin record and the reported turn when the report has both ids', () => {
    const links = buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: 'sess-1', questId: 'quest-1' });

    expect(links).not.toBeNull();
    const record = new URL(links!.record);
    expect(record.origin).toBe('https://app.example.com');
    expect(record.pathname).toBe('/admin');
    expect(record.searchParams.get('tab')).toBe('feedback');
    expect(record.searchParams.get('feedbackId')).toBe('fb-1');

    const conversation = new URL(links!.conversation!);
    expect(conversation.pathname).toBe('/notebooks/sess-1');
    expect(conversation.searchParams.get('questId')).toBe('quest-1');
    expect(links!.conversationIsTurn).toBe(true);
  });

  it('degrades to the session itself when the report names no turn', () => {
    const links = buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: 'sess-1' });

    const conversation = new URL(links!.conversation!);
    expect(conversation.pathname).toBe('/notebooks/sess-1');
    expect(conversation.search).toBe('');
    expect(links!.conversationIsTurn).toBe(false);
  });

  it('has no conversation link for a product-level report, even when a turn id somehow survives', () => {
    const links = buildFeedbackDeepLinks({ feedbackId: 'fb-1', questId: 'quest-1' });

    expect(links!.conversation).toBeNull();
    // A turn link needs a session to open; claiming otherwise would label a null target.
    expect(links!.conversationIsTurn).toBe(false);
  });

  it('treats an empty id as absent rather than linking to /notebooks/', () => {
    const links = buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: '', questId: '' });

    expect(links!.conversation).toBeNull();
    expect(links!.conversationIsTurn).toBe(false);
  });

  it('drops an empty turn id back to the session link rather than a bare ?questId=', () => {
    const links = buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: 'sess-1', questId: '' });

    expect(links!.conversation).toBe('https://app.example.com/notebooks/sess-1');
    expect(links!.conversationIsTurn).toBe(false);
  });

  it('returns null rather than emitting a relative link when APP_URL is unset or blank', () => {
    delete process.env.APP_URL;
    expect(buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: 'sess-1' })).toBeNull();

    process.env.APP_URL = '   ';
    expect(buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: 'sess-1' })).toBeNull();
  });

  it('does not double the separator when APP_URL carries a trailing slash', () => {
    process.env.APP_URL = 'https://app.example.com/';
    const links = buildFeedbackDeepLinks({ feedbackId: 'fb-1', sessionId: 'sess-1' });

    expect(links!.record).toContain('https://app.example.com/admin?');
    expect(links!.conversation).toBe('https://app.example.com/notebooks/sess-1');
  });
});
