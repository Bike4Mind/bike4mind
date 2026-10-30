// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SkillMarketOrgsResult,
  SkillSaveResult,
  SkillSubmitResult,
  SkillUploadPreview,
} from '@shared/skillMarket';
import { SkillUploadDialog, versionOutcome } from './SkillUploadDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

type Preview = Extract<SkillUploadPreview, { ok: true }>;

const preview = (overrides: Partial<Preview> = {}): Preview => ({
  ok: true,
  fields: { name: 'tester-guide', description: 'Writes a guide.', body: 'Do it.' },
  dropped: [],
  extraFiles: [],
  extraFileCount: 0,
  ...overrides,
});

const published: SkillSubmitResult = {
  ok: true,
  listing: {
    id: 'l9',
    name: 'tester-guide',
    visibility: 'unlisted',
    status: 'in_review',
    hiddenByReports: false,
    tags: [],
    hasShareLink: true,
  },
  version: {
    version: 1,
    scanStatus: 'passed',
    reviewStatus: 'pending',
    riskTier: 'high',
    findings: [{ severity: 'high', message: 'Uses web_fetch' }],
  },
};

const market = {
  saveSkill: vi.fn<(request: unknown) => Promise<SkillSaveResult>>(),
  publish: vi.fn<(request: unknown) => Promise<SkillSubmitResult>>(),
  submitVersion: vi.fn<(request: unknown) => Promise<SkillSubmitResult>>(),
  organizations: vi.fn<() => Promise<SkillMarketOrgsResult>>(async () => ({
    organizations: [{ id: 'o1', name: 'Acme' }],
  })),
  openSource: vi.fn(async () => true),
  openOnWeb: vi.fn(async () => true),
  copyShareLink: vi.fn(async () => ({ ok: true as const })),
};
(window as unknown as { b4m: unknown }).b4m = { skillMarket: market };

let root: Root;

const render = (node: React.ReactNode) => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CssVarsProvider>{node}</CssVarsProvider>));
};

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (id: string) => act(async () => $(id)?.click());

function type(id: string, value: string) {
  const input = $(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const key = (id: string, keyName: string) =>
  act(() => {
    $(id)!.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });

describe('SkillUploadDialog', () => {
  beforeEach(() => {
    for (const fn of Object.values(market)) fn.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('shows the ignored keys and the files that are not uploaded', () => {
    render(
      <SkillUploadDialog
        preview={preview({ dropped: ['hooks', 'model'], extraFiles: ['a.py', 'b.md'], extraFileCount: 7 })}
        onClose={() => {}}
      />
    );
    expect($('skill-upload-dropped')?.textContent).toContain(
      'Ignored (not supported in Bike4Mind skills): hooks, model'
    );
    expect($('skill-upload-extra-files')?.textContent).toContain(
      'Only SKILL.md, scripts/ and references/ are uploaded; 7 other files'
    );
    expect($('skill-upload-extra-files')?.textContent).toContain('a.py, b.md');
  });

  it('lists the supporting files that are uploaded and says scripts get a human review', () => {
    render(
      <SkillUploadDialog
        preview={preview({
          fields: {
            ...preview().fields,
            files: [
              { path: 'references/a.md', content: 'a' },
              { path: 'scripts/run.py', content: 'b' },
            ],
          },
        })}
        onClose={() => {}}
      />
    );
    expect($('skill-upload-files')?.textContent).toContain('2 supporting files: references/a.md, scripts/run.py');
    expect($('skill-upload-files')?.textContent).toContain('a person reviews them');
  });

  it('links a Bike4Mind export to its original', async () => {
    render(
      <SkillUploadDialog
        preview={preview({ source: { url: 'https://b4m.test/skills/s1', thirdParty: false } })}
        onClose={() => {}}
      />
    );
    expect($('skill-upload-from-b4m')?.textContent).toContain('This skill came from Bike4Mind');
    await click('skill-upload-source-link');
    expect(market.openSource).toHaveBeenCalledWith('https://b4m.test/skills/s1');
  });

  it("sends nothing for another author's export until the confirm is accepted", async () => {
    market.saveSkill.mockResolvedValue({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
    render(
      <SkillUploadDialog
        preview={preview({ source: { url: 'https://b4m.test/l', thirdParty: true } })}
        onClose={() => {}}
      />
    );
    expect($('skill-upload-from-b4m')?.textContent).toContain("another author's Skill Market skill");

    await click('skill-upload-save-btn');
    expect($('skill-upload-thirdparty-confirm')).not.toBeNull();
    expect(market.saveSkill).not.toHaveBeenCalled();

    await click('skill-upload-thirdparty-confirm-btn');
    expect(market.saveSkill).toHaveBeenCalledTimes(1);
    expect($('skill-upload-saved')).not.toBeNull();
  });

  it('checks the fields before anything is sent', () => {
    render(
      <SkillUploadDialog
        preview={preview({ fields: { name: 'Bad Name', description: '', body: 'x' } })}
        onClose={() => {}}
      />
    );
    expect(($('skill-upload-save-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('Use kebab-case');
    expect(document.body.textContent).toContain('A description is required.');
  });

  it('asks Update or Rename on a name clash, and updates the existing skill by id', async () => {
    market.saveSkill
      .mockResolvedValueOnce({ ok: false, error: 'taken', code: 'name_taken', existing: { id: 's7', imported: false } })
      .mockResolvedValueOnce({ ok: true, skill: { id: 's7', name: 'tester-guide' }, shadowedByLocal: true });
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} />);
    await click('skill-upload-save-btn');
    expect($('skill-upload-conflict')).not.toBeNull();
    expect($('skill-upload-rename-field')).not.toBeNull();

    await click('skill-upload-update-btn');
    expect(market.saveSkill).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'update', targetSkillId: 's7' }));
    expect($('skill-upload-saved')?.textContent).toContain('Your local copy still takes precedence on this machine.');
  });

  it('offers only Rename when the clashing skill is a market import', async () => {
    market.saveSkill.mockResolvedValueOnce({
      ok: false,
      error: 'taken',
      code: 'name_taken',
      existing: { id: 's7', imported: true },
    });
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} />);
    await click('skill-upload-save-btn');
    expect($('skill-upload-update-btn')).toBeNull();
    type('skill-upload-rename-field', 'tester-guide-2');
    await click('skill-upload-rename-btn');
    expect(($('skill-upload-name') as HTMLInputElement).value).toBe('tester-guide-2');
  });

  it('shows a server validation message inline', async () => {
    market.saveSkill.mockResolvedValueOnce({ ok: false, error: 'Skill body is required' });
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} />);
    await click('skill-upload-save-btn');
    expect($('skill-upload-error')?.textContent).toBe('Skill body is required');
  });

  it('applies the web tag rules and publishes with the tags, then shows the scan result', async () => {
    market.saveSkill.mockResolvedValueOnce({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
    market.publish.mockResolvedValueOnce(published);
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} />);
    await click('skill-upload-publish-btn');
    expect($('skill-publish-visibility')).not.toBeNull();
    expect($('skill-publish-scan-disclosure')?.textContent).toContain(
      'At every visibility, the scan can reject a submission or hold it for a reviewer before it goes live.'
    );
    expect(document.body.textContent).not.toContain('Held for a reviewer if the scan flags anything.');

    type('skill-publish-tag-input', '#Writing');
    key('skill-publish-tag-input', 'Enter');
    type('skill-publish-tag-input', 'writing');
    key('skill-publish-tag-input', ',');
    type('skill-publish-tag-input', 'no spaces');
    key('skill-publish-tag-input', 'Enter');
    expect($('skill-publish-tag-helper')?.textContent).toBe('Use 1-24 lowercase letters, digits or hyphens');
    expect($$('skill-publish-tag').map(chip => chip.textContent)).toEqual(['#writing']);

    for (const tag of ['a', 'b', 'c', 'd']) {
      type('skill-publish-tag-input', tag);
      key('skill-publish-tag-input', 'Enter');
    }
    expect($$('skill-publish-tag')).toHaveLength(5);
    expect(($('skill-publish-tag-input') as HTMLInputElement).disabled).toBe(true);
    expect(($('skill-publish-tag-input') as HTMLInputElement).placeholder).toBe('Tag limit reached');

    act(() => ($('skill-publish-tag-input') as HTMLInputElement).removeAttribute('disabled'));
    type('skill-publish-tag-input', '');
    key('skill-publish-tag-input', 'Backspace');
    expect($$('skill-publish-tag')).toHaveLength(4);

    await click('skill-publish-visibility-unlisted');
    await click('skill-publish-submit-btn');
    expect(market.publish).toHaveBeenCalledWith({
      skillId: 's1',
      visibility: 'unlisted',
      tags: ['writing', 'a', 'b', 'c'],
    });
    expect($('skill-publish-result-status')?.textContent).toContain('Waiting for a human reviewer');
    expect($('skill-publish-findings')?.textContent).toContain('Uses web_fetch');
    await click('skill-listing-copy-link-btn');
    expect(market.copyShareLink).toHaveBeenCalledWith('l9');
  });

  it.each(['public', 'organization', 'unlisted'] as const)(
    'explains the reviewer hold for a review-tier %s version',
    async visibility => {
      market.submitVersion.mockResolvedValueOnce({
        ...published,
        listing: { ...published.listing, visibility },
        version: { ...published.version, riskTier: 'review', findings: [] },
      });
      render(<SkillUploadDialog preview={preview()} listing={{ id: 'l9', name: 'tester-guide' }} onClose={() => {}} />);

      await click('skill-upload-submit-version-btn');

      expect($('skill-publish-result-status')?.textContent).toContain('Waiting for a human reviewer');
      expect($('skill-publish-result')?.textContent).toContain(
        'Listings with findings are checked by a person before they go live.'
      );
      expect($('skill-publish-result')?.textContent).not.toContain('Public listings with findings');
    }
  );

  it('shows an organization lookup failure instead of silently reporting no memberships', async () => {
    market.saveSkill.mockResolvedValueOnce({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
    market.organizations.mockResolvedValueOnce({ organizations: [], error: 'Organization lookup failed.' });
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} />);

    await click('skill-upload-publish-btn');
    expect($('skill-upload-error')?.textContent).toBe('Organization lookup failed.');
    expect(market.publish).not.toHaveBeenCalled();
  });

  it('refreshes dependent lists after publishing, separately from the account save', async () => {
    const onSaved = vi.fn();
    market.saveSkill.mockResolvedValueOnce({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
    market.publish.mockResolvedValueOnce(published);
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} onSaved={onSaved} />);

    await click('skill-upload-publish-btn');
    expect(onSaved).toHaveBeenCalledTimes(1);

    await click('skill-publish-submit-btn');
    expect($('skill-publish-result')).not.toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('does not refresh dependent lists when publishing fails', async () => {
    const onSaved = vi.fn();
    market.saveSkill.mockResolvedValueOnce({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
    market.publish.mockResolvedValueOnce({ ok: false, error: 'Publication failed.' });
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} onSaved={onSaved} />);

    await click('skill-upload-publish-btn');
    expect(onSaved).toHaveBeenCalledTimes(1);

    await click('skill-publish-submit-btn');
    expect($('skill-upload-error')?.textContent).toBe('Publication failed.');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('turns an already-listed refusal into a new-version step', async () => {
    market.saveSkill.mockResolvedValueOnce({ ok: true, skill: { id: 's1', name: 'tester-guide' } });
    market.publish.mockResolvedValueOnce({
      ok: false,
      error: 'Already listed.',
      code: 'already_listed',
      listingId: 'l4',
    });
    market.submitVersion.mockResolvedValueOnce(published);
    render(<SkillUploadDialog preview={preview()} onClose={() => {}} />);
    await click('skill-upload-publish-btn');
    await click('skill-publish-submit-btn');
    await click('skill-upload-submit-version-btn');
    expect(market.submitVersion).toHaveBeenCalledWith({ listingId: 'l4' });
    expect($('skill-publish-result')).not.toBeNull();
  });

  it('warns when a new version would rename the listing', () => {
    render(<SkillUploadDialog preview={preview()} listing={{ id: 'l1', name: 'tester-guide' }} onClose={() => {}} />);
    expect($('skill-upload-name-mismatch')).toBeNull();
    type('skill-upload-name', 'other-skill');
    expect($('skill-upload-name-mismatch')?.textContent).toContain('This file is /other-skill, not /tester-guide');
  });

  it('says the account skill was updated when only the version submission failed', async () => {
    market.submitVersion.mockResolvedValueOnce({
      ok: false,
      error: 'Slow down.',
      code: 'rate_limited',
      skillUpdated: true,
    });
    render(<SkillUploadDialog preview={preview()} listing={{ id: 'l1', name: 'tester-guide' }} onClose={() => {}} />);
    await click('skill-upload-submit-version-btn');
    expect(market.submitVersion).toHaveBeenCalledWith({
      listingId: 'l1',
      fields: expect.objectContaining({ name: 'tester-guide' }),
    });
    expect($('skill-upload-error')?.textContent).toContain('Your account skill was updated');
  });
});

describe('legacy auto-approved review-tier outcomes', () => {
  it.each([
    ['organization', 'organization'],
    ['unlisted', 'link holders'],
  ] as const)('keeps a legacy %s version live', (visibility, audience) => {
    expect(
      versionOutcome({ ...published.version, reviewStatus: 'auto_approved', riskTier: 'review' }, visibility)
    ).toMatchObject({
      color: 'success',
      title: 'Live on the Skill Market',
      body: `Passed the automated scan with a note and is live for your ${audience}.`,
    });
  });
});
