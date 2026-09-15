import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// Capture the props FilePond receives so the test can assert on the derived
// `maxFileSize` string without mounting the real widget.
let capturedProps: Record<string, unknown> | null = null;

vi.mock('react-filepond', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub stands in for the FilePond component
  FilePond: (props: any) => {
    capturedProps = props;
    return null;
  },
  registerPlugin: vi.fn(),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let mockServerSettings: Array<{ settingName: string; settingValue: string }> = [];
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useServerSettings: () => ({ serverSettings: mockServerSettings }),
}));

import FilePondModal from './FilePond';

describe('FilePondModal MaxFileSize derivation (#2456)', () => {
  beforeEach(() => {
    capturedProps = null;
    mockServerSettings = [];
  });

  it('reads .settingValue off the found row, not the row object itself', () => {
    mockServerSettings = [{ settingName: 'MaxFileSize', settingValue: '50' }];

    render(<FilePondModal onFileProcessComplete={vi.fn()} />);

    // Regression guard for the `[object Object]MB` bug: `.find(...)` returns the
    // whole IAdminSettings row, so a naive `${row}MB` template would render the
    // row's own toString(), not its numeric settingValue.
    expect(capturedProps?.maxFileSize).toBe('50MB');
  });

  it('falls back to the server default (30MB) when MaxFileSize is cleared', () => {
    mockServerSettings = [{ settingName: 'MaxFileSize', settingValue: '' }];

    render(<FilePondModal onFileProcessComplete={vi.fn()} />);

    expect(capturedProps?.maxFileSize).toBe('30MB');
  });

  it('falls back to the server default (30MB) when no MaxFileSize row exists', () => {
    mockServerSettings = [];

    render(<FilePondModal onFileProcessComplete={vi.fn()} />);

    expect(capturedProps?.maxFileSize).toBe('30MB');
  });
});
