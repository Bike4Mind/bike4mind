import { describe, expect, it } from 'vitest';
import { UpdateFileRequestSchema } from './publicFile';

describe('UpdateFileRequestSchema', () => {
  it.each(['', '   ', '\t\n'])('rejects a blank file name (%j)', fileName => {
    expect(UpdateFileRequestSchema.safeParse({ file_name: fileName }).success).toBe(false);
  });

  it('trims the file name it accepts', () => {
    expect(UpdateFileRequestSchema.parse({ file_name: '  report.pdf  ' })).toEqual({ file_name: 'report.pdf' });
  });

  it('measures the length limit after trimming', () => {
    expect(UpdateFileRequestSchema.safeParse({ file_name: ` ${'a'.repeat(255)} ` }).success).toBe(true);
    expect(UpdateFileRequestSchema.safeParse({ file_name: 'a'.repeat(256) }).success).toBe(false);
  });
});
