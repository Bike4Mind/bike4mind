import React, { FC, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import { SkillFormInput } from '@client/app/hooks/data/skills';

export interface SkillFormProps {
  initialValue?: Partial<SkillFormInput>;
  submitting?: boolean;
  submitLabel: string;
  onSubmit: (input: SkillFormInput) => void;
  onCancel: () => void;
}

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

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
}) => {
  const [name, setName] = useState(initialValue?.name ?? '');
  const [description, setDescription] = useState(initialValue?.description ?? '');
  const [body, setBody] = useState(initialValue?.body ?? '');
  const [argumentHint, setArgumentHint] = useState(initialValue?.argumentHint ?? '');
  const [disableModelInvocation, setDisableModelInvocation] = useState(Boolean(initialValue?.disableModelInvocation));

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
      disableModelInvocation,
    });
  };

  return (
    <Box component="form" onSubmit={handleSubmit} data-testid="skill-form">
      <Stack spacing={3}>
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
