import { describe, expect, it } from 'vitest';
import {
  ATTACHED_CONTENT_EXTRACTION_SHARE,
  attachedContentAssemblyFloor,
  attachedContentBudgetsAgree,
  attachedContentExtractionBudget,
  effectiveContextWindow,
  EXTRACTION_SYSTEM_RESERVE_MAX_SHARE,
  MIN_ATTACHED_CONTENT_EXTRACTION_SHARE,
  safeInputWindow,
} from './contextBudget';

// The caller's flat estimate of its own system stack, matching SYSTEM_PROMPT_RESERVE in
// ChatCompletionProcess. Spelled out rather than imported because services must not be a dependency of
// utils, and a drift between the two would show up as the ordering assertion below failing.
const SYSTEM_PROMPT_RESERVE = 4000;

// Llama 4 Maverick 17B and its siblings: the smallest text windows actually served.
const LLAMA_8K = { contextWindow: 8000, max_tokens: 2048, type: 'text' as const };
// The tightest text row in the catalog: half its window is reserved for output.
const GPT4_8K = { contextWindow: 8192, max_tokens: 4096, type: 'text' as const };
const CLAUDE_200K = { contextWindow: 200_000, max_tokens: 8192, type: 'text' as const };

const CHARS_PER_TOKEN = 3.5;

describe('effectiveContextWindow', () => {
  it('returns the catalog figure unchanged for a healthy media row', () => {
    expect(effectiveContextWindow({ contextWindow: 10_000, type: 'image' })).toBe(10_000);
  });

  it('falls back like an absent value for a media row whose window arrives as 0', () => {
    expect(effectiveContextWindow({ contextWindow: 0, type: 'video' })).toBe(200000);
  });

  it('keeps 0 literal for a text row', () => {
    expect(effectiveContextWindow({ contextWindow: 0, type: 'text' })).toBe(0);
  });

  it('returns the catalog figure unchanged for a healthy text row', () => {
    expect(effectiveContextWindow({ contextWindow: 128_000, type: 'text' })).toBe(128_000);
  });
});

describe('safeInputWindow', () => {
  it('reserves the requested output and the safety buffer', () => {
    expect(safeInputWindow(LLAMA_8K, 2048)).toBe(8000 - 2048 - 1000);
  });

  it('reserves no output for a media model, whose max_tokens is a prompt-length limit', () => {
    expect(safeInputWindow({ contextWindow: 10_000, max_tokens: 10_000, type: 'image' }, 10_000)).toBe(9000);
  });

  // A media row's contextWindow arriving as the literal 0 means "not applicable" (two provider
  // feeds report it that way on purpose), not a real zero-token budget. Before the fix this went
  // negative and the caller's empty-prompt guard threw on every image/video request once a
  // discovery run wrote that shape over an existing row.
  it('falls back like an absent value when a media row reports its window as 0', () => {
    expect(safeInputWindow({ contextWindow: 0, max_tokens: 10_000, type: 'image' }, 10_000)).toBe(200000 - 1000);
  });

  it('still goes negative on a TEXT row whose window arrives as 0, preserving the misconfiguration guard', () => {
    expect(safeInputWindow({ contextWindow: 0, max_tokens: 4096, type: 'text' }, 4096)).toBeLessThan(0);
  });

  it('caps the reservation at what the model can actually emit', () => {
    expect(safeInputWindow(LLAMA_8K, 999_999)).toBe(8000 - 2048 - 1000);
  });

  // The caller's empty-prompt guard reads a non-positive budget as a misconfigured model, so clamping
  // here would turn a loud failure into a silently empty prompt.
  it('goes negative rather than clamping on a model that reserves its whole window', () => {
    expect(safeInputWindow({ contextWindow: 8192, max_tokens: 8192, type: 'text' }, 8192)).toBeLessThan(0);
  });
});

describe('attachedContentExtractionBudget', () => {
  // The defect this function was extracted to fix. Flat, the 4000-token reserve left
  // (4952 - 4000) * 0.35 = 333, below the 15% emergency floor of 742, so every 8k model silently fell
  // back to the floor - about 2,597 characters, and a 4k character file was cut before assembly ran.
  it('stops a flat system reserve collapsing an 8k window onto its emergency floor', () => {
    const window = safeInputWindow(LLAMA_8K, 2048);
    const budget = attachedContentExtractionBudget(window, SYSTEM_PROMPT_RESERVE);

    expect(budget).toBeGreaterThan(Math.floor(window * MIN_ATTACHED_CONTENT_EXTRACTION_SHARE));
    // The size in the ticket, and the size the Guide for Testers asks a tester to attach.
    expect(budget * CHARS_PER_TOKEN).toBeGreaterThan(4000);
  });

  it('leaves a large window exactly where the unbounded formula had it', () => {
    const window = safeInputWindow(CLAUDE_200K, 8192);
    // 4000 is far below 30% of 190,808, so the bound is inert and this is the original arithmetic.
    const unbounded = Math.floor((window - SYSTEM_PROMPT_RESERVE) * ATTACHED_CONTENT_EXTRACTION_SHARE);

    expect(attachedContentExtractionBudget(window, SYSTEM_PROMPT_RESERVE)).toBe(unbounded);
  });

  it('never lets the reserve take more than its share of the window', () => {
    const window = safeInputWindow(GPT4_8K, 4096);
    const budget = attachedContentExtractionBudget(window, SYSTEM_PROMPT_RESERVE);

    // Whatever the flat reserve claims, at least the complement of its cap survives to be shared.
    expect(budget).toBeGreaterThanOrEqual(
      Math.floor(window * (1 - EXTRACTION_SYSTEM_RESERVE_MAX_SHARE) * ATTACHED_CONTENT_EXTRACTION_SHARE)
    );
  });

  // Zero is the dangerous value downstream: processFabFilesServer reads it as "no budget supplied" and
  // restores a flat per-file cap, so N files would be handed more content than the whole window.
  it('returns zero rather than a negative budget on a window that has no room at all', () => {
    expect(attachedContentExtractionBudget(-500, SYSTEM_PROMPT_RESERVE)).toBe(0);
  });
});

describe('extraction and assembly agree on every served window', () => {
  it.each([
    ['Llama 4 Maverick 8k', LLAMA_8K, 2048],
    ['GPT-4 8k', GPT4_8K, 4096],
    ['Claude 200k', CLAUDE_200K, 8192],
    [
      'Jurassic-2 after its output cap was halved',
      { contextWindow: 8192, max_tokens: 4096, type: 'text' as const },
      4096,
    ],
  ])('extracts something deliverable for %s', (_name, modelInfo, requestedMaxTokens) => {
    expect(attachedContentBudgetsAgree(safeInputWindow(modelInfo, requestedMaxTokens), SYSTEM_PROMPT_RESERVE)).toBe(
      true
    );
  });

  it('reports disagreement when a window is too small to extract anything', () => {
    expect(attachedContentBudgetsAgree(0, SYSTEM_PROMPT_RESERVE)).toBe(false);
  });

  // The property this ticket is actually about, and the one that was false before it: on the smallest
  // text windows served, BOTH stages have to clear the file or it is cut somewhere the user cannot see.
  // Extraction alone was the binding constraint, at ~2,597 characters against a 4,000 character file.
  it.each([
    ['Llama 4 Maverick 8k', LLAMA_8K, 2048],
    ['Llama 3 8B', { contextWindow: 8000, max_tokens: 2048, type: 'text' as const }, 2048],
  ])('carries a 4,000 character file through both stages on %s', (_name, modelInfo, requestedMaxTokens) => {
    const window = safeInputWindow(modelInfo, requestedMaxTokens);
    const fileTokens = Math.ceil(4000 / CHARS_PER_TOKEN);

    expect(attachedContentExtractionBudget(window, SYSTEM_PROMPT_RESERVE)).toBeGreaterThanOrEqual(fileTokens);
    expect(attachedContentAssemblyFloor(window)).toBeGreaterThanOrEqual(fileTokens);
  });

  // Above roughly 80k the percentage buffer overtakes the flat reserve and extraction reads more than
  // the floor guarantees. Pinned rather than fixed: closing it would mean cutting what large models
  // extract, which is a separate decision, and this asserts the shape so a later change is deliberate.
  it('reads more than the floor guarantees on a very large window, where the buffer outgrows the reserve', () => {
    const window = safeInputWindow(CLAUDE_200K, 8192);

    expect(attachedContentExtractionBudget(window, SYSTEM_PROMPT_RESERVE)).toBeGreaterThan(
      attachedContentAssemblyFloor(window)
    );
    // Still deliverable, which is the property that has to hold.
    expect(attachedContentBudgetsAgree(window, SYSTEM_PROMPT_RESERVE)).toBe(true);
  });
});
