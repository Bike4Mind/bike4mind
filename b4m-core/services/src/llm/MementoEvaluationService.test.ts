import { describe, expect, it } from 'vitest';
import { buildMementoExtractionPrompt } from './MementoEvaluationService';

/**
 * The extraction prompt is the highest-leverage text in the memory system, and its quality is invisible
 * from anywhere else: a memento written as narration retrieves EXACTLY as well as one written as a fact.
 * That is measured, not assumed - filler ("The user shared that...") appears in every memento, so it is
 * common-mode in the embedding and cancels in the cosine. Stripping it moved hit@8 by 1.8 points and
 * MRR by 0.003. No retrieval metric will ever catch this going wrong.
 *
 * What it costs is the thing the user actually experiences. Blind-judged over 18 real questions against a
 * real 182-fact corpus, answers built from narration-style memories lost 13-1 to the same memories with
 * the narration stripped - "repetitive", "awkwardly inflated", "preachy" - because the assistant is
 * reading a transcript back under a heading that says KNOWN FACTS ABOUT THE USER.
 */

// The fact-style guidance is gated behind `factStyle` (V2 only); with V2 off the prompt is main's.
const prompt = buildMementoExtractionPrompt('I live in Austin', { factStyle: true });

describe('memento extraction prompt', () => {
  it('carries the user prompt it was asked to evaluate', () => {
    expect(prompt).toContain('I live in Austin');
  });

  it('omits the fact-style guidance in the default (V1 flag-off) prompt', () => {
    // V1 (flag-off) must get main's prompt byte-for-byte; the fact-style block is V2-only.
    const v1Prompt = buildMementoExtractionPrompt('I live in Austin');
    expect(v1Prompt).not.toMatch(/HOW TO WRITE THE SUMMARY/);
    expect(v1Prompt).not.toMatch(/do not shred one memento/i);
    expect(v1Prompt).toContain('Brief one-sentence summary of this specific piece of information');
  });

  it('forbids narrating the conversation instead of stating the fact', () => {
    // 58% of the legacy corpus described what the ASSISTANT did ("The assistant correctly informs the
    // user that an octagon has eight sides") - stored, and injected, as a known fact about the user.
    expect(prompt).toMatch(/NEVER write/);
    expect(prompt).toMatch(/The user said\/shared\/asked\/mentioned/);
    expect(prompt).toMatch(/the assistant is not a fact about the user/i);
  });

  it('forbids hedging - state the fact or drop it', () => {
    // "conducts discovery calls, suggesting a role in sales" is a guess wearing a fact's clothes, and it
    // also sits measurably further from a plain question than "works in sales" does.
    expect(prompt).toMatch(/hedging\. State it or drop it/i);
  });

  it('tells the model to keep a fact whole rather than shred it into fragments', () => {
    // Over-atomizing is the opposite failure and it is NOT free: splitting a real corpus into 2.8x more,
    // narrower facts dropped hit@8 from 98.8% to 83.2% on broad questions, because each fragment carries
    // only a slice of what the user was actually asking about.
    expect(prompt).toMatch(/do not shred one memento into many fragments/i);
  });

  it('still refuses to store a knowledge question as a memory', () => {
    expect(prompt).toMatch(/DO NOT mark as personal/i);
    expect(prompt).toMatch(/What is React/);
  });
});
