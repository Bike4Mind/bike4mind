import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { KnowledgeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { IFabFileDocument } from '@bike4mind/common';

const { apiGet, unpdfLoadedSpy, getDocumentProxy, extractText } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  unpdfLoadedSpy: vi.fn(),
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: apiGet },
}));

// The spy runs inside the factory so it only fires when vitest actually evaluates this module -
// i.e. when something really does `import('unpdf')`, not merely when fabFileUtils is imported.
vi.mock('unpdf', () => {
  unpdfLoadedSpy();
  return { getDocumentProxy, extractText };
});

describe('fabFileUtils / unpdf lazy load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({ data: [] });
  });

  it('does not load unpdf merely by importing the module', async () => {
    await import('./fabFileUtils');
    expect(unpdfLoadedSpy).not.toHaveBeenCalled();
  });

  it('loads unpdf on demand and returns the extracted text for a PDF', async () => {
    const { extractTextFromFile } = await import('./fabFileUtils');

    getDocumentProxy.mockResolvedValue({ numPages: 1 });
    extractText.mockResolvedValue({ text: 'merged pdf text' });

    const buffer = new TextEncoder().encode('%PDF-1.4 fake pdf bytes').buffer;
    const result = await extractTextFromFile(SupportedFabFileMimeTypes.PDF, buffer);

    expect(unpdfLoadedSpy).toHaveBeenCalledTimes(1);
    expect(getDocumentProxy).toHaveBeenCalledTimes(1);
    expect(getDocumentProxy.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(extractText).toHaveBeenCalledWith({ numPages: 1 }, { mergePages: true });
    expect(result).toBe('merged pdf text');
  });

  it('never loads unpdf for a non-PDF type', async () => {
    const { extractTextFromFile } = await import('./fabFileUtils');

    const buffer = new TextEncoder().encode('plain text content').buffer;
    const result = await extractTextFromFile(SupportedFabFileMimeTypes.TXT_PLAIN, buffer);

    expect(unpdfLoadedSpy).not.toHaveBeenCalled();
    expect(getDocumentProxy).not.toHaveBeenCalled();
    expect(extractText).not.toHaveBeenCalled();
    expect(result).toBe('plain text content');
  });
});

describe('fabFileUtils / caller-supplied content cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh module so the 60s settings cache from earlier tests cannot hide a fetch.
    vi.resetModules();
  });

  // The server export passes the cap it read from the DB; the settings fetch goes through the
  // browser API client and throws Invalid URL in Node.
  it('truncates to the given cap without fetching settings', async () => {
    const { extractTextFromFile } = await import('./fabFileUtils');

    const buffer = new TextEncoder().encode('abcdefghij').buffer;
    const result = await extractTextFromFile(SupportedFabFileMimeTypes.TXT_PLAIN, buffer, 4);

    expect(result).toBe('abcd...');
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('fabFileUtils / GetFileIcon CSV', () => {
  const renderIcon = async (file: Partial<IFabFileDocument>) => {
    const { GetFileIcon } = await import('./fabFileUtils');
    return render(createElement(GetFileIcon, { file: { type: KnowledgeType.FILE, ...file } as IFabFileDocument }))
      .container;
  };

  it.each([SupportedFabFileMimeTypes.CSV, 'application/csv', 'application/octet-stream'])(
    'renders the table icon for a .CSV file labelled %s',
    async mimeType => {
      const container = await renderIcon({ fileName: 'Data.CSV', mimeType });
      expect(container.querySelector('[data-testid="TableChartIcon"]')).toBeTruthy();
    }
  );

  it('keeps the generic icon for a crawled URL ending in .csv', async () => {
    const container = await renderIcon({ type: KnowledgeType.URL, fileName: 'export.csv', mimeType: 'text/csv' });
    expect(container.querySelector('[data-testid="InsertDriveFileIcon"]')).toBeTruthy();
  });
});
