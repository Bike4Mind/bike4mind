import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import {
  getPublishAccess,
  isPublishAccess,
  PublishAccessBadge,
  PUBLISH_ACCESS_META,
  type PublishAccess,
} from './PublishAccessBadge';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBadge = (props: React.ComponentProps<typeof PublishAccessBadge>) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <PublishAccessBadge {...props} data-testid="badge" />
    </CssVarsProvider>
  );

describe('getPublishAccess', () => {
  it.each([
    [{ visibility: 'public' }, 'public'],
    [{ visibility: 'public', gateKind: 'passphrase' }, 'passphrase'],
    [{ visibility: 'public', gateKind: 'domain' }, 'domain'],
    [{ visibility: 'organization' }, 'organization'],
    [{ visibility: 'project' }, 'project'],
    [{ visibility: 'private' }, 'private'],
  ] as const)('maps %j to %s', (input, expected) => {
    expect(getPublishAccess(input)).toBe(expected);
  });

  it('lets visibility win over a stale gateKind on a non-public row', () => {
    // Gates only apply to public pages: a private row that still carries a gateKind is private.
    expect(getPublishAccess({ visibility: 'private', gateKind: 'passphrase' })).toBe('private');
    expect(getPublishAccess({ visibility: 'organization', gateKind: 'domain' })).toBe('organization');
    expect(getPublishAccess({ visibility: 'project', gateKind: 'passphrase' })).toBe('project');
  });
});

describe('isPublishAccess', () => {
  it('accepts the six states and rejects anything else, including inherited object keys', () => {
    for (const key of Object.keys(PUBLISH_ACCESS_META)) expect(isPublishAccess(key)).toBe(true);
    expect(isPublishAccess('everyone')).toBe(false);
    expect(isPublishAccess('constructor')).toBe(false);
  });
});

describe('PublishAccessBadge', () => {
  const cases: Array<[Parameters<typeof getPublishAccess>[0], PublishAccess, string, string]> = [
    [{ visibility: 'public' }, 'public', 'Public', 'Anyone with the link'],
    [
      { visibility: 'public', gateKind: 'passphrase' },
      'passphrase',
      'Passphrase',
      'Anyone with the link and the passphrase',
    ],
    [
      { visibility: 'public', gateKind: 'domain' },
      'domain',
      'Domain',
      'Anyone who signs in with a verified email from an allowed domain',
    ],
    [{ visibility: 'organization' }, 'organization', 'Team', 'Members of your team'],
    [{ visibility: 'project' }, 'project', 'Project', 'Members of this project'],
    [{ visibility: 'private' }, 'private', 'Private', 'Only you'],
  ];

  it.each(cases)('renders %j as the %s state with its word, icon and meaning', (input, access, label, description) => {
    renderBadge(input);
    const badge = screen.getByTestId('badge');
    expect(badge.getAttribute('data-access')).toBe(access);
    expect(badge.textContent).toBe(label);
    // Icon and word are always both present, so the state never rests on color alone.
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.getAttribute('title')).toBe(description);
  });

  it('shows the passphrase state for a gated public row, not a plain Public chip', () => {
    renderBadge({ visibility: 'public', gateKind: 'passphrase' });
    expect(screen.getByTestId('badge').textContent).toBe('Passphrase');
    expect(screen.queryByText('Public')).toBeNull();
  });

  it('uses a distinct icon for each state', () => {
    const icons = new Set<string>();
    for (const access of Object.keys(PUBLISH_ACCESS_META) as PublishAccess[]) {
      const { unmount } = renderBadge(
        access === 'passphrase' || access === 'domain'
          ? { visibility: 'public', gateKind: access }
          : { visibility: access }
      );
      icons.add(screen.getByTestId('badge').querySelector('svg')?.getAttribute('data-testid') ?? '');
      unmount();
    }
    expect(icons.size).toBe(6);
  });
});
