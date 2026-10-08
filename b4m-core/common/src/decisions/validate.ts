import type { DecisionsRequest } from '../schemas/decisions';
import { DECISION_PLATFORM_LIMITS } from './catalog';
import type { DecisionModelCapabilities } from './types';

declare const validatedBrand: unique symbol;
/** A request checked against its model's caps. Branded, so `validateDecisionRequest` is the only way to obtain one. */
export type ValidatedDecisionRequest = DecisionsRequest & { readonly [validatedBrand]: true };

export const DECISION_VALIDATION_ERROR_CODES = ['limit_exceeded', 'unsupported_input', 'invalid_request'] as const;
export type DecisionValidationErrorCode = (typeof DECISION_VALIDATION_ERROR_CODES)[number];

export type DecisionValidationFailure = {
  ok: false;
  code: DecisionValidationErrorCode;
  message: string;
  /** Path of the offending field, e.g. `questions[1].choices`. */
  param: string;
};
export type DecisionValidationResult = { ok: true; request: ValidatedDecisionRequest } | DecisionValidationFailure;

const fail = (code: DecisionValidationErrorCode, param: string, message: string): DecisionValidationFailure => ({
  ok: false,
  code,
  param,
  message,
});

const firstDuplicateIndex = (values: readonly string[]): number =>
  values.findIndex((value, index) => values.indexOf(value) !== index);

const validateQuestions = (
  request: DecisionsRequest,
  caps: DecisionModelCapabilities
): DecisionValidationFailure | null => {
  const { limits, displayName } = caps;
  if (request.questions.length > limits.maxQuestions) {
    return fail('limit_exceeded', 'questions', `${displayName} accepts at most ${limits.maxQuestions} questions`);
  }
  const duplicateName = firstDuplicateIndex(request.questions.map(question => question.name));
  if (duplicateName !== -1) {
    return fail('invalid_request', `questions[${duplicateName}].name`, 'Question names must be unique');
  }
  for (const [index, question] of request.questions.entries()) {
    const param = `questions[${index}]`;
    if (question.type === 'choice') {
      if (question.choices.length > limits.maxChoices) {
        return fail(
          'limit_exceeded',
          `${param}.choices`,
          `${displayName} accepts at most ${limits.maxChoices} choices`
        );
      }
      const duplicateValue = firstDuplicateIndex(question.choices.map(choice => choice.value));
      if (duplicateValue !== -1) {
        return fail('invalid_request', `${param}.choices[${duplicateValue}].value`, 'Choice values must be unique');
      }
    }
    if (question.type === 'score' && question.levels.length > limits.maxLevels) {
      return fail('limit_exceeded', `${param}.levels`, `${displayName} accepts at most ${limits.maxLevels} levels`);
    }
  }
  return null;
};

const validateInput = (
  request: DecisionsRequest,
  caps: DecisionModelCapabilities
): DecisionValidationFailure | null => {
  if (typeof request.input === 'string') return null;
  const { limits, displayName } = caps;
  let imageCount = 0;
  for (const [index, part] of request.input.entries()) {
    const param = `input[${index}]`;
    if (part.type === 'json' && JSON.stringify(part.json).length > DECISION_PLATFORM_LIMITS.maxTextLength) {
      return fail(
        'limit_exceeded',
        `${param}.json`,
        `json parts are limited to ${DECISION_PLATFORM_LIMITS.maxTextLength} characters`
      );
    }
    if (part.type !== 'image') continue;
    if ((part.file_id === undefined) === (part.image_url === undefined)) {
      return fail('invalid_request', param, 'An image part needs exactly one of file_id or image_url');
    }
    if (limits.maxImages === 0) {
      return fail('unsupported_input', param, `${displayName} does not accept images`);
    }
    imageCount += 1;
    if (imageCount > limits.maxImages) {
      return fail('limit_exceeded', param, `${displayName} accepts at most ${limits.maxImages} images`);
    }
  }
  return null;
};

/** Checks what the request schema cannot: uniqueness, image-part shape and the model's own caps. Never clamps. */
export const validateDecisionRequest = (
  request: DecisionsRequest,
  caps: DecisionModelCapabilities
): DecisionValidationResult =>
  validateQuestions(request, caps) ??
  validateInput(request, caps) ?? { ok: true, request: request as ValidatedDecisionRequest };

export const decisionRequestHasImages = (request: DecisionsRequest): boolean =>
  typeof request.input !== 'string' && request.input.some(part => part.type === 'image');
