import { describe, expect, it } from 'vitest';
import { csvCells, validateSheet } from '../../validate';
import { projectsModule } from './module';
import { PROJECTS_PROMPT, PROJECTS_STEPS } from './steps';
import transcript from './transcript.json';

const MAX_CARD_CHARS = 170;

describe('the projects tutorial', () => {
  it('keeps every coach card short and calm', () => {
    for (const step of PROJECTS_STEPS) {
      for (const text of [step.title, step.body, step.doneBody].filter((t): t is string => t !== undefined)) {
        expect(text.length, step.id).toBeLessThanOrEqual(MAX_CARD_CHARS);
        expect(text, step.id).not.toContain('!');
      }
    }
  });

  it('opens with the one recorded prompt, asked from a single prompt step', () => {
    expect(transcript).toHaveLength(1);
    expect(projectsModule.openingPrompt).toBe(transcript[0].prompt);
    const prompts = PROJECTS_STEPS.filter(step => step.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ turn: 0, prompt: PROJECTS_PROMPT });
  });

  // The file reaches the chat through the project, not as a notebook attachment.
  it('seeds a valid sheet that the transcript does not attach', () => {
    expect(validateSheet(projectsModule.sheet!)).toEqual([]);
    expect(transcript[0]).not.toHaveProperty('attachSheet');
    expect(PROJECTS_STEPS.some(step => step.type === 'attach')).toBe(false);
  });

  // The reply was recorded against this exact sheet; a changed row would leave it answering a different file.
  it('has a recorded answer that names every week-2 task and its owner', () => {
    const week2 = projectsModule
      .sheet!.csv.trim()
      .split('\n')
      .slice(1)
      .map(line => csvCells(line))
      .filter(([, , week]) => week === '2');
    expect(week2.length).toBeGreaterThan(0);
    const reply = transcript[0].reply.toLowerCase();
    for (const [task, owner] of week2) {
      expect(reply).toContain(task.toLowerCase());
      expect(reply).toContain(owner.toLowerCase());
    }
  });

  it('keeps inviting teammates out of the required steps', () => {
    for (const step of PROJECTS_STEPS.slice(0, -1)) expect(step.body, step.id).not.toMatch(/invite|Members/i);
  });

  it('ends on a finale that points at Projects and the Members tab', () => {
    const finale = PROJECTS_STEPS.at(-1)!;
    expect(finale.type).toBe('bridge');
    expect(finale.body).toMatch(/Projects/);
    expect(finale.body).toMatch(/Members/);
  });
});
