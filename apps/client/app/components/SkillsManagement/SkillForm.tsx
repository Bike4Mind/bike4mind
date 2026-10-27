import React, { FC, useCallback, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Link,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import { parseSkillMd, referencedRelativePaths, type ParseSkillMdResult } from '@bike4mind/common/utils/skillMd';
import { SKILL_FILE_DIRS, checkSkillFiles, type ISkillFile } from '@bike4mind/common';
import { SkillFormInput } from '@client/app/hooks/data/skills';

export interface SkillFormProps {
  initialValue?: Partial<SkillFormInput>;
  submitting?: boolean;
  submitLabel: string;
  onSubmit: (input: SkillFormInput) => void;
  onCancel: () => void;
  /** Show the "Import SKILL.md" strip (create mode only; it prefills the fields). */
  enableSkillMdImport?: boolean;
}

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Bounds a local file read; the server accepts 50k characters, so this is already generous. */
const MAX_IMPORT_BYTES = 200_000;

/**
 * A picked skill folder (`webkitRelativePath` is `<folder>/...`): its top-level SKILL.md, the text
 * files under scripts/ and references/, and the other files it skipped. Dotfiles are skipped silently.
 */
export async function readSkillFolder(
  picked: File[]
): Promise<{ ok: true; skillMd: string; files: ISkillFile[]; skipped: string[] } | { ok: false; error: string }> {
  let skillMd: File | undefined;
  const files: ISkillFile[] = [];
  const skipped: string[] = [];
  for (const file of picked) {
    const path = file.webkitRelativePath.split('/').slice(1).join('/');
    if (path.split('/').some(segment => segment.startsWith('.'))) continue;
    if (path === 'SKILL.md') {
      skillMd = file;
    } else if ((SKILL_FILE_DIRS as readonly string[]).includes(path.split('/')[0])) {
      if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: `${path} is too large to import.` };
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        files.push({ path, content });
      } catch {
        return { ok: false, error: `${path}: only text files are supported.` };
      }
    } else {
      skipped.push(path);
    }
  }
  if (!skillMd) return { ok: false, error: 'The folder has no SKILL.md at its top level.' };
  if (skillMd.size > MAX_IMPORT_BYTES) return { ok: false, error: 'SKILL.md is too large to import (200 KB maximum).' };
  const checked = checkSkillFiles(files);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, skillMd: await skillMd.text(), files: checked.files, skipped };
}

/** Only a same-origin export gets a clickable provenance link; anything else stays plain text. */
const isSameOrigin = (url: string): boolean => {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
};

/**
 * Single MUI Joy form reused by `/skills/new` and `/skills/$id/edit`.
 * Mirrors the server-side `validateSkill*` bounds so the user gets immediate
 * feedback instead of a network round-trip for trivially-wrong input.
 */
export const SkillForm: FC<SkillFormProps> = ({
  initialValue,
  submitting = false,
  submitLabel,
  onSubmit,
  onCancel,
  enableSkillMdImport = false,
}) => {
  const [name, setName] = useState(initialValue?.name ?? '');
  const [description, setDescription] = useState(initialValue?.description ?? '');
  const [body, setBody] = useState(initialValue?.body ?? '');
  const [argumentHint, setArgumentHint] = useState(initialValue?.argumentHint ?? '');
  const [disableModelInvocation, setDisableModelInvocation] = useState(Boolean(initialValue?.disableModelInvocation));
  const [claudeCodeAllowedTools, setClaudeCodeAllowedTools] = useState(initialValue?.claudeCodeAllowedTools ?? []);
  const [importResult, setImportResult] = useState<ParseSkillMdResult | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [files, setFiles] = useState<ISkillFile[]>(initialValue?.files ?? []);
  const [skippedFiles, setSkippedFiles] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // React has no typed prop for webkitdirectory (precedent: DataLakeWizard SourceSelectionStep).
  const setFolderInputRef = useCallback((input: HTMLInputElement | null) => {
    folderInputRef.current = input;
    input?.setAttribute('webkitdirectory', '');
  }, []);
  // Bumped by every import so a slow earlier file read cannot overwrite a newer one.
  const importReadId = useRef(0);

  // Replaces argument hint, Claude Code tools and model-invocation flag with the file's values; other fields change only if the file sets them. A malformed file touches nothing.
  const applySkillMd = (text: string): boolean => {
    // Checked here, not in parseSkillMd: the CLI relies on it accepting a frontmatter-less commands/*.md.
    if (text.includes('\u0000')) {
      setImportResult({ ok: false, error: 'This is not a text file (it looks like a binary or .zip file).' });
      return false;
    }
    if (!/^\uFEFF?---/.test(text)) {
      setImportResult({ ok: false, error: 'No frontmatter found: a SKILL.md starts with a --- block.' });
      return false;
    }
    const result = parseSkillMd(text);
    setImportResult(result);
    if (!result.ok) return false;
    const { fields } = result;
    if (fields.name !== undefined) setName(fields.name);
    if (fields.description !== undefined) setDescription(fields.description);
    setArgumentHint(fields.argumentHint ?? '');
    if (fields.body !== undefined) setBody(fields.body);
    setDisableModelInvocation(fields.disableModelInvocation ?? false);
    setClaudeCodeAllowedTools(fields.claudeCodeAllowedTools ?? []);
    setPasteOpen(false);
    setPasteText('');
    return true;
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const readId = ++importReadId.current;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportResult({ ok: false, error: 'The file is too large to import (200 KB maximum).' });
      return;
    }
    file
      .text()
      .then(text => {
        if (readId === importReadId.current) applySkillMd(text);
      })
      .catch(() => {
        if (readId === importReadId.current) setImportResult({ ok: false, error: 'The file could not be read.' });
      });
  };

  const handleFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!picked.length) return;
    const readId = ++importReadId.current;
    void readSkillFolder(picked).then(result => {
      if (readId !== importReadId.current) return;
      if (!result.ok) {
        setImportResult({ ok: false, error: result.error });
        return;
      }
      if (!applySkillMd(result.skillMd)) return;
      setFiles(result.files);
      setSkippedFiles(result.skipped);
    });
  };

  const applyPasted = () => {
    importReadId.current += 1;
    applySkillMd(pasteText);
  };

  const source = importResult?.ok ? importResult.source : undefined;
  const sourceIsSameOrigin = source ? isSameOrigin(source.url) : false;
  // Files a folder import brought in are not missing, so they do not count toward the warning.
  const supportingFiles = importResult?.ok
    ? referencedRelativePaths(importResult.fields.body ?? '').filter(path => !files.some(f => f.path === path))
    : [];

  const nameError =
    name.length === 0
      ? 'Name is required'
      : name.length > 64
        ? 'Name must be 64 characters or fewer'
        : !SKILL_NAME_PATTERN.test(name)
          ? 'Use lowercase letters, digits, and hyphens (e.g. summarize, review-pr)'
          : null;

  const descriptionError =
    description.trim().length === 0
      ? 'Description is required'
      : description.length > 500
        ? 'Description must be 500 characters or fewer'
        : null;

  const bodyError =
    body.trim().length === 0
      ? 'Body is required'
      : body.length > 50_000
        ? 'Body must be 50000 characters or fewer'
        : null;

  const isValid = !nameError && !descriptionError && !bodyError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      body,
      ...(argumentHint.trim() && { argumentHint: argumentHint.trim() }),
      // Always sent, so re-importing a file without allowed-tools clears it on edit.
      claudeCodeAllowedTools,
      disableModelInvocation,
      files,
    });
  };

  return (
    <Box component="form" onSubmit={handleSubmit} data-testid="skill-form">
      <Stack spacing={3}>
        {enableSkillMdImport ? (
          <Stack spacing={1.5} data-testid="skill-form-import-skillmd">
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography level="title-sm">Import SKILL.md</Typography>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,text/markdown"
                hidden
                onChange={handleFile}
                data-testid="skill-form-import-file"
              />
              <Button size="sm" variant="outlined" onClick={() => fileInputRef.current?.click()} disabled={submitting}>
                Choose file
              </Button>
              <input
                ref={setFolderInputRef}
                type="file"
                hidden
                onChange={handleFolder}
                data-testid="skill-form-import-folder"
              />
              <Button
                size="sm"
                variant="outlined"
                onClick={() => folderInputRef.current?.click()}
                disabled={submitting}
              >
                Choose folder
              </Button>
              <Button
                size="sm"
                variant="plain"
                onClick={() => setPasteOpen(open => !open)}
                disabled={submitting}
                data-testid="skill-form-import-paste-toggle"
              >
                Paste
              </Button>
            </Stack>
            <Typography level="body-xs" textColor="text.tertiary" data-testid="skill-form-import-file-limitations">
              Choose a skill folder to also import the text files in its scripts/ and references/ folders. Scripts run
              on the user&apos;s machine, so a skill with scripts is always reviewed by a person before it is shared in
              the Skill Market.
            </Typography>
            {pasteOpen ? (
              <Stack spacing={1}>
                <Textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder={'---\nname: my-skill\ndescription: ...\n---\n\nInstructions'}
                  minRows={4}
                  slotProps={{ textarea: { 'data-testid': 'skill-form-import-paste-input' } }}
                />
                <Button
                  size="sm"
                  sx={{ alignSelf: 'flex-start' }}
                  onClick={applyPasted}
                  disabled={!pasteText.trim()}
                  data-testid="skill-form-import-paste-apply"
                >
                  Apply
                </Button>
              </Stack>
            ) : null}
            {importResult && !importResult.ok ? (
              <Alert color="danger" variant="soft" data-testid="skill-form-import-error">
                Couldn&apos;t read that SKILL.md: {importResult.error}
              </Alert>
            ) : null}
            {source ? (
              <Alert
                color={source.thirdParty || !sourceIsSameOrigin ? 'warning' : 'primary'}
                variant="soft"
                data-testid="skill-form-import-from-b4m"
              >
                <span>
                  {!sourceIsSameOrigin
                    ? 'This file has a Bike4Mind source stamp from another site: '
                    : source.thirdParty
                      ? "This is another author's Skill Market skill; import it from the market to keep updates and attribution: "
                      : 'This skill came from Bike4Mind - open the original instead of making a copy: '}
                  {sourceIsSameOrigin ? (
                    <Link href={source.url} target="_blank" rel="noopener noreferrer">
                      {source.url}
                    </Link>
                  ) : (
                    source.url
                  )}
                </span>
              </Alert>
            ) : null}
            {importResult?.ok && importResult.dropped.length ? (
              <Alert color="warning" variant="soft" data-testid="skill-form-import-dropped">
                Not supported in Bike4Mind skills: {importResult.dropped.join(', ')}. These were ignored.
              </Alert>
            ) : null}
            {supportingFiles.length ? (
              <Alert color="warning" variant="soft" data-testid="skill-form-import-supporting-files">
                This skill references files that were not imported: {supportingFiles.slice(0, 5).join(', ')}
                {supportingFiles.length > 5 ? ` and ${supportingFiles.length - 5} more` : ''}. Paste what it needs into
                the body, or the skill may not work.
              </Alert>
            ) : null}
          </Stack>
        ) : null}

        <FormControl error={Boolean(nameError && name.length > 0)} required>
          <FormLabel>Name</FormLabel>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. summarize"
            slotProps={{ input: { 'data-testid': 'skill-name-input' } }}
            disabled={submitting}
            autoFocus={!initialValue?.name}
          />
          <FormHelperText>
            {nameError && name.length > 0
              ? nameError
              : 'Used as the slash command: /name. Lowercase letters, digits, hyphens.'}
          </FormHelperText>
        </FormControl>

        <FormControl error={Boolean(descriptionError && description.length > 0)} required>
          <FormLabel>Description</FormLabel>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="One-line summary shown in the slash-command picker"
            slotProps={{ input: { 'data-testid': 'skill-description-input' } }}
            disabled={submitting}
          />
          <FormHelperText>{descriptionError && description.length > 0 ? descriptionError : ' '}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Argument hint</FormLabel>
          <Input
            value={argumentHint}
            onChange={e => setArgumentHint(e.target.value)}
            placeholder="e.g. [file] [priority]"
            slotProps={{ input: { 'data-testid': 'skill-argument-hint-input' } }}
            disabled={submitting}
          />
          <FormHelperText>Optional — appears next to the name in the picker.</FormHelperText>
        </FormControl>

        {claudeCodeAllowedTools.length ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="skill-form-claude-code-tools">
            Claude Code tools: {claudeCodeAllowedTools.join(', ')}. Kept for Claude Code exports; not used in Bike4Mind.{' '}
            <Link
              component="button"
              type="button"
              level="body-sm"
              onClick={() => setClaudeCodeAllowedTools([])}
              disabled={submitting}
              data-testid="skill-form-claude-code-tools-remove"
            >
              Remove
            </Link>
          </Typography>
        ) : null}

        <FormControl error={Boolean(bodyError && body.length > 0)} required>
          <FormLabel>Body</FormLabel>
          <Textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Markdown instructions. Use $ARGUMENTS for all args, $1, $2 for positional args."
            minRows={10}
            // Let the field grow with the body. The surrounding page already
            // scrolls (overflowY: auto on the route container), so capping the
            // textarea height created a nested-scroll trap on long skill bodies.
            slotProps={{ textarea: { 'data-testid': 'skill-body-input' } }}
            disabled={submitting}
          />
          <FormHelperText>
            {bodyError && body.length > 0 ? bodyError : `${body.length} / 50000 characters`}
          </FormHelperText>
        </FormControl>

        {files.length || skippedFiles.length ? (
          <Stack spacing={1} data-testid="skill-form-files">
            {files.length ? (
              <>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography level="title-sm">Supporting files ({files.length})</Typography>
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={() => setFiles([])}
                    disabled={submitting}
                    data-testid="skill-form-files-remove"
                  >
                    Remove files
                  </Button>
                </Stack>
                <Typography level="body-sm" component="ul" sx={{ m: 0, pl: 3, fontFamily: 'code' }}>
                  {files.map(f => (
                    <li key={f.path}>{f.path}</li>
                  ))}
                </Typography>
              </>
            ) : null}
            {skippedFiles.length ? (
              <Alert color="warning" variant="soft" data-testid="skill-form-files-skipped">
                Not imported (only SKILL.md, scripts/ and references/ are): {skippedFiles.slice(0, 10).join(', ')}
                {skippedFiles.length > 10 ? ` and ${skippedFiles.length - 10} more` : ''}
              </Alert>
            ) : null}
          </Stack>
        ) : null}

        <FormControl>
          <Checkbox
            checked={disableModelInvocation}
            onChange={e => setDisableModelInvocation(e.target.checked)}
            label="Hide from LLM auto-invocation"
            // Put the test id on the underlying input so Playwright /
            // testing-library can target the form control, not just the
            // wrapping `<span>` the Checkbox renders by default.
            slotProps={{ input: { 'data-testid': 'skill-disable-model-invocation' } }}
            disabled={submitting}
          />
          <FormHelperText sx={{ ml: 4 }}>
            When on, this skill is only invoked when the user types{' '}
            <Typography component="code">/{name || 'name'}</Typography>. The LLM won&apos;t pick it up via the `skill`
            tool.
          </FormHelperText>
        </FormControl>

        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button
            variant="plain"
            color="neutral"
            onClick={onCancel}
            disabled={submitting}
            data-testid="skill-form-cancel"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!isValid || submitting} loading={submitting} data-testid="skill-form-submit">
            {submitLabel}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
};

export default SkillForm;
