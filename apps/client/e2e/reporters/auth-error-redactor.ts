import type { Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import { redactAuthError } from '../helpers/error-text';

function redactStepErrors(step: TestStep): void {
  if (step.error) redactAuthError(step.error);
  for (const child of step.steps) redactStepErrors(child);
}

/** Runs first so downstream reporters receive scrubbed step and test errors. */
export default class AuthErrorRedactor implements Reporter {
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    redactStepErrors(step);
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const error of result.errors) redactAuthError(error);
    for (const step of result.steps) redactStepErrors(step);
  }

  onError(error: TestError): void {
    redactAuthError(error);
  }

  printsToStdio(): boolean {
    return false;
  }
}
