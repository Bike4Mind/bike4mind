import { describe, expect, it } from 'vitest';
import { usdToCredits } from '@bike4mind/utils';
import {
  ELEVENLABS_CONVERSATIONAL_USD_PER_MINUTE,
  createElevenLabsConversationalTransport,
  estimateElevenLabsConversationalCost,
} from './elevenlabsConversational';

describe('estimateElevenLabsConversationalCost', () => {
  it('prices a minute at the default per-minute rate', () => {
    expect(estimateElevenLabsConversationalCost(60)).toEqual({
      voiceMinutesUpperBound: 1,
      creditsToReserve: usdToCredits(ELEVENLABS_CONVERSATIONAL_USD_PER_MINUTE),
    });
  });

  it('keeps the hold sized as before: five minutes at $0.20/min through usdToCredits', () => {
    const transport = createElevenLabsConversationalTransport({ apiKey: 'k', agentId: 'a' });
    expect(transport.estimateCost(300)).toEqual({ voiceMinutesUpperBound: 5, creditsToReserve: usdToCredits(1) });
  });

  it('shows a per-minute price that is exactly a fifth of the five-minute hold at the default rate', () => {
    // The start control displays the 1-minute figure and the server holds the 5-minute one; each is
    // rounded up separately, so a repricing that breaks this divisibility shows up here.
    expect(estimateElevenLabsConversationalCost(60).creditsToReserve * 5).toBe(
      estimateElevenLabsConversationalCost(300).creditsToReserve
    );
  });

  it('is what the transport reserves, at the default and at an overridden rate', () => {
    const transport = createElevenLabsConversationalTransport({ apiKey: 'k', agentId: 'a' });
    expect(transport.estimateCost(300)).toEqual(estimateElevenLabsConversationalCost(300));

    const pricier = createElevenLabsConversationalTransport({ apiKey: 'k', agentId: 'a', usdPerMinuteUpperBound: 1 });
    expect(pricier.estimateCost(300)).toEqual(estimateElevenLabsConversationalCost(300, 1));
  });
});
