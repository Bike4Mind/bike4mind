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

  it('is what the transport reserves, at the default and at an overridden rate', () => {
    const transport = createElevenLabsConversationalTransport({ apiKey: 'k', agentId: 'a' });
    expect(transport.estimateCost(300)).toEqual(estimateElevenLabsConversationalCost(300));

    const pricier = createElevenLabsConversationalTransport({ apiKey: 'k', agentId: 'a', usdPerMinuteUpperBound: 1 });
    expect(pricier.estimateCost(300)).toEqual(estimateElevenLabsConversationalCost(300, 1));
  });
});
