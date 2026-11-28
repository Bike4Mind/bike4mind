import { describe, expect, it } from 'vitest';
import { importHistoryModule } from './module';
import { IMPORT_HISTORY_PROMPT, IMPORT_HISTORY_STEPS } from './steps';
import transcript from './transcript.json';

const MAX_CARD_CHARS = 170;

describe('the import-history tutorial', () => {
  it('keeps every coach card short and calm', () => {
    for (const step of IMPORT_HISTORY_STEPS) {
      for (const text of [step.title, step.body, step.doneBody].filter((t): t is string => t !== undefined)) {
        expect(text.length, step.id).toBeLessThanOrEqual(MAX_CARD_CHARS);
        expect(text, step.id).not.toContain('!');
      }
    }
  });

  it('opens with the one recorded prompt, asked from the first step', () => {
    expect(transcript).toHaveLength(1);
    expect(importHistoryModule.openingPrompt).toBe(transcript[0].prompt);
    const prompts = IMPORT_HISTORY_STEPS.filter(step => step.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(IMPORT_HISTORY_STEPS[0]).toMatchObject({ type: 'prompt', turn: 0, prompt: IMPORT_HISTORY_PROMPT });
  });

  // The export is made in another app, so a learner without one must still reach the end.
  it('never waits on a file the learner may not have', () => {
    expect(importHistoryModule.sheet).toBeUndefined();
    expect(transcript[0]).not.toHaveProperty('attachSheet');
    for (const step of IMPORT_HISTORY_STEPS.slice(1)) expect(['point', 'bridge'], step.id).toContain(step.type);
  });

  it('tells a learner without an export how to carry on at the upload step', () => {
    const upload = IMPORT_HISTORY_STEPS.find(step => step.id === 'import-history-upload')!;
    expect(upload.body).toMatch(/No file yet\?/);
    expect(upload.anchor).toBeUndefined();
    expect(upload.avoid).toBe('[data-testid="import-history-submit-btn"]');
  });

  it('has a recorded answer that covers both exports and the .zip the importer takes', () => {
    const reply = transcript[0].reply;
    expect(reply).toMatch(/ChatGPT/);
    expect(reply).toMatch(/Claude/);
    expect(reply).toMatch(/\.zip/);
    expect(reply).toMatch(/Import LLM History/);
  });

  it('ends on a finale that says where to import later', () => {
    const finale = IMPORT_HISTORY_STEPS.at(-1)!;
    expect(finale).toMatchObject({ type: 'bridge', action: 'Done' });
    expect(finale.body).toMatch(/Settings/);
  });
});
