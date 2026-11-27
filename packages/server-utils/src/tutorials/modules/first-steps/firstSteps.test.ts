import { describe, expect, it } from 'vitest';
import { csvCells, validateSheet } from '../../validate';
import { firstStepsModule } from './module';
import { FIRST_STEPS_STEPS } from './steps';
import transcript from './transcript.json';

const MAX_CARD_CHARS = 170;

describe('the first-steps tutorial', () => {
  it('keeps every coach card short and calm', () => {
    for (const step of FIRST_STEPS_STEPS) {
      for (const text of [step.title, step.body, step.doneBody].filter((t): t is string => t !== undefined)) {
        expect(text.length, step.id).toBeLessThanOrEqual(MAX_CARD_CHARS);
        expect(text, step.id).not.toContain('!');
      }
    }
  });

  it('opens with the first recorded prompt', () => {
    expect(firstStepsModule.openingPrompt).toBe(transcript[0].prompt);
  });

  it('asks the user to attach the sheet it seeds, right before the turn that reads it', () => {
    const sheet = firstStepsModule.sheet;
    expect(sheet).toBeDefined();
    expect(validateSheet(sheet!)).toEqual([]);

    const attachIndex = FIRST_STEPS_STEPS.findIndex(s => s.type === 'attach');
    expect(FIRST_STEPS_STEPS[attachIndex].params).toEqual({ fileName: sheet!.name });
    const askFile = FIRST_STEPS_STEPS[attachIndex + 1];
    expect(askFile.type).toBe('prompt');
    expect(transcript[askFile.turn!]).toMatchObject({ attachSheet: true });
  });

  // The reply was recorded against this exact sheet; a changed figure would leave it answering a different file.
  it('has a recorded answer that names the three largest costs after rent', () => {
    const rows = firstStepsModule
      .sheet!.csv.trim()
      .split('\n')
      .slice(1)
      .map(line => csvCells(line))
      .map(([item, cost]) => ({ item, cost: Number(cost) }))
      .filter(row => row.item !== 'Rent')
      .sort((a, b) => b.cost - a.cost);
    const reply = transcript.find(t => 'attachSheet' in t)!.reply;
    for (const { item, cost } of rows.slice(0, 3)) {
      expect(reply).toContain(item);
      expect(reply).toContain(`$${cost}`);
    }
  });

  it('ends on a finale that says where to go next', () => {
    const finale = FIRST_STEPS_STEPS.at(-1)!;
    expect(finale.type).toBe('bridge');
    expect(finale.body).toMatch(/New Chat/);
    expect(finale.body).toMatch(/Tutorials/);
  });
});
