import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OPENAI_PRICING_URL,
  openAiModelDocUrl,
  parseOpenAiLongContextBreakpoint,
  parseOpenAiModelCell,
  parseOpenAiPricing,
  parseTokenCount,
  type OpenAiPriceRow,
} from './openaiDocs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'openai');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const pricingMarkdown = read('pricing.md');
const parsed = parseOpenAiPricing(pricingMarkdown);
const rows = parsed.ok
  ? new Map(parsed.rows.map(row => [row.modelId, row] as const))
  : new Map<string, OpenAiPriceRow>();

describe('openai pricing parser', () => {
  it('reads the Standard table', () => {
    expect(parsed.ok).toBe(true);
    expect(rows.size).toBeGreaterThan(20);
  });

  it('reads the Standard table and NOT the Batch, Flex or Fast ones', () => {
    // Batch and Flex price luna at $0.10/$0.60 and Fast at $0.40/$2.40, all under
    // headers byte-identical to Standard's. Batch being exactly half of Standard
    // is why a fall-through would halve every OpenAI price with no signal at all.
    expect(rows.get('gpt-5.6-luna')).toMatchObject({ inputPerMTok: 0.2, outputPerMTok: 1.2 });
  });

  it('reads the cache rates the table publishes', () => {
    expect(rows.get('gpt-5.6-luna')).toMatchObject({ cacheReadPerMTok: 0.02, cacheWritePerMTok: 0.25 });
  });

  it('reads the long-context rates as their own group', () => {
    expect(rows.get('gpt-5.6-luna')?.longContext).toEqual({
      inputPerMTok: 0.4,
      outputPerMTok: 1.8,
      cacheReadPerMTok: 0.04,
      cacheWritePerMTok: 0.5,
    });
  });

  it('leaves an unpublished rate absent rather than zero', () => {
    // A stored 0 reads as free at settlement; absent means "carry the rate in
    // force forward", which is the true statement about a "-" cell.
    const flat = rows.get('gpt-5.4-nano');
    expect(flat).toMatchObject({ inputPerMTok: 0.2, outputPerMTok: 1.25, cacheReadPerMTok: 0.02 });
    expect(flat).not.toHaveProperty('cacheWritePerMTok');
    expect(flat).not.toHaveProperty('longContext');
  });

  it('keeps the long-context group only when both of its required rates are there', () => {
    // gpt-5.5-pro publishes long-context input and output but no cache rates.
    expect(rows.get('gpt-5.5-pro')?.longContext).toEqual({ inputPerMTok: 60, outputPerMTok: 270 });
    // gpt-5.4-mini publishes no long-context rates at all.
    expect(rows.get('gpt-5.4-mini')).not.toHaveProperty('longContext');
  });

  it('takes the breakpoint off the model cell when the row states it inline', () => {
    expect(rows.get('gpt-5.5')?.longContextAboveTokens).toBe(272_000);
    // The newer families dropped the annotation; their own page carries it.
    expect(rows.get('gpt-5.6-luna')).not.toHaveProperty('longContextAboveTokens');
  });

  it('keeps a dated model id verbatim rather than reshaping it', () => {
    expect(rows.has('gpt-4o-2024-05-13')).toBe(true);
    expect(rows.has('gpt-4-0613')).toBe(true);
  });

  it('fails on a restructured page rather than returning a partial table', () => {
    expect(parseOpenAiPricing(read('parser-broke-pricing.md')).ok).toBe(false);
  });

  it('fails when the page carries no table at all', () => {
    expect(parseOpenAiPricing('# Pricing\n\nSee the console.\n').ok).toBe(false);
  });

  it('fails rather than reading a table whose Standard heading is gone', () => {
    const renamed = pricingMarkdown.replace('### Standard pricing data', '### Pay-as-you-go data');
    expect(parseOpenAiPricing(renamed).ok).toBe(false);
  });

  it('fails when the Standard table yields zero usable rows', () => {
    expect(parseOpenAiPricing('### Standard pricing data\n\n| Model | Short context input |\n| --- | --- |\n').ok).toBe(
      false
    );
  });
});

describe('openai model cell', () => {
  it('strips the annotations the page hangs off a name', () => {
    expect(parseOpenAiModelCell('gpt-5.5 (<272K context length)')).toEqual({
      modelId: 'gpt-5.5',
      longContextAboveTokens: 272_000,
    });
    expect(parseOpenAiModelCell('gpt-4.1-nano')).toEqual({ modelId: 'gpt-4.1-nano' });
  });

  it('refuses a cell that is prose rather than a model id', () => {
    expect(parseOpenAiModelCell('Fine-tuning is billed separately')).toBeNull();
    expect(parseOpenAiModelCell('')).toBeNull();
    expect(parseOpenAiModelCell('| total |')).toBeNull();
  });
});

describe('openai long-context breakpoint', () => {
  it('reads the plain bullet', () => {
    expect(parseOpenAiLongContextBreakpoint(read('model-gpt-5.6-luna.md'))).toBe(272_000);
    expect(parseOpenAiLongContextBreakpoint(read('model-gpt-5.6-sol.md'))).toBe(272_000);
  });

  it('reads the clause buried in a longer sentence', () => {
    // "For models with a 1.05M context window (...), prompts with >272K input
    // tokens are ..." - anchoring on the line would take 1.05M, the wrong number.
    expect(parseOpenAiLongContextBreakpoint(read('model-gpt-5.4.md'))).toBe(272_000);
  });

  it('is undefined for a model with no long-context pricing', () => {
    expect(parseOpenAiLongContextBreakpoint(read('model-gpt-5.4-mini.md'))).toBeUndefined();
  });
});

describe('openai token counts', () => {
  it('scales the suffixes', () => {
    expect(parseTokenCount('272K')).toBe(272_000);
    expect(parseTokenCount('1.05M')).toBe(1_050_000);
    expect(parseTokenCount('272,000')).toBe(272_000);
    expect(parseTokenCount(' 400 k ')).toBe(400_000);
  });

  it('refuses anything that is not a positive whole token count', () => {
    expect(parseTokenCount('')).toBeUndefined();
    expect(parseTokenCount('0K')).toBeUndefined();
    expect(parseTokenCount('none')).toBeUndefined();
    expect(parseTokenCount('0.5')).toBeUndefined();
  });
});

describe('openai docs urls', () => {
  it('are the markdown twins of the docs pages', () => {
    expect(OPENAI_PRICING_URL).toBe('https://platform.openai.com/docs/pricing.md');
    expect(openAiModelDocUrl('gpt-5.6-luna')).toBe('https://platform.openai.com/docs/models/gpt-5.6-luna.md');
  });

  it('escapes an id rather than letting it shape the path', () => {
    expect(openAiModelDocUrl('../../secrets')).not.toContain('../');
  });
});
