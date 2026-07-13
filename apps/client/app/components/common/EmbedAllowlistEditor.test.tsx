import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), patch: vi.fn().mockResolvedValue({ data: {} }) },
}));
import { api } from '@client/app/contexts/ApiContext';
import { EmbedAllowlistEditor } from './EmbedAllowlistEditor';

const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;
const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderEditor = (props: Partial<React.ComponentProps<typeof EmbedAllowlistEditor>> = {}) => {
  apiPatch.mockClear().mockResolvedValue({ data: {} });
  render(
    <Wrapper>
      <EmbedAllowlistEditor
        publicId="pub-1"
        shareUrl="https://app.x/p/u/u1/s"
        title="My Artifact"
        isOpenPublic
        initialOrigins={props.initialOrigins ?? []}
        {...props}
      />
    </Wrapper>
  );
};

describe('EmbedAllowlistEditor', () => {
  it('renders nothing when the artifact is not open-public', () => {
    render(
      <Wrapper>
        <EmbedAllowlistEditor publicId="pub-1" shareUrl="u" title="t" isOpenPublic={false} initialOrigins={[]} />
      </Wrapper>
    );
    expect(screen.queryByTestId('publish-share-embed-section')).toBeNull();
  });

  it('adds a valid origin, PATCHing the allowlist and showing the snippet', async () => {
    renderEditor();
    fireEvent.change(screen.getByTestId('publish-share-embed-input'), { target: { value: 'https://erikbethke.com' } });
    fireEvent.click(screen.getByTestId('publish-share-embed-add'));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        embedOrigins: ['https://erikbethke.com'],
      })
    );
    await screen.findByTestId('publish-share-embed-chip-https://erikbethke.com');
    expect((screen.getByTestId('publish-share-embed-snippet') as HTMLTextAreaElement).value).toContain(
      'https://app.x/p/u/u1/s?embed=1'
    );
  });

  it('uplevels a casual bare host to a full https origin', async () => {
    renderEditor();
    fireEvent.change(screen.getByTestId('publish-share-embed-input'), { target: { value: 'erikbethke.com' } });
    fireEvent.click(screen.getByTestId('publish-share-embed-add'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        embedOrigins: ['https://erikbethke.com'],
      })
    );
  });

  it('reduces a pasted full URL (with path) to its origin', async () => {
    renderEditor();
    fireEvent.change(screen.getByTestId('publish-share-embed-input'), {
      target: { value: 'https://erikbethke.com/blog/some-post' },
    });
    fireEvent.click(screen.getByTestId('publish-share-embed-add'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', {
        embedOrigins: ['https://erikbethke.com'],
      })
    );
  });

  it('rejects a non-https origin without a PATCH', () => {
    renderEditor();
    fireEvent.change(screen.getByTestId('publish-share-embed-input'), { target: { value: 'http://insecure.com' } });
    fireEvent.click(screen.getByTestId('publish-share-embed-add'));
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('seeds from initialOrigins and removes one (PATCHing the reduced list)', async () => {
    renderEditor({ initialOrigins: ['https://erikbethke.com'] });
    await screen.findByTestId('publish-share-embed-chip-https://erikbethke.com');
    fireEvent.click(screen.getByTestId('publish-share-embed-remove-https://erikbethke.com'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { embedOrigins: [] }));
  });

  it('uses a custom testid prefix', () => {
    render(
      <Wrapper>
        <EmbedAllowlistEditor
          publicId="pub-1"
          shareUrl="u"
          title="t"
          isOpenPublic
          initialOrigins={[]}
          testIdPrefix="manage-embed"
        />
      </Wrapper>
    );
    expect(screen.getByTestId('manage-embed-section')).not.toBeNull();
  });
});
