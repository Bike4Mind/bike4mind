import { describe, it, expect } from 'vitest';
import { LOOP_TEMPLATES } from './LoopTemplates';

const template = (id: string) => LOOP_TEMPLATES.find(t => t.id === id)!;
const stage = (id: string, name: string) => template(id).stageConfig.find(c => c.stage === name)!;

describe('LOOP_TEMPLATES', () => {
  it('has the seven templates with unique ids', () => {
    expect(LOOP_TEMPLATES.map(t => t.id)).toEqual([
      'software-factory',
      'backlog-refinement',
      'white-box-review',
      'black-box-walk',
      'release-marketing',
      'overseer',
      'daily-standup',
    ]);
  });

  it.each(LOOP_TEMPLATES)('$id is a safe prefill', t => {
    for (const config of t.stageConfig) {
      expect(t.stages.slice(0, -1)).toContain(config.stage);
      if (config.runner === 'desktop') expect(config.mergePolicy).toBe('review');
    }
    // One run's admission price depends on the owner's model, so the owner sets the budget (see BUDGET_NOTE).
    expect(t.setupNotes.at(-1)).toMatch(/^Set a daily budget before you set it live/);
    for (const key of ['model', 'budgetCreditsPerDay', 'handoffTargets', 'triggers', 'oversees']) {
      expect(key in t).toBe(false);
    }
    expect(JSON.stringify(t)).toMatch(/^[\x20-\x7e]*$/);
  });

  it('runs the stages that need a browser, gh or a checkout on Desktop', () => {
    const desktop = LOOP_TEMPLATES.flatMap(t =>
      t.stageConfig.filter(c => c.runner === 'desktop').map(c => `${t.id}/${c.stage}`)
    );
    expect(desktop).toEqual([
      'software-factory/readiness',
      'software-factory/build',
      'software-factory/open-pr',
      'white-box-review/test',
      'black-box-walk/walk',
    ]);
  });

  it('gates the factory on repo readiness and docs-only work first', () => {
    const readiness = stage('software-factory', 'readiness').instructions!;
    expect(readiness).toMatch(/protected/);
    expect(readiness).toMatch(/CI status check/);
    expect(readiness).toMatch(/preview/);
    expect(readiness).toMatch(/do no other work/);
    expect(stage('software-factory', 'refine').instructions).toMatch(
      /docs-only.*first.*merged at least one pull request/s
    );
  });

  // A completed run already moves its ticket one stage on; a run moves it only to send it elsewhere.
  it('never tells a run to move its own ticket on, except the factory review send-back to build', () => {
    const moves = LOOP_TEMPLATES.flatMap(t =>
      t.stageConfig
        .filter(c => /\bmove (?:it|the ticket|this ticket|new tickets|feature work)\b/i.test(c.instructions ?? ''))
        .map(c => `${t.id}/${c.stage}`)
    );
    expect(moves).toEqual(['software-factory/review']);
    expect(stage('software-factory', 'review').instructions).toMatch(/move it back to build/);
    expect(stage('white-box-review', 'scan').instructions).toMatch(/stage "test"/);
    expect(stage('backlog-refinement', 'intake').instructions).toMatch(/stage "refine"/);
    expect(stage('black-box-walk', 'plan').instructions).toMatch(/stage "walk"/);
  });

  it('ends release marketing at an approve stage that blocks for the owner and never posts', () => {
    const marketing = template('release-marketing');
    expect(marketing.stages).toEqual(['draft', 'media', 'approve', 'done']);
    const approve = stage('release-marketing', 'approve').instructions!;
    expect(approve).toContain('Needs owner approval');
    expect(approve).toMatch(/Never post/);
    expect(JSON.stringify(LOOP_TEMPLATES)).not.toMatch(/slack/i);
  });
});
