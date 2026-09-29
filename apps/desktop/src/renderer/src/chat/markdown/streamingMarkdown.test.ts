import { describe, expect, it } from 'vitest';
import { closeOpenFence } from './streamingMarkdown';

describe('closeOpenFence', () => {
  it('leaves text with no fence alone', () => {
    expect(closeOpenFence('Just a sentence.')).toBe('Just a sentence.');
  });

  it('leaves a closed fence alone', () => {
    const text = '```ts\nconst x = 1;\n```';
    expect(closeOpenFence(text)).toBe(text);
  });

  it('closes a fence that is still streaming its body', () => {
    expect(closeOpenFence('```ts\nconst x = 1;')).toBe('```ts\nconst x = 1;\n```');
  });

  it('closes an opening fence that is the whole text so far', () => {
    expect(closeOpenFence('```ts')).toBe('```ts\n```');
  });

  it('does not double the newline when the text already ends with one', () => {
    expect(closeOpenFence('```ts\nconst x = 1;\n')).toBe('```ts\nconst x = 1;\n```');
  });

  it('closes a tilde fence with a tilde fence', () => {
    expect(closeOpenFence('~~~py\nx = 1')).toBe('~~~py\nx = 1\n~~~');
  });

  it('matches the opening fence length, so a longer fence can hold backticks', () => {
    expect(closeOpenFence('````md\n```ts\n')).toBe('````md\n```ts\n````');
  });

  it('does not treat a shorter inner fence as the close of a longer one', () => {
    expect(closeOpenFence('````\n```\n')).toBe('````\n```\n````');
  });

  it('reopens after a closed block, so only the trailing fence is completed', () => {
    expect(closeOpenFence('```ts\na\n```\ntext\n```py\nb')).toBe('```ts\na\n```\ntext\n```py\nb\n```');
  });

  it('ignores a line whose info string carries a backtick, which opens nothing', () => {
    expect(closeOpenFence('```a`b')).toBe('```a`b');
  });

  it('does not close on a fence line that carries trailing content', () => {
    expect(closeOpenFence('```ts\nx\n``` trailing')).toBe('```ts\nx\n``` trailing\n```');
  });

  it('accepts up to three spaces of indent on the fence', () => {
    expect(closeOpenFence('   ```ts\nx')).toBe('   ```ts\nx\n```');
  });

  it('leaves a four-space indented line alone, which is an indented code block', () => {
    expect(closeOpenFence('    ```ts\nx')).toBe('    ```ts\nx');
  });

  it('is idempotent', () => {
    const once = closeOpenFence('```ts\nconst x = 1;');
    expect(closeOpenFence(once)).toBe(once);
  });
});
