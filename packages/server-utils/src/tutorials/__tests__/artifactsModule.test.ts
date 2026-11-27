import { describe, expect, it } from 'vitest';
import { CORE_TUTORIAL_CONTENT } from '../content';
import { CORE_TUTORIALS } from '../registry';

const content = CORE_TUTORIAL_CONTENT.find(t => t.intro.id === 'artifacts');
const ARTIFACT_OPEN_TAG = /<artifact\s[^>]*identifier="([^"]+)"[^>]*type="text\/html"[^>]*>/g;

function artifactIdentifiers(reply: string): string[] {
  return Array.from(reply.matchAll(ARTIFACT_OPEN_TAG), match => match[1]);
}

describe('the artifacts tutorial', () => {
  it('is listed publicly on the "different" track', () => {
    const entry = CORE_TUTORIALS.find(t => t.id === 'artifacts');
    expect(entry).toMatchObject({ visibility: { public: true }, enabled: true, track: 'different', order: 40 });
    expect(content?.enabled).toBe(true);
  });

  it('walks ask, open, revise and a bridge finale', () => {
    expect(content?.steps.map(step => [step.id, step.type, step.turn])).toEqual([
      ['artifacts-ask', 'prompt', 0],
      ['artifacts-open', 'artifact-open', undefined],
      ['artifacts-revise', 'prompt', 1],
      ['artifacts-done', 'bridge', undefined],
    ]);
  });

  it('records one html artifact per turn, under the same identifier', () => {
    const replies = content?.transcript.map(turn => turn.reply) ?? [];
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(artifactIdentifiers(reply)).toEqual(['plant-swap-flyer']);
      expect(reply).toContain('</artifact>');
    }
  });

  it('carries no ids, outside links or contact details from the recording', () => {
    const recorded = JSON.stringify(content?.transcript);
    expect(recorded).not.toMatch(/[0-9a-f]{24}/);
    // The flyer's own stylesheet import is the one link the model wrote.
    const hosts = new Set(Array.from(recorded.matchAll(/https?:\/\/([^/'"\\]+)/g), match => match[1]));
    expect([...hosts]).toEqual(['fonts.googleapis.com']);
    expect(recorded).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
  });

  it('points the open step at the expand button an html artifact card renders', () => {
    // Must stay in sync with testIdPrefix="html" in apps/client/app/components/GenAI/HtmlArtifactPreviewCard.tsx.
    expect(content?.steps.find(step => step.id === 'artifacts-open')?.anchor).toBe('html-artifact-expand-btn');
  });
});
