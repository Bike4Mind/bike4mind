import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { toSkillMd } from '@bike4mind/common/utils/skillMd';
import { getThemeConfig } from '@client/app/utils/themes';
import JSZip from 'jszip';
import { SkillForm } from './SkillForm';

vi.mock('@client/app/hooks/data/skills', () => ({}));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderForm = (enableSkillMdImport = true) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillForm submitLabel="Create" onSubmit={vi.fn()} onCancel={vi.fn()} enableSkillMdImport={enableSkillMdImport} />
    </CssVarsProvider>
  );

const value = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;

const upload = (text: string) =>
  fireEvent.change(screen.getByTestId('skill-form-import-file'), {
    target: { files: [new File([text], 'SKILL.md', { type: 'text/markdown' })] },
  });

const inFolder = (relativePath: string, content: string | Uint8Array) => {
  const file = new File([content], relativePath.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
};

const paste = (text: string) => {
  fireEvent.click(screen.getByTestId('skill-form-import-paste-toggle'));
  fireEvent.change(screen.getByTestId('skill-form-import-paste-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('skill-form-import-paste-apply'));
};

const deferredFile = () => {
  let resolveRead: (text: string) => void = () => {
    throw new Error('File read has not started');
  };
  let rejectRead: (error: Error) => void = () => {
    throw new Error('File read has not started');
  };
  const read = new Promise<string>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  const file = new File([], 'SKILL.md', { type: 'text/markdown' });
  file.text = () => read;
  return { file, resolveRead, rejectRead };
};

describe('SkillForm SKILL.md import', () => {
  it('explains which supporting files a folder import brings along', () => {
    renderForm();
    expect(screen.getByTestId('skill-form-import-file-limitations')).toHaveTextContent('scripts/ and references/');
  });

  it('imports a skill folder with its scripts and references and submits them', async () => {
    const onSubmit = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <SkillForm submitLabel="Create" onSubmit={onSubmit} onCancel={vi.fn()} enableSkillMdImport />
      </CssVarsProvider>
    );
    fireEvent.change(screen.getByTestId('skill-form-import-folder'), {
      target: {
        files: [
          inFolder('review-pr/SKILL.md', '---\nname: review-pr\ndescription: Review a PR\n---\nRun the script.'),
          inFolder('review-pr/scripts/review.py', 'print("ok")'),
          inFolder('review-pr/references/checklist.md', '- tests'),
          inFolder('review-pr/README.md', 'readme'),
          inFolder('review-pr/.DS_Store', 'junk'),
        ],
      },
    });
    await waitFor(() => expect(value('skill-name-input')).toBe('review-pr'));
    expect(screen.getByTestId('skill-form-files')).toHaveTextContent('references/checklist.md');
    expect(screen.getByTestId('skill-form-files-skipped')).toHaveTextContent('README.md');
    expect(screen.getByTestId('skill-form-files-skipped')).not.toHaveTextContent('DS_Store');

    fireEvent.submit(screen.getByTestId('skill-form'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          { path: 'references/checklist.md', content: '- tests' },
          { path: 'scripts/review.py', content: 'print("ok")' },
        ],
      })
    );

    fireEvent.click(screen.getByTestId('skill-form-files-remove'));
    fireEvent.submit(screen.getByTestId('skill-form'));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ files: [] }));
  });

  it('refuses a folder with a binary script and leaves the form alone', async () => {
    renderForm();
    fireEvent.change(screen.getByTestId('skill-form-import-folder'), {
      target: {
        files: [
          inFolder('s/SKILL.md', '---\nname: s\ndescription: d\n---\nbody'),
          inFolder('s/scripts/tool.bin', new Uint8Array([0xff, 0xfe, 0x00])),
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent('scripts/tool.bin: only text files')
    );
    expect(value('skill-name-input')).toBe('');
  });

  it('keeps no supporting files from a folder whose SKILL.md is malformed', async () => {
    renderForm();
    fireEvent.change(screen.getByTestId('skill-form-import-folder'), {
      target: { files: [inFolder('s/SKILL.md', '---\nname: [\n---\nbody'), inFolder('s/scripts/a.py', 'x')] },
    });
    await waitFor(() => expect(screen.getByTestId('skill-form-import-error')).toBeInTheDocument());
    expect(screen.queryByTestId('skill-form-files')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores an older file that later %ss after a newer import',
    async outcome => {
      renderForm();
      const older = deferredFile();
      fireEvent.change(screen.getByTestId('skill-form-import-file'), { target: { files: [older.file] } });
      upload('---\nname: newer\ndescription: Newer description\n---\nNewer body');
      await waitFor(() => expect(value('skill-name-input')).toBe('newer'));

      await act(async () => {
        if (outcome === 'resolve') older.resolveRead('---\nname: older\ndescription: Old description\n---\nOld body');
        else older.rejectRead(new Error('Old read failed'));
      });

      expect(value('skill-name-input')).toBe('newer');
      expect(value('skill-description-input')).toBe('Newer description');
      expect(value('skill-body-input')).toBe('Newer body');
      expect(screen.queryByTestId('skill-form-import-error')).not.toBeInTheDocument();
    }
  );

  it('keeps a pasted import when an earlier file finishes reading', async () => {
    renderForm();
    const older = deferredFile();
    fireEvent.change(screen.getByTestId('skill-form-import-file'), { target: { files: [older.file] } });
    paste('---\nname: pasted\ndescription: Pasted description\n---\nPasted body');

    await act(async () => {
      older.resolveRead('---\nname: older\ndescription: Old description\n---\nOld body');
    });

    expect(value('skill-name-input')).toBe('pasted');
    expect(value('skill-description-input')).toBe('Pasted description');
    expect(value('skill-body-input')).toBe('Pasted body');
    expect(screen.queryByTestId('skill-form-import-error')).not.toBeInTheDocument();
  });

  it('prefills every field from an uploaded file and reports unsupported keys', async () => {
    renderForm();
    upload(
      '---\nname: review-pr\ndescription: "Review: a PR"\nargument-hint: "[pr]"\ndisable-model-invocation: true\nallowed-tools: Bash\nhooks: {}\n---\n\nReview $ARGUMENTS.\n'
    );
    await waitFor(() => expect(value('skill-name-input')).toBe('review-pr'));
    expect(value('skill-description-input')).toBe('Review: a PR');
    expect(value('skill-argument-hint-input')).toBe('[pr]');
    expect(value('skill-body-input')).toBe('Review $ARGUMENTS.');
    expect((screen.getByTestId('skill-disable-model-invocation') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('skill-form-import-dropped')).toHaveTextContent('hooks');
    expect(screen.getByTestId('skill-form-import-dropped')).not.toHaveTextContent('allowed-tools');
    expect(screen.getByTestId('skill-form-claude-code-tools')).toHaveTextContent('Claude Code tools: Bash.');
    expect(screen.queryByTestId('skill-form-import-from-b4m')).not.toBeInTheDocument();
  });

  it('submits allowed-tools as claudeCodeAllowedTools, leaving the B4M allowedTools alone', () => {
    const onSubmit = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <SkillForm submitLabel="Create" onSubmit={onSubmit} onCancel={vi.fn()} enableSkillMdImport />
      </CssVarsProvider>
    );
    paste('---\nname: commit\ndescription: Commit\nallowed-tools: Bash(git:*), Read\n---\nCommit it.');
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ claudeCodeAllowedTools: ['Bash(git:*)', 'Read'] }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('allowedTools');
  });

  it('removes imported Claude Code tools, submitting an empty list', () => {
    const onSubmit = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <SkillForm
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialValue={{ name: 'commit', description: 'Commit', body: 'Commit it.', claudeCodeAllowedTools: ['Bash'] }}
        />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('skill-form-claude-code-tools-remove'));
    expect(screen.queryByTestId('skill-form-claude-code-tools')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ claudeCodeAllowedTools: [] }));
  });

  it.each([
    [
      'a .zip upload',
      () => upload('PK\u0003\u0004\u0000\u0000\u0008\u0000skills/x/SKILL.md'),
      'This is a zip file, not a SKILL.md.',
    ],
    ['pasted text with no frontmatter', () => paste('Just some instructions.'), 'No frontmatter found'],
  ])('rejects %s and leaves the fields untouched', async (_label, importIt, message) => {
    renderForm();
    paste('---\nname: kept\ndescription: Kept\n---\nKept body');
    importIt();
    await waitFor(() => expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent(message));
    expect(value('skill-name-input')).toBe('kept');
    expect(value('skill-body-input')).toBe('Kept body');
  });

  it('does not warn about referenced files that a folder import brought along', async () => {
    renderForm();
    fireEvent.change(screen.getByTestId('skill-form-import-folder'), {
      target: {
        files: [
          inFolder(
            'lint/SKILL.md',
            '---\nname: lint\ndescription: Lint\n---\nRun `scripts/foo.sh` and read reference.md.'
          ),
          inFolder('lint/scripts/foo.sh', 'echo ok'),
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('skill-form-import-supporting-files')).toHaveTextContent(
        'files that were not imported: reference.md.'
      )
    );
    expect(screen.getByTestId('skill-form-import-supporting-files')).not.toHaveTextContent('scripts/foo.sh');
  });

  it('warns about referenced supporting files even when no keys were dropped', () => {
    renderForm();
    paste('---\nname: lint\ndescription: Lint\n---\nRun `scripts/foo.sh` and read [the notes](reference.md).');
    expect(screen.queryByTestId('skill-form-import-dropped')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-form-import-supporting-files')).toHaveTextContent(
      'files that were not imported: reference.md, scripts/foo.sh'
    );
  });

  it.each([
    ['a non-YAML fence', '---js\n{ name: "x" }\n---\nbody'],
    ['invalid YAML', '---\nname: [oops\n---\nbody'],
  ])('shows an error and leaves the form untouched for %s', (_label, text) => {
    renderForm();
    paste(text);
    expect(screen.getByTestId('skill-form-import-error')).toBeInTheDocument();
    expect(value('skill-name-input')).toBe('');
    expect(value('skill-body-input')).toBe('');
  });

  it('flags a Bike4Mind export and warns when it is a third-party market skill', () => {
    const skill = { name: 'mine', description: 'd', body: 'b' };
    const ownUrl = `${window.location.origin}/skills/1`;
    renderForm();
    paste(toSkillMd(skill, { sourceUrl: ownUrl }));
    const own = screen.getByTestId('skill-form-import-from-b4m');
    expect(own).toHaveTextContent('came from Bike4Mind');
    expect(own.querySelector('a')).toHaveAttribute('href', ownUrl);
    expect(screen.queryByTestId('skill-form-import-dropped')).not.toBeInTheDocument();

    paste(toSkillMd(skill, { sourceUrl: `${window.location.origin}/skills/market/2`, thirdParty: true }));
    expect(screen.getByTestId('skill-form-import-from-b4m')).toHaveTextContent("another author's Skill Market skill");
  });

  it('does not link a stamp from another origin and words it neutrally', () => {
    renderForm();
    paste(toSkillMd({ name: 'mine', description: 'd', body: 'b' }, { sourceUrl: 'https://evil.example/x' }));
    const alert = screen.getByTestId('skill-form-import-from-b4m');
    expect(alert.querySelector('a')).toBeNull();
    expect(alert).toHaveTextContent('https://evil.example/x');
    expect(alert).toHaveTextContent('source stamp from another site');
    expect(alert).not.toHaveTextContent('exported from Bike4Mind');
    expect(alert).not.toHaveTextContent('came from Bike4Mind');
  });

  it('words a foreign-origin stamp as foreign even when it carries the third-party line', () => {
    renderForm();
    paste(
      toSkillMd(
        { name: 'mine', description: 'd', body: 'b' },
        { sourceUrl: 'https://evil.example/skills/market/2', thirdParty: true }
      )
    );
    const alert = screen.getByTestId('skill-form-import-from-b4m');
    expect(alert).toHaveTextContent('source stamp from another site');
    expect(alert).not.toHaveTextContent('Skill Market skill');
  });

  it('resets the model-invocation flag when a later file does not set it', () => {
    renderForm();
    paste('---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\nbody');
    const box = screen.getByTestId('skill-disable-model-invocation') as HTMLInputElement;
    expect(box.checked).toBe(true);
    paste('---\nname: b\ndescription: d\n---\nbody');
    expect(box.checked).toBe(false);
  });

  it('shows an error when the chosen file cannot be read', async () => {
    renderForm();
    const file = new File(['x'], 'SKILL.md');
    file.text = () => Promise.reject(new Error('denied'));
    fireEvent.change(screen.getByTestId('skill-form-import-file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent('could not be read'));
    expect(value('skill-name-input')).toBe('');
  });

  it('rejects a file over the size cap without reading it', () => {
    renderForm();
    const big = new File([new Uint8Array(200_001)], 'big.md', { type: 'text/markdown' });
    const read = vi.fn();
    big.text = read;
    fireEvent.change(screen.getByTestId('skill-form-import-file'), { target: { files: [big] } });
    expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent('too large');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not render a non-http source as a link', () => {
    renderForm();
    paste('---\n# Bike4Mind-Source: javascript:alert(1)\nname: x\n---\nb');
    expect(screen.getByTestId('skill-form-import-from-b4m').querySelector('a')).toBeNull();
  });

  it('hides the import strip unless enabled (edit mode)', () => {
    renderForm(false);
    expect(screen.queryByTestId('skill-form-import-skillmd')).not.toBeInTheDocument();
  });

  describe('friendlier errors, drop and zip', () => {
    const SKILL = '---\nname: dropped\ndescription: From a drop\n---\nBody';

    const makeZip = async (entries: Record<string, string>, name = 'skill.zip') => {
      const zip = new JSZip();
      for (const [path, content] of Object.entries(entries)) zip.file(path, content);
      return new File([await zip.generateAsync({ type: 'uint8array' })], name, { type: 'application/zip' });
    };

    const drop = (files: File[]) =>
      fireEvent.drop(screen.getByTestId('skill-form-import-skillmd'), { dataTransfer: { files, items: [] } });

    it('mentions drop and zip in the limitations text', () => {
      renderForm();
      expect(screen.getByTestId('skill-form-import-file-limitations')).toHaveTextContent('drop a SKILL.md');
    });

    it('fills the form from a dropped SKILL.md', async () => {
      renderForm();
      drop([new File([SKILL], 'SKILL.md', { type: 'text/markdown' })]);
      await waitFor(() => expect(value('skill-name-input')).toBe('dropped'));
      expect(value('skill-description-input')).toBe('From a drop');
    });

    it('asks for one SKILL.md or folder when several unrelated files are dropped', async () => {
      renderForm();
      drop([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
      await waitFor(() =>
        expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent(
          'Drop one SKILL.md or one skill folder.'
        )
      );
    });

    it('imports a zip made by compressing a folder, ignoring macOS junk', async () => {
      const onSubmit = vi.fn();
      render(
        <CssVarsProvider theme={appTheme}>
          <SkillForm submitLabel="Create" onSubmit={onSubmit} onCancel={vi.fn()} enableSkillMdImport />
        </CssVarsProvider>
      );
      const zip = await makeZip({
        'my-skill/SKILL.md': SKILL,
        'my-skill/scripts/a.sh': 'echo hi',
        'my-skill/README.md': 'readme',
        '__MACOSX/my-skill/._SKILL.md': 'junk',
        'my-skill/.DS_Store': 'junk',
      });
      drop([zip]);
      await waitFor(() => expect(value('skill-name-input')).toBe('dropped'));
      expect(screen.getByTestId('skill-form-files')).toHaveTextContent('scripts/a.sh');
      fireEvent.change(screen.getByTestId('skill-body-input'), { target: { value: 'Body' } });
      fireEvent.submit(screen.getByTestId('skill-form'));
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ files: [{ path: 'scripts/a.sh', content: 'echo hi' }] })
      );
    });

    it('imports a zip chosen with Choose file', async () => {
      renderForm();
      const zip = await makeZip({ 'SKILL.md': SKILL });
      fireEvent.change(screen.getByTestId('skill-form-import-file'), { target: { files: [zip] } });
      await waitFor(() => expect(value('skill-name-input')).toBe('dropped'));
    });

    it('explains a zip with no SKILL.md', async () => {
      renderForm();
      drop([await makeZip({ 'a/readme.md': 'x', 'b/other.md': 'y' })]);
      await waitFor(() =>
        expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent(
          'The zip has no SKILL.md at its top level or in a single top-level folder.'
        )
      );
    });

    it('explains a zip that cannot be read', async () => {
      renderForm();
      drop([new File(['not a zip'], 'broken.zip')]);
      await waitFor(() =>
        expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent("The zip couldn't be unzipped.")
      );
    });

    it('warns when the imported description is over 500 characters but still applies it', async () => {
      renderForm();
      upload(`---\nname: long\ndescription: ${'a'.repeat(501)}\n---\nBody`);
      await waitFor(() =>
        expect(screen.getByTestId('skill-form-import-description-length')).toHaveTextContent(
          'The description is 501 characters; skills allow 500. Shorten it before saving.'
        )
      );
      expect(value('skill-name-input')).toBe('long');
      fireEvent.change(screen.getByTestId('skill-description-input'), { target: { value: 'short' } });
      expect(screen.queryByTestId('skill-form-import-description-length')).not.toBeInTheDocument();
    });

    it('shows the raw YAML message behind a Details toggle', async () => {
      renderForm();
      upload("---\nname: a\ndescription: Applies the team's rules: TikTok-safe\n---\nBody");
      await waitFor(() =>
        expect(screen.getByTestId('skill-form-import-error')).toHaveTextContent('Line 3 (`description`)')
      );
      expect(screen.queryByTestId('skill-form-import-error-details')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('skill-form-import-error-details-toggle'));
      expect(screen.getByTestId('skill-form-import-error-details')).toHaveTextContent('Nested mappings');
    });
  });
});

describe('SkillForm update from SKILL.md (edit mode)', () => {
  const EXISTING = {
    name: 'summarize',
    description: 'Old description',
    body: 'Old body',
    argumentHint: '[file]',
    files: [{ path: 'scripts/run.sh', content: 'echo old' }],
  };
  const NEW_MD = '---\nname: summarize\ndescription: New description\n---\nNew body';

  const renderEdit = (onSubmit = vi.fn()) => {
    render(
      <CssVarsProvider theme={appTheme}>
        <SkillForm
          initialValue={EXISTING}
          submitLabel="Save changes"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          updateFromSkillMd
        />
      </CssVarsProvider>
    );
    return onSubmit;
  };

  it('shows the changed fields and leaves the form alone until applied', async () => {
    renderEdit();
    upload(NEW_MD);
    expect(await screen.findByTestId('skill-form-update-preview')).toBeInTheDocument();
    expect(screen.getByTestId('skill-form-update-change-description')).toHaveTextContent('New description');
    expect(screen.getByTestId('skill-form-update-change-body')).toBeInTheDocument();
    expect(screen.getByTestId('skill-form-update-change-argument-hint')).toHaveTextContent('(none)');
    expect(value('skill-description-input')).toBe('Old description');
    expect(value('skill-body-input')).toBe('Old body');
  });

  it('applies on confirm and submits the updated fields with the same name', async () => {
    const onSubmit = renderEdit();
    upload(NEW_MD);
    fireEvent.click(await screen.findByTestId('skill-form-update-apply'));
    expect(value('skill-description-input')).toBe('New description');
    expect(screen.queryByTestId('skill-form-update-preview')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'summarize', description: 'New description', body: 'New body' })
    );
  });

  it('discards without touching the form', async () => {
    renderEdit();
    upload(NEW_MD);
    fireEvent.click(await screen.findByTestId('skill-form-update-discard'));
    expect(screen.queryByTestId('skill-form-update-preview')).toBeNull();
    expect(value('skill-description-input')).toBe('Old description');
  });

  it('warns on a name mismatch and keeps the existing name', async () => {
    renderEdit();
    upload('---\nname: other-name\ndescription: New description\n---\nNew body');
    expect(await screen.findByTestId('skill-form-update-name-mismatch')).toHaveTextContent('other-name');
    fireEvent.click(screen.getByTestId('skill-form-update-apply'));
    expect(value('skill-name-input')).toBe('summarize');
  });

  it('says so when the file matches the skill', async () => {
    renderEdit();
    upload('---\nname: summarize\ndescription: Old description\nargument-hint: "[file]"\n---\nOld body');
    expect(await screen.findByTestId('skill-form-update-preview')).toHaveTextContent('Nothing would change');
    expect(screen.getByTestId('skill-form-update-apply')).toBeDisabled();
  });

  it('shows invalid files the same actionable error as create', async () => {
    renderEdit();
    upload('no frontmatter here');
    expect(await screen.findByTestId('skill-form-import-error')).toHaveTextContent('No frontmatter found');
    expect(screen.queryByTestId('skill-form-update-preview')).toBeNull();
  });

  it('previews a folder import, flags changed scripts and replaces files only on apply', async () => {
    const onSubmit = renderEdit();
    fireEvent.change(screen.getByTestId('skill-form-import-folder'), {
      target: {
        files: [inFolder('s/SKILL.md', NEW_MD), inFolder('s/scripts/run.sh', 'echo new')],
      },
    });
    expect(await screen.findByTestId('skill-form-update-change-files')).toHaveTextContent('changed scripts/run.sh');
    expect(screen.getByTestId('skill-form-update-scripts-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('skill-form-update-apply'));
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ files: [{ path: 'scripts/run.sh', content: 'echo new' }] })
    );
  });

  it('keeps existing files when a lone SKILL.md is applied', async () => {
    const onSubmit = renderEdit();
    upload(NEW_MD);
    fireEvent.click(await screen.findByTestId('skill-form-update-apply'));
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ files: EXISTING.files }));
  });

  it('accepts a pasted SKILL.md', async () => {
    renderEdit();
    paste(NEW_MD);
    expect(await screen.findByTestId('skill-form-update-preview')).toBeInTheDocument();
  });
});
