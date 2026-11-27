// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const ARTIFACT_ID = 'artifact_html_desktop-mods_1700000000000_1';

const h = vi.hoisted(() => ({
  artifactResult: {} as Record<string, unknown>,
  versionCalls: [] as Array<[string | null, number | null]>,
  versionError: null as Error | null,
}));

vi.mock('@tanstack/react-router', async () => {
  const ReactModule = await import('react');
  return {
    useParams: () => ({ id: ARTIFACT_ID }),
    Link: ReactModule.forwardRef<HTMLAnchorElement, { to: string } & Record<string, unknown>>(
      ({ to, ...rest }, ref) => <a ref={ref} href={to} {...rest} />
    ),
  };
});
vi.mock('@client/app/hooks/data/artifacts', () => ({
  useArtifact: () => h.artifactResult,
  useArtifactVersionContent: (artifactId: string | null, version: number | null) => {
    h.versionCalls.push([artifactId, version]);
    if (version && h.versionError) return { isPending: false, error: h.versionError };
    return version
      ? { data: { version, content: `<p>version ${version}</p>` }, isPending: false }
      : { isPending: false };
  },
}));
vi.mock('@client/app/components/artifacts/ArtifactVersionDropdown', () => ({
  ArtifactVersionDropdown: ({ onVersionChange }: { onVersionChange: (version: number) => void }) => (
    <div>
      <button data-testid="version-1-btn" onClick={() => onVersionChange(1)} />
      <button data-testid="version-2-btn" onClick={() => onVersionChange(2)} />
    </div>
  ),
}));
vi.mock('@client/app/components/artifacts/library/ArtifactContentView', () => ({
  ArtifactContentView: ({ content }: { content: string }) => <div data-testid="artifact-content">{content}</div>,
}));

import ArtifactPage from './$id';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ArtifactPage />
    </CssVarsProvider>
  );

const loaded = (artifact: Record<string, unknown>) => ({
  isPending: false,
  error: null,
  data: {
    access: 'owner',
    artifact: {
      id: ARTIFACT_ID,
      type: 'html',
      title: 'Desktop Mods',
      version: 2,
      updatedAt: '2026-11-01T00:00:00.000Z',
      ...artifact,
    },
    content: { version: 2, content: '<p>current</p>' },
  },
});

describe('ArtifactPage', () => {
  beforeEach(() => {
    h.versionCalls = [];
    h.versionError = null;
  });

  it('shows a spinner while the artifact loads', () => {
    h.artifactResult = { isPending: true, error: null, data: undefined };
    renderPage();
    expect(screen.getByTestId('artifact-page-loading')).toBeInTheDocument();
  });

  it('shows a not-found message when the artifact is missing or not readable', () => {
    h.artifactResult = { isPending: false, error: new Error('Access denied'), data: undefined };
    renderPage();
    expect(screen.getByTestId('artifact-page-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-content')).toBeNull();
  });

  it('opens a standalone artifact with its current content and no notebook link', () => {
    h.artifactResult = loaded({});
    renderPage();
    expect(screen.getByTestId('artifact-page-title')).toHaveTextContent('Desktop Mods');
    expect(screen.getByTestId('artifact-content')).toHaveTextContent('<p>current</p>');
    expect(screen.queryByTestId('artifact-page-notebook-link')).toBeNull();
    expect(screen.getByTestId('artifact-page-back-link')).toHaveAttribute('href', '/artifacts');
  });

  it('links a chat-created artifact back to its notebook', () => {
    h.artifactResult = loaded({ sessionId: 'session-1' });
    renderPage();
    expect(screen.getByTestId('artifact-page-notebook-link')).toHaveAttribute('href', '/notebooks/session-1');
  });

  it('switches to an older version and back to the current one', () => {
    h.artifactResult = loaded({});
    renderPage();

    fireEvent.click(screen.getByTestId('version-1-btn'));
    expect(screen.getByTestId('artifact-content')).toHaveTextContent('<p>version 1</p>');
    expect(h.versionCalls.at(-1)).toEqual([ARTIFACT_ID, 1]);

    fireEvent.click(screen.getByTestId('version-2-btn'));
    expect(screen.getByTestId('artifact-content')).toHaveTextContent('<p>current</p>');
    expect(h.versionCalls.at(-1)).toEqual([null, null]);
  });

  it('shows an error instead of an empty state when an older version fails to load', () => {
    h.artifactResult = loaded({});
    h.versionError = new Error('boom');
    renderPage();

    fireEvent.click(screen.getByTestId('version-1-btn'));
    expect(screen.getByTestId('artifact-page-version-error')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-page-no-content')).toBeNull();
  });
});
