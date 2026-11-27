import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import {
  feedbackDestinations,
  feedbackId,
  reactionSchema,
  signFeedback,
  statusSchema,
  verifyFeedback,
} from './feedbackProtocol';

const secret = 'synthetic-test-signing-key-not-real-12345';
describe('feedback protocol', () => {
  it('authenticates exact callback bytes, timestamp and purpose', () => {
    const body = JSON.stringify({ deliveryId: feedbackId('T1', 'C1', '1.2'), status: 'filed' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signFeedback(body, timestamp, secret, 'status');
    expect(verifyFeedback(body, timestamp, signature, secret)).toBe(true);
    expect(verifyFeedback(body + ' ', timestamp, signature, secret)).toBe(false);
    expect(verifyFeedback(body, timestamp, signFeedback(body, timestamp, secret, 'forward'), secret)).toBe(false);
    expect(verifyFeedback(body, timestamp, signature, secret + 'x')).toBe(false);
    expect(verifyFeedback(body, String(Number(timestamp) - 301), signature, secret)).toBe(false);
    expect(verifyFeedback(body, `${timestamp}garbage`, signature, secret)).toBe(false);
    expect(verifyFeedback(body, timestamp, ['signature'], secret)).toBe(false);
  });
  it('fails closed for malformed or duplicate destinations and unsafe URL syntax', () => {
    const destination = { id: 'test', organizationId: 'org1', url: 'https://receiver.example/feedback', secret };
    expect(feedbackDestinations(JSON.stringify([destination]))).toEqual([destination]);
    for (const raw of [
      undefined,
      'not-configured',
      '{',
      JSON.stringify([destination, destination]),
      JSON.stringify([{ ...destination, url: 'http://receiver.example' }]),
      JSON.stringify([{ ...destination, url: 'https://user:password@receiver.example' }]),
      JSON.stringify([{ ...destination, secret: 'short' }]),
    ]) {
      expect(feedbackDestinations(raw)).toEqual([]);
    }
  });
  it('accepts only targeted channel message reactions and fixed callback vocabulary', () => {
    const reaction = {
      type: 'reaction_added',
      reaction: 'bug',
      user: 'U123',
      item: { type: 'message', channel: 'C123', ts: '1.2' },
    };
    expect(reactionSchema.safeParse(reaction).success).toBe(true);
    expect(reactionSchema.safeParse({ ...reaction, item: { ...reaction.item, channel: 'D123' } }).success).toBe(false);
    expect(reactionSchema.safeParse({ ...reaction, item: { type: 'file', file: 'F1' } }).success).toBe(false);
    expect(statusSchema.safeParse({ deliveryId: feedbackId('a'), status: '<!channel>' }).success).toBe(false);
    expect(statusSchema.safeParse({ deliveryId: feedbackId('a'), status: 'filed', text: 'injection' }).success).toBe(
      false
    );
    expect(feedbackId('ab', 'c')).not.toBe(feedbackId('a', 'bc'));
  });
  it('warns on invalid configuration without exposing any values', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    feedbackDestinations('{"secret":"must-not-log"');
    feedbackDestinations('[{"secret":"must-not-log"}]');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('must-not-log');
    warn.mockRestore();
  });
});

it.each([
  ['W12345678', 'C12345678'],
  ['U12345678', 'G12345678'],
  ['W12345678', 'G12345678'],
])('accepts Slack reactor %s in channel %s', (user, channel) => {
  expect(
    reactionSchema.safeParse({
      type: 'reaction_added',
      reaction: 'bug',
      user,
      item: { type: 'message', channel, ts: '1.2' },
    }).success
  ).toBe(true);
});

it.each(['D12345678', 'g12345678', 'Gbad-id', 'G'])('rejects malformed or DM channel %s', channel => {
  expect(
    reactionSchema.safeParse({
      type: 'reaction_added',
      reaction: 'bug',
      user: 'W12345678',
      item: { type: 'message', channel, ts: '1.2' },
    }).success
  ).toBe(false);
});
