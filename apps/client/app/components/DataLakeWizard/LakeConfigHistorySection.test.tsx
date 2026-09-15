import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type {
  LakeConfigHistoryEntry,
  LakeConfigHistoryFingerprintChange,
  LakeConfigHistoryView,
} from '@bike4mind/common';
import {
  LakeConfigHistorySection,
  describeLakeConfigChange,
  describeLakeConfigFingerprint,
  describeLakeConfigValue,
} from './LakeConfigHistorySection';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const entry = (over: Partial<LakeConfigHistoryEntry> = {}): LakeConfigHistoryEntry => ({
  eventId: 'evt-1',
  changedAt: new Date('2026-08-17T10:30:00Z'),
  principalKind: 'user',
  principalId: '000000000000000000000001',
  principalName: 'Ada Lovelace',
  manageRung: 'grant-owner',
  action: 'update',
  changes: [{ field: 'name', kind: 'literal', before: 'Old', after: 'New' }],
  ...over,
});

const view = (over: Partial<LakeConfigHistoryView> = {}): LakeConfigHistoryView => ({
  lakeId: 'lake-1',
  lakeName: 'Ops Lake',
  entries: [entry()],
  truncated: false,
  generatedAt: new Date('2026-08-18T12:00:00Z'),
  ...over,
});

const renderSection = (props: Partial<React.ComponentProps<typeof LakeConfigHistorySection>> = {}) =>
  render(
    <Wrapper>
      <LakeConfigHistorySection view={view()} isLoading={false} error={undefined} {...props} />
    </Wrapper>
  );

describe('describeLakeConfigValue', () => {
  it('renders an absent, null, or blank side as "not set" - an empty cell reads as a rendering bug', () => {
    expect(describeLakeConfigValue(undefined)).toBe('not set');
    expect(describeLakeConfigValue(null)).toBe('not set');
    expect(describeLakeConfigValue('')).toBe('not set');
  });

  it('renders booleans as on/off rather than true/false', () => {
    expect(describeLakeConfigValue(true)).toBe('on');
    expect(describeLakeConfigValue(false)).toBe('off');
  });

  it('renders a zero as itself, not as "not set" - 0 is a real passage-token target', () => {
    expect(describeLakeConfigValue(0)).toBe('0');
  });
});

describe('describeLakeConfigFingerprint', () => {
  // The wire shape: presence and size, plus the server's answer to "same text?". No hash - the
  // client is never given one, so it cannot compare them even by mistake.
  const fp = (present: boolean, length: number) => ({ present, length });
  const change = (
    before: { present: boolean; length: number },
    after: { present: boolean; length: number },
    textUnchanged = false
  ): LakeConfigHistoryFingerprintChange => ({
    field: 'systemPrompt',
    kind: 'fingerprint',
    beforeFingerprint: before,
    afterFingerprint: after,
    textUnchanged,
  });

  it('describes a set, a clear, and a replacement by SIZE only - never the text', () => {
    expect(describeLakeConfigFingerprint(change(fp(false, 0), fp(true, 120)))).toBe('set (120 chars)');
    expect(describeLakeConfigFingerprint(change(fp(true, 120), fp(false, 0)))).toBe('cleared (was 120 chars)');
    expect(describeLakeConfigFingerprint(change(fp(true, 120), fp(true, 130)))).toBe('replaced (120 -> 130 chars)');
  });

  it('says "still not set" when neither side had a prompt', () => {
    expect(describeLakeConfigFingerprint(change(fp(false, 0), fp(false, 0)))).toBe('still not set');
  });

  it('calls a server-flagged same-text move formatting-only, so an owner is not sent hunting for a meaning change', () => {
    expect(describeLakeConfigFingerprint(change(fp(true, 120), fp(true, 118), true))).toBe(
      'formatting only (118 chars)'
    );
  });

  it('ignores textUnchanged when a side is absent - a set or a clear is never "formatting only"', () => {
    // Guards the branch order: the server only sets textUnchanged with both sides present, but a
    // reordering here would turn a genuine clear into a nonsensical formatting-only row.
    expect(describeLakeConfigFingerprint(change(fp(false, 0), fp(true, 12), true))).toBe('set (12 chars)');
    expect(describeLakeConfigFingerprint(change(fp(true, 12), fp(false, 0), true))).toBe('cleared (was 12 chars)');
  });
});

describe('describeLakeConfigChange', () => {
  it('renders a literal move as before -> after', () => {
    expect(describeLakeConfigChange({ field: 'name', kind: 'literal', before: 'a', after: 'b' })).toBe('a -> b');
  });

  it('marks a clipped literal so a stored-and-complete value is distinguishable from a stored-and-cut one', () => {
    expect(
      describeLakeConfigChange({ field: 'description', kind: 'literal', before: 'a', after: 'b', truncated: true })
    ).toBe('a -> b (clipped)');
  });
});

describe('identity values in describeLakeConfigChange', () => {
  const ADA = '000000000000000000000011';
  const GRACE = '000000000000000000000022';
  const names = { [ADA]: 'Ada Lovelace', [GRACE]: 'Grace Hopper' };
  const owner = (before: string | undefined, after: string) =>
    ({ field: 'effectiveOwnerUserId', kind: 'literal', before, after }) as LakeConfigHistoryFieldChange;

  it('renders a transfer as names, not as two opaque ObjectIds', () => {
    expect(describeLakeConfigChange(owner(ADA, GRACE), names)).toBe('Ada Lovelace -> Grace Hopper');
  });

  it('falls back to the raw id for an id the server could not resolve', () => {
    // Rows outlive the accounts they name - retention is up to 3650 days - so an unresolvable id
    // must render as itself rather than as "not set" or an empty cell.
    expect(describeLakeConfigChange(owner(ADA, '000000000000000000000099'), names)).toBe(
      'Ada Lovelace -> 000000000000000000000099'
    );
  });

  it('renders a comma-joined prior-owner set as a list of names', () => {
    expect(describeLakeConfigChange(owner(`${ADA},${GRACE}`, ADA), names)).toBe(
      'Ada Lovelace, Grace Hopper -> Ada Lovelace'
    );
  });

  it('leaves a NON-identity field alone even when its value looks like a resolvable id', () => {
    // organizationId is an id of another entity. Feeding it through a user-name map would produce a
    // confidently wrong name, which is worse than the raw id it replaced.
    const org = { field: 'organizationId', kind: 'literal', before: ADA, after: GRACE } as LakeConfigHistoryFieldChange;
    expect(describeLakeConfigChange(org, names)).toBe(`${ADA} -> ${GRACE}`);
  });

  it('renders raw ids when no name map is supplied at all', () => {
    expect(describeLakeConfigChange(owner(ADA, GRACE))).toBe(`${ADA} -> ${GRACE}`);
  });
});

describe('LakeConfigHistorySection', () => {
  it('renders one row per recorded change', () => {
    renderSection({ view: view({ entries: [entry({ eventId: 'a' }), entry({ eventId: 'b' })] }) });
    expect(screen.getAllByTestId('datalake-config-history-row')).toHaveLength(2);
  });

  it('shows who changed it, by name, with the authorizing rung', () => {
    renderSection();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-config-history-rung-grant-owner')).toBeInTheDocument();
  });

  it('falls back to the opaque principal id when no name resolved', () => {
    renderSection({ view: view({ entries: [entry({ principalName: undefined })] }) });
    expect(screen.getByText('000000000000000000000001')).toBeInTheDocument();
  });

  it('flags a platform-admin edit as such - the case an owner most needs to spot', () => {
    renderSection({ view: view({ entries: [entry({ manageRung: 'platform-admin' })] }) });
    expect(screen.getByTestId('datalake-config-history-rung-platform-admin')).toBeInTheDocument();
    expect(screen.getByText('Platform admin')).toBeInTheDocument();
  });

  it('names the on-behalf human when an API key acted for one', () => {
    renderSection({
      view: view({
        entries: [
          entry({
            principalKind: 'apiKey',
            principalId: 'key_abc',
            principalName: undefined,
            onBehalfOfUserId: '000000000000000000000002',
            onBehalfOfName: 'Grace Hopper',
          }),
        ],
      }),
    });
    expect(screen.getByText(/for Grace Hopper/)).toBeInTheDocument();
  });

  it('renders a long system prompt in the fingerprint form and NEVER the prompt text', () => {
    const secret = 'you are a helpful assistant with privileged instructions';
    renderSection({
      view: view({
        entries: [
          entry({
            changes: [
              {
                field: 'systemPrompt',
                kind: 'fingerprint',
                beforeFingerprint: { present: true, length: 40, hash: 'aaaa' },
                afterFingerprint: { present: true, length: secret.length, hash: 'bbbb' },
              },
            ],
          }),
        ],
      }),
    });
    expect(screen.getByText('System prompt')).toBeInTheDocument();
    expect(screen.getByText(`replaced (40 -> ${secret.length} chars)`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(secret))).not.toBeInTheDocument();
    // The hash is an internal correlator, not something to put in front of an owner.
    expect(screen.queryByText(/bbbb/)).not.toBeInTheDocument();
  });

  it('renders every changed field of a multi-field edit', () => {
    renderSection({
      view: view({
        entries: [
          entry({
            changes: [
              { field: 'name', kind: 'literal', before: 'a', after: 'b' },
              { field: 'isPublic', kind: 'literal', before: false, after: true },
            ],
          }),
        ],
      }),
    });
    expect(screen.getAllByTestId('datalake-config-history-change')).toHaveLength(2);
    expect(screen.getByText('Public')).toBeInTheDocument();
    expect(screen.getByText('off -> on')).toBeInTheDocument();
  });

  // These rows are retained for 1095-3650 days, so one can outlive the enum that named it. An
  // unguarded RUNG_LABEL lookup would throw on `.label` and take the whole table down.
  describe('a row whose vocabulary the current code no longer knows', () => {
    it('renders the raw rung instead of crashing the table', () => {
      renderSection({
        view: view({ entries: [entry({ manageRung: 'rung-from-a-later-release' as never })] }),
      });
      expect(screen.getByTestId('datalake-config-history-row')).toBeInTheDocument();
      expect(screen.getByText('rung-from-a-later-release')).toBeInTheDocument();
    });

    it('renders the raw field and action names rather than the string "undefined"', () => {
      renderSection({
        view: view({
          entries: [
            entry({
              action: 'some-new-action' as never,
              changes: [{ field: 'someNewField' as never, kind: 'literal', before: 'a', after: 'b' }],
            }),
          ],
        }),
      });
      expect(screen.getByText('some-new-action')).toBeInTheDocument();
      expect(screen.getByText('someNewField')).toBeInTheDocument();
      expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('shows a spinner while loading', () => {
      renderSection({ view: undefined, isLoading: true });
      expect(screen.getByTestId('datalake-config-history-loading')).toBeInTheDocument();
    });

    it('shows an error alert instead of an empty state, so a failed read is not read as "no changes"', () => {
      renderSection({ view: undefined, isLoading: false, error: new Error('boom') });
      expect(screen.getByTestId('datalake-config-history-error')).toBeInTheDocument();
      expect(screen.queryByTestId('datalake-config-history-empty')).not.toBeInTheDocument();
    });

    it('explains an empty history as "recorded from when auditing was enabled", not as "nothing changed"', () => {
      renderSection({ view: view({ entries: [] }) });
      const empty = screen.getByTestId('datalake-config-history-empty');
      expect(empty).toBeInTheDocument();
      expect(empty.textContent).toMatch(/before then do not appear/i);
    });

    it('says the list is a window when truncated, so it is not read as the whole history', () => {
      renderSection({
        view: view({ truncated: true, windowStartsAt: new Date('2026-01-05T00:00:00Z') }),
      });
      expect(screen.getByTestId('datalake-config-history-truncated')).toBeInTheDocument();
    });

    it('shows no truncation note on a complete history', () => {
      renderSection();
      expect(screen.queryByTestId('datalake-config-history-truncated')).not.toBeInTheDocument();
    });
  });
});
