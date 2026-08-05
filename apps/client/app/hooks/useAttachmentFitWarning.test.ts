import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { deriveAttachmentFitWarning, type DryRunFile } from './useAttachmentFitWarning';

const file = (over: Partial<DryRunFile> = {}): DryRunFile => ({
  id: 'f1',
  fileName: 'budget.csv',
  isImage: false,
  extractedChars: 4000,
  estimatedTokens: 1143,
  measured: 'extracted',
  deliveredFraction: 1,
  ...over,
});

describe('deriveAttachmentFitWarning', () => {
  // The half that matters. A warning that fires on a file which would have arrived whole teaches
  // users to ignore the banner, and after the budget fix a few-thousand-character file DOES arrive
  // whole on an 8k model - so the healthy path has to be silent.
  it('says nothing when the file fits', () => {
    expect(deriveAttachmentFitWarning([file({ deliveredFraction: 1 })], 1)).toBeNull();
  });

  it('says nothing when the shortfall is a rounding artifact', () => {
    expect(deriveAttachmentFitWarning([file({ deliveredFraction: 0.999 })], 1)).toBeNull();
  });

  it('says nothing when there are no files at all', () => {
    expect(deriveAttachmentFitWarning([], 0)).toBeNull();
    expect(deriveAttachmentFitWarning(undefined, undefined)).toBeNull();
  });

  it('warns, naming the file and the share that will arrive', () => {
    const warning = deriveAttachmentFitWarning([file({ deliveredFraction: 0.62, fileName: 'big.csv' })], 1);

    expect(warning).toEqual({ fileName: 'big.csv', deliveredPercent: 62, measured: 'extracted', siblingCount: 0 });
  });

  // Floor, not round: 0.996 must not render as "100% will reach the model" directly above a warning
  // that the file is too large.
  it('floors the percentage so it can never read as complete', () => {
    const warning = deriveAttachmentFitWarning([file({ deliveredFraction: 0.9949 })], 1);

    expect(warning?.deliveredPercent).toBe(99);
  });

  it('names the worst-fitting file when several are attached', () => {
    const warning = deriveAttachmentFitWarning(
      [
        file({ id: 'a', fileName: 'small.csv', deliveredFraction: 0.9 }),
        file({ id: 'b', fileName: 'huge.csv', deliveredFraction: 0.2 }),
        file({ id: 'c', fileName: 'mid.csv', deliveredFraction: 0.5 }),
      ],
      3
    );

    expect(warning?.fileName).toBe('huge.csv');
    // Two siblings, so the actionable advice is to send fewer files rather than change model.
    expect(warning?.siblingCount).toBe(2);
  });

  // Images do not draw on the text budget, so one can never be the reason to warn - and a large image
  // alongside a fitting CSV must not produce a banner.
  it('ignores images entirely', () => {
    expect(deriveAttachmentFitWarning([file({ isImage: true, deliveredFraction: 0.01 })], 0)).toBeNull();
    expect(
      deriveAttachmentFitWarning([file({ isImage: true, deliveredFraction: 0.01 }), file({ deliveredFraction: 1 })], 1)
    ).toBeNull();
  });

  // The route refuses to read a file until moderation clears it, so its size is genuinely unknown.
  // Warning about it would mean inventing a number, and the route reports full delivery for exactly
  // that reason - so this must hold even if that reporting later changes.
  it('says nothing about a file still awaiting moderation', () => {
    expect(deriveAttachmentFitWarning([file({ measured: 'pending', deliveredFraction: 1 })], 1)).toBeNull();
    // Belt and braces: excluded by measurement state, not merely by the fraction it happens to carry.
    expect(deriveAttachmentFitWarning([file({ measured: 'pending', deliveredFraction: 0.1 })], 1)).toBeNull();
  });

  it('still warns about a measured sibling when another file is awaiting moderation', () => {
    const warning = deriveAttachmentFitWarning(
      [
        file({ id: 'a', measured: 'pending', deliveredFraction: 0.1 }),
        file({ id: 'b', fileName: 'big.csv', deliveredFraction: 0.3 }),
      ],
      2
    );

    expect(warning?.fileName).toBe('big.csv');
  });

  // A byte-size estimate is only a fair proxy for plain text, so the caller has to be able to hedge.
  it('passes through which figure the measurement came from', () => {
    const warning = deriveAttachmentFitWarning([file({ deliveredFraction: 0.4, measured: 'fileSize' })], 1);

    expect(warning?.measured).toBe('fileSize');
  });
});

// Source-level guard, in the spirit of the repo's fabFileModerationGate test. This shipped once with
// bare `axios.post`, which sends no bearer token: the route 401s, react-query is configured retry:false
// so `data` stays undefined, and the hook returns null - indistinguishable from "the file fits". Every
// unit test here still passed, because they exercise the decision function and not the transport. Only
// driving the real UI caught it, so this pins the transport instead.
describe('transport', () => {
  const source = fs.readFileSync(path.join(__dirname, 'useAttachmentFitWarning.ts'), 'utf8');

  it('calls the route through the authenticated api client, never bare axios', () => {
    expect(source).toMatch(/from '@client\/app\/contexts\/ApiContext'/);
    expect(source).toMatch(/api\.post</);
    expect(source, 'bare axios sends no bearer token; the route 401s and the banner goes silent').not.toMatch(
      /from 'axios'/
    );
  });
});
