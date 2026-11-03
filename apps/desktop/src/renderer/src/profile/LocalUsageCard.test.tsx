import { renderToStaticMarkup } from 'react-dom/server';
import type { LocalUsageFigures } from '@shared/usage';
import { describe, expect, it } from 'vitest';
import { formatTokenRate } from '../chat/tokenRate';
import { LocalUsageCard } from './LocalUsageCard';
import { localUsageFixture } from './localUsageFixture';

function card(totals: Partial<LocalUsageFigures>): string {
  return renderToStaticMarkup(<LocalUsageCard usage={localUsageFixture(totals)} />);
}

describe('LocalUsageCard', () => {
  it('renders nothing for a window with no local replies', () => {
    expect(card({})).toBe('');
  });

  it('states replies, output and context tokens, and the speed in the reply footer format', () => {
    const html = card({
      replies: 5,
      outputTokens: 4200,
      contextTokens: 12_000,
      timedReplies: 3,
      evalTokens: 1000,
      evalMs: 41_800,
    });
    expect(html).toContain('profile-local-card');
    expect(html).toContain('4.2k');
    expect(html).toContain('12k context tokens');
    expect(html).toContain(formatTokenRate({ evalTokens: 1000, evalMs: 41_800 }));
    expect(html).toContain('23.9 tok/s');
    expect(html).toContain('timed 3 of 5 replies');
    expect(html).toContain('profile-local-chart');
    expect(html).toContain('profile-local-model-breakdown');
    expect(html).toContain('profile-local-server-breakdown');
    expect(html).toContain('This computer');
  });

  it('leaves out every speed figure no server reported', () => {
    const html = card({ replies: 2, outputTokens: 80 });
    expect(html).toContain('profile-local-replies');
    for (const id of ['generation', 'estimated', 'prompt', 'load', 'draft']) {
      expect(html).not.toContain(`profile-local-${id}`);
    }
    expect(html).not.toContain('tok/s');
  });

  it('shows prompt, load and draft figures when they were reported', () => {
    const html = card({
      replies: 2,
      outputTokens: 80,
      timedReplies: 2,
      evalTokens: 80,
      evalMs: 2000,
      promptTokens: 3000,
      promptMs: 1500,
      loads: 2,
      loadMs: 3000,
      draftTokens: 40,
      draftAccepted: 30,
    });
    expect(html).toContain('profile-local-prompt');
    expect(html).toContain('2000 tok/s');
    expect(html).toContain('profile-local-load');
    expect(html).toContain('1.5s');
    expect(html).toContain('Avg load time');
    expect(html).toContain('per timed Ollama reply');
    expect(html).not.toContain('loads');
    expect(html).toContain('profile-local-draft');
    expect(html).toContain('75%');
  });

  it('keeps the stream-timed estimate apart from the server-timed rate', () => {
    const html = card({
      replies: 3,
      outputTokens: 300,
      timedReplies: 1,
      evalTokens: 100,
      evalMs: 1000,
      estimatedReplies: 2,
      estimatedEvalTokens: 198,
      estimatedEvalMs: 9900,
    });
    expect(html).toContain('profile-local-generation');
    expect(html).toContain('100 tok/s');
    expect(html).toContain('profile-local-estimated');
    expect(html).toContain('~20.0 tok/s');
    expect(html).toContain('2 replies timed by this app');
  });
});
