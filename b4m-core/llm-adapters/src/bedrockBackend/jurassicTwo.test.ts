import { describe, it, expect } from 'vitest';
import JurassicTwoBedrockBackend from './jurassicTwo';

describe('JurassicTwoBedrockBackend', () => {
  // Both Jurassic-2 ids are end-of-life on Bedrock, so listing them offers a model that cannot run.
  it('lists no models', async () => {
    await expect(new JurassicTwoBedrockBackend().getModelInfo()).resolves.toEqual([]);
  });
});
