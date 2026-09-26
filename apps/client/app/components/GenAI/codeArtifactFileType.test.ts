import { describe, it, expect } from 'vitest';
import { getCodeFileType } from './codeArtifactFileType';

describe('getCodeFileType', () => {
  it('maps typescript variants to .ts / text/typescript, and tsx separately', () => {
    expect(getCodeFileType('typescript')).toEqual({ ext: 'ts', mime: 'text/typescript' });
    expect(getCodeFileType('ts')).toEqual({ ext: 'ts', mime: 'text/typescript' });
    expect(getCodeFileType('tsx')).toEqual({ ext: 'tsx', mime: 'text/typescript' });
  });

  it('maps javascript variants to .js / text/javascript, and jsx separately', () => {
    expect(getCodeFileType('javascript')).toEqual({ ext: 'js', mime: 'text/javascript' });
    expect(getCodeFileType('js')).toEqual({ ext: 'js', mime: 'text/javascript' });
    expect(getCodeFileType('jsx')).toEqual({ ext: 'jsx', mime: 'text/javascript' });
  });

  it('maps python variants to .py / text/x-python', () => {
    expect(getCodeFileType('python')).toEqual({ ext: 'py', mime: 'text/x-python' });
    expect(getCodeFileType('py')).toEqual({ ext: 'py', mime: 'text/x-python' });
  });

  it('maps html and css', () => {
    expect(getCodeFileType('html')).toEqual({ ext: 'html', mime: 'text/html' });
    expect(getCodeFileType('css')).toEqual({ ext: 'css', mime: 'text/css' });
  });

  it('maps json', () => {
    expect(getCodeFileType('json')).toEqual({ ext: 'json', mime: 'application/json' });
  });

  it('maps csv to text/csv rather than the old text/plain default', () => {
    expect(getCodeFileType('csv')).toEqual({ ext: 'csv', mime: 'text/csv' });
  });

  it('maps markdown variants', () => {
    expect(getCodeFileType('markdown')).toEqual({ ext: 'md', mime: 'text/markdown' });
    expect(getCodeFileType('md')).toEqual({ ext: 'md', mime: 'text/markdown' });
  });

  it('maps yaml variants', () => {
    expect(getCodeFileType('yaml')).toEqual({ ext: 'yml', mime: 'text/yaml' });
    expect(getCodeFileType('yml')).toEqual({ ext: 'yml', mime: 'text/yaml' });
  });

  it('maps shell variants to .sh / text/x-sh', () => {
    expect(getCodeFileType('bash')).toEqual({ ext: 'sh', mime: 'text/x-sh' });
    expect(getCodeFileType('sh')).toEqual({ ext: 'sh', mime: 'text/x-sh' });
    expect(getCodeFileType('shell')).toEqual({ ext: 'sh', mime: 'text/x-sh' });
  });

  it('maps sql', () => {
    expect(getCodeFileType('sql')).toEqual({ ext: 'sql', mime: 'text/x-sql' });
  });

  it('maps xml', () => {
    expect(getCodeFileType('xml')).toEqual({ ext: 'xml', mime: 'application/xml' });
  });

  it('falls back to txt / text/plain for an unknown language', () => {
    expect(getCodeFileType('brainfuck')).toEqual({ ext: 'txt', mime: 'text/plain' });
  });

  it('is case-insensitive', () => {
    expect(getCodeFileType('TypeScript')).toEqual({ ext: 'ts', mime: 'text/typescript' });
    expect(getCodeFileType('CSV')).toEqual({ ext: 'csv', mime: 'text/csv' });
  });
});
