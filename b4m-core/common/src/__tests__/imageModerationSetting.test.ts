import { describe, it, expect } from 'vitest';
import { settingsMap } from '../schemas/settings';

describe('ImageModerationEnabled setting (#9776 Q2a)', () => {
  it('exists and defaults to ON (legal-must, unlike prompt moderation)', () => {
    const setting = settingsMap.ImageModerationEnabled;
    expect(setting).toBeDefined();
    expect(setting.schema.parse(undefined)).toBe(true);
  });
});
