import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getThemeConfig } from '../../utils/themes';
import { parseArtifactsWithFallback } from '../../utils/artifactParser';
import { classifyGeneratedFiles, createCodeComponent, ReplyCompleteContext } from './PromptReplies';

describe('classifyGeneratedFiles', () => {
  it('routes each generated file to exactly one bucket (image grid / audio player / download chip)', () => {
    const { images, audio, others } = classifyGeneratedFiles(['a.png', 'b.mp3', 'c.xlsx']);
    expect(images).toEqual(['a.png']);
    expect(audio).toEqual(['b.mp3']);
    expect(others).toEqual(['c.xlsx']);
  });

  it('partitions with no loss and no double-counting across a mixed batch', () => {
    const files = ['x.jpeg', 'y.wav', 'z.pdf', 'w.svg', 'v.flac'];
    const { images, audio, others } = classifyGeneratedFiles(files);
    // Every input lands in exactly one bucket - the three buckets reconstruct the input set.
    expect([...images, ...audio, ...others].sort()).toEqual([...files].sort());
    expect(images).toEqual(['x.jpeg', 'w.svg']);
    expect(audio).toEqual(['y.wav', 'v.flac']);
    expect(others).toEqual(['z.pdf']);
  });

  it('treats .webm/.ogg as download chips, not audio (predominantly video containers)', () => {
    const { audio, others } = classifyGeneratedFiles(['clip.webm', 'track.ogg']);
    expect(audio).toEqual([]);
    expect(others).toEqual(['clip.webm', 'track.ogg']);
  });

  it('matches extensions case-insensitively', () => {
    const { images, audio } = classifyGeneratedFiles(['A.PNG', 'B.MP3']);
    expect(images).toEqual(['A.PNG']);
    expect(audio).toEqual(['B.MP3']);
  });

  it('returns empty buckets for an empty input', () => {
    expect(classifyGeneratedFiles([])).toEqual({ images: [], audio: [], others: [] });
  });
});

describe('server-marked tool output in a reply', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });

  it('renders the marked block as a code block, not an artifact card', () => {
    const doc = '<!DOCTYPE html>\n<html><body><h1>Fetched page heading</h1></body></html>';
    const reply = `Here is what the page returned:\n\n~~~html b4m-tool-output\n${doc}\n~~~\n\nDone.`;
    const { artifacts, cleanedContent } = parseArtifactsWithFallback(reply);
    expect(artifacts).toHaveLength(0);

    const { container } = render(
      <CssVarsProvider theme={appTheme}>
        <ReplyCompleteContext.Provider value>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: createCodeComponent() }}>
            {cleanedContent}
          </ReactMarkdown>
        </ReplyCompleteContext.Provider>
      </CssVarsProvider>
    );

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('<h1>Fetched page heading</h1>');
    expect(container.querySelector('h1')).toBeNull();
  });
});
