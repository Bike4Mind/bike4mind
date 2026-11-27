import { describe, it, expect } from 'vitest';
import { settingsMap } from '../schemas/settings';

describe('ImageModerationEnabled setting', () => {
  it('exists and defaults to ON (legal-must, unlike prompt moderation)', () => {
    const setting = settingsMap.ImageModerationEnabled;
    expect(setting).toBeDefined();
    expect(setting.schema.parse(undefined)).toBe(true);
  });
});

describe('ImageModerationEscalationEmails setting', () => {
  it('sits beside the reviewer list and defaults to no recipients', () => {
    const setting = settingsMap.ImageModerationEscalationEmails;
    expect(setting.defaultValue).toEqual([]);
    expect(setting.category).toBe(settingsMap.ImageModerationReviewerEmails.category);
    expect(setting.schema.parse(['second@example.com'])).toEqual(['second@example.com']);
  });
});
