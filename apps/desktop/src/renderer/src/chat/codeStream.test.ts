import { describe, expect, it } from 'vitest';
import { pendingCodePhrase, presentReply } from './codeStream';

describe('presentReply', () => {
  it('leaves ordinary prose alone', () => {
    expect(presentReply('Here is the plan.', true)).toEqual({
      text: 'Here is the plan.',
      pending: null,
      unfinishedArtifact: null,
    });
  });

  it('hides an artifact that is still being written and names it', () => {
    const text =
      'I will build it.\n\n<artifact identifier="dash" type="application/vnd.ant.code" title="Dashboard">\nimport {';
    expect(presentReply(text, true)).toEqual({
      text: 'I will build it.',
      pending: { kind: 'artifact', title: 'Dashboard' },
      unfinishedArtifact: null,
    });
  });

  it('hides an artifact whose opening tag has not finished arriving', () => {
    expect(presentReply('Building.\n<artifact identifier="d" ty', true).pending).toEqual({ kind: 'artifact' });
    expect(presentReply('Building.\n<arti', true)).toMatchObject({ text: 'Building.\n', pending: null });
  });

  it('drops a finished artifact from the streaming text, since its card replaces it', () => {
    const text = 'Before.\n<artifact type="text/html" title="Page"><b>hi</b></artifact>\nAfter.';
    expect(presentReply(text, true).text).toBe('Before.\n\nAfter.');
  });

  it('hides a code fence that is still open, and shows it once it closes', () => {
    const open = 'Change this:\n\n```tsx\nexport function Dashboard() {\n  return (';
    expect(presentReply(open, true)).toEqual({
      text: 'Change this:',
      pending: { kind: 'code', language: 'tsx' },
      unfinishedArtifact: null,
    });

    const closed = `${open}\n}\n\`\`\`\nDone.`;
    expect(presentReply(closed, true)).toEqual({ text: closed, pending: null, unfinishedArtifact: null });
  });

  it('does not treat a fence line with a language as the close of an open block', () => {
    const text = '````md\n```ts\nconst a = 1;\n```\n';
    expect(presentReply(text, true).pending).toEqual({ kind: 'code', language: 'md' });
  });

  it('reports an artifact a settled reply was cut off inside, instead of dumping its source', () => {
    const text =
      'Here it is.\n<artifact identifier="dash" title="Dashboard Screen">\nimport { useState } from "react";';
    expect(presentReply(text, false)).toEqual({
      text: 'Here it is.',
      pending: null,
      unfinishedArtifact: 'Dashboard Screen',
    });
  });

  it('leaves a settled reply that ends in an open fence as it is', () => {
    const text = 'Partial:\n```ts\nconst a = 1;';
    expect(presentReply(text, false)).toEqual({ text, pending: null, unfinishedArtifact: null });
  });
});

describe('pendingCodePhrase', () => {
  it('names the artifact when it has a title', () => {
    expect(pendingCodePhrase({ kind: 'artifact', title: 'Dashboard' })).toBe('Creating an artifact: Dashboard...');
    expect(pendingCodePhrase({ kind: 'artifact' })).toBe('Creating an artifact...');
    expect(pendingCodePhrase({ kind: 'code', language: 'tsx' })).toBe('Writing code...');
  });
});
