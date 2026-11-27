import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import type { ManagedArtifact } from '@client/app/utils/publishApi';
import {
  getPrivateLinkGate,
  getPublishAccess,
  isPublishAccess,
  LIGHT_WARNING_TEXT,
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

/** A value the type forbids but a legacy or hand-edited document could still carry. */
const unexpected = <T,>(value: unknown) => value as T;

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

  it('names a non-public page by its visibility even when it carries a gate', () => {
    expect(getPublishAccess({ visibility: 'private', gateKind: 'passphrase' })).toBe('private');
    expect(getPublishAccess({ visibility: 'organization', gateKind: 'domain' })).toBe('organization');
    expect(getPublishAccess({ visibility: 'project', gateKind: 'passphrase' })).toBe('project');
  });

  it('stays total over values the type forbids, so one odd row cannot crash the list', () => {
    type Gate = ManagedArtifact['gateKind'];
    expect(getPublishAccess({ visibility: 'public', gateKind: unexpected<Gate>(null) })).toBe('public');
    expect(getPublishAccess({ visibility: 'public', gateKind: unexpected<Gate>('none') })).toBe('public');
    // The server treats any non-public level it does not know as owner-only.
    expect(getPublishAccess({ visibility: unexpected<ManagedArtifact['visibility']>('unlisted') })).toBe('private');
    expect(getPublishAccess({ visibility: unexpected<ManagedArtifact['visibility']>('passphrase') })).toBe('private');
  });
});

describe('getPrivateLinkGate', () => {
  it('returns the gate only for a non-public page, where it guards the private links', () => {
    expect(getPrivateLinkGate({ visibility: 'private', gateKind: 'passphrase' })).toBe('passphrase');
    expect(getPrivateLinkGate({ visibility: 'organization', gateKind: 'domain' })).toBe('domain');
    expect(getPrivateLinkGate({ visibility: 'public', gateKind: 'passphrase' })).toBeUndefined();
    expect(getPrivateLinkGate({ visibility: 'private' })).toBeUndefined();
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
    [
      { visibility: 'organization' },
      'organization',
      'Team',
      'Members of your team, and anyone you send a private link to',
    ],
    [{ visibility: 'project' }, 'project', 'Project', 'Members of this project, and anyone you send a private link to'],
    [{ visibility: 'private' }, 'private', 'Private', 'Only you, and anyone you send a private link to'],
  ];

  it.each(cases)('renders %j as the %s state with its word, icon and meaning', (input, access, label, description) => {
    renderBadge(input);
    const badge = screen.getByTestId('badge');
    expect(badge.getAttribute('data-access')).toBe(access);
    expect(badge.textContent).toBe(label);
    // Icon and word are always both present, so the state never rests on color alone.
    expect(badge.querySelectorAll('svg')).toHaveLength(1);
    expect(badge.getAttribute('title')).toBe(description);
  });

  it('shows the passphrase state for a gated public row, not a plain Public chip', () => {
    renderBadge({ visibility: 'public', gateKind: 'passphrase' });
    expect(screen.getByTestId('badge').textContent).toBe('Passphrase');
    expect(screen.queryByText('Public')).toBeNull();
  });

  it.each([
    [
      'passphrase',
      'KeyIcon',
      'Only you, and anyone you send a private link to. Private links also need the passphrase.',
    ],
    [
      'domain',
      'DomainIcon',
      'Only you, and anyone you send a private link to. Private links also need a verified email from an allowed domain.',
    ],
  ] as const)(
    'keeps a %s gate on a private page visible: its icon after the word, and the tooltip says it',
    (gate, icon, title) => {
      renderBadge({ visibility: 'private', gateKind: gate });
      const badge = screen.getByTestId('badge');
      expect(badge.textContent).toBe('Private');
      expect(badge.getAttribute('data-access')).toBe('private');
      expect(badge.getAttribute('data-link-gate')).toBe(gate);
      const icons = [...badge.querySelectorAll('svg')].map(svg => svg.getAttribute('data-testid'));
      expect(icons).toEqual(['LockIcon', icon]);
      expect(badge.getAttribute('title')).toBe(title);
    }
  );

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

describe('light-mode warning text', () => {
  const rgb = (color: string): [number, number, number, number] => {
    const hex = color.match(/#([0-9a-f]{6})/i);
    if (hex)
      return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
    const parts = color
      .match(/rgba?\(([^)]+)\)/)?.[1]
      .split(',')
      .map(Number);
    if (!parts) throw new Error(`unparsed colour ${color}`);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  };
  const luminance = (c: number[]) => {
    const ch = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  };
  const contrast = (fg: string, bg: number[]) => {
    const [hi, lo] = [luminance(rgb(fg)), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('is applied to a gated badge in light mode only', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { unmount } = render(
        <CssVarsProvider theme={appTheme} defaultMode={mode} modeStorageKey={`badge-test-${mode}`}>
          <PublishAccessBadge visibility="public" gateKind="passphrase" data-testid="badge" />
        </CssVarsProvider>
      );
      const color = getComputedStyle(screen.getByTestId('badge')).color;
      if (mode === 'light') expect(color).toBe('var(--joy-palette-warning-700)');
      else expect(color).not.toContain('warning-700');
      unmount();
    }
  });

  it('reaches 4.5:1 on the warning soft background the badge sits on', () => {
    const palette = appTheme.colorSchemes.light.palette as unknown as Record<string, Record<string, string>>;
    const [group, shade] = LIGHT_WARNING_TEXT.split('.');
    const [r, g, b, a] = rgb(palette.warning.softBg);
    for (const surface of [palette.background.body, palette.background.surface]) {
      const under = rgb(surface);
      const chipBg = [r, g, b].map((c, i) => c * a + under[i] * (1 - a));
      expect(contrast(palette[group][shade], chipBg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
