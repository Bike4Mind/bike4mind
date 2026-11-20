import { describe, expect, it } from 'vitest';
import { buildSystemMessage } from './ChatService';

const build = (roots: string[], plan: boolean): string =>
  String(
    buildSystemMessage(
      roots,
      false,
      false,
      false,
      [],
      undefined,
      [],
      '',
      false,
      false,
      false,
      '',
      true,
      '',
      false,
      false,
      false,
      false,
      plan
    ).content
  );

describe('PLAN_GUIDANCE', () => {
  it.each([[['/work']], [[]]])('steers todo_write use with or without a folder (roots %j)', roots => {
    expect(build(roots, true)).toContain('Keep one with todo_write only when');
  });

  // A model without tools, or one whose tools were shed to fit a fixed context, has no todo_write.
  it.each([[['/work']], [[]]])('is left out when todo_write is not declared (roots %j)', roots => {
    expect(build(roots, false)).not.toContain('todo_write');
  });
});
