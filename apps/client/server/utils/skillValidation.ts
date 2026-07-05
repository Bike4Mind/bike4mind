/**
 * Shared validators for the `/api/skills` CRUD endpoints. Bounds-check user
 * input before it reaches Mongoose so malformed requests yield a 400 instead
 * of leaking schema details via a 500. Kept in sync with SkillModel's maxlength
 * constraints - see packages/database/src/models/ai/SkillModel.ts.
 */

import { BadRequestError } from '@bike4mind/utils';
import { validateToolList } from './agentValidation';

const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 500;
const SKILL_BODY_MAX = 50_000;
const SKILL_ARG_HINT_MAX = 200;

/** kebab-case: lowercase letters, digits, hyphens; can't start/end with `-`. */
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function validateSkillName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError('Skill name is required');
  }
  const name = value.trim();
  if (name.length > SKILL_NAME_MAX) {
    throw new BadRequestError(`Skill name must be ${SKILL_NAME_MAX} characters or fewer`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new BadRequestError(
      'Skill name must be kebab-case (lowercase letters, digits, hyphens; cannot start or end with a hyphen)'
    );
  }
  return name;
}

export function validateSkillDescription(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError('Skill description is required');
  }
  const description = value.trim();
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new BadRequestError(`Skill description must be ${SKILL_DESCRIPTION_MAX} characters or fewer`);
  }
  return description;
}

export function validateSkillBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError('Skill body is required');
  }
  if (value.length > SKILL_BODY_MAX) {
    throw new BadRequestError(`Skill body must be ${SKILL_BODY_MAX} characters or fewer`);
  }
  return value;
}

export function validateSkillArgumentHint(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestError('argumentHint must be a string');
  }
  if (value.length > SKILL_ARG_HINT_MAX) {
    throw new BadRequestError(`argumentHint must be ${SKILL_ARG_HINT_MAX} characters or fewer`);
  }
  return value;
}

export function validateSkillAllowedTools(value: unknown): string[] | undefined {
  // Reuse the agent validator - same 100-entry / 256-char-per-entry bounds apply.
  return validateToolList(value, 'allowedTools');
}
