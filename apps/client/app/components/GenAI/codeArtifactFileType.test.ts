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

  // Regression: these languages had no entry, so they fell back to the generic .txt default -
  // a regression from before this map existed, when they saved as `.${lang}` and were accepted
  // because the server's EXT_TO_MIME (b4m-core/utils/src/file.ts) already knows the extension.
  it('maps the previously-missing languages to their real extension and MIME', () => {
    expect(getCodeFileType('go')).toEqual({ ext: 'go', mime: 'text/x-go' });
    expect(getCodeFileType('java')).toEqual({ ext: 'java', mime: 'text/x-java-source' });
    expect(getCodeFileType('c')).toEqual({ ext: 'c', mime: 'text/x-c++src' });
    expect(getCodeFileType('cpp')).toEqual({ ext: 'cpp', mime: 'text/x-c++src' });
    expect(getCodeFileType('c++')).toEqual({ ext: 'cpp', mime: 'text/x-c++src' });
    expect(getCodeFileType('cc')).toEqual({ ext: 'cpp', mime: 'text/x-c++src' });
    expect(getCodeFileType('cs')).toEqual({ ext: 'cs', mime: 'text/x-csharp' });
    expect(getCodeFileType('csharp')).toEqual({ ext: 'cs', mime: 'text/x-csharp' });
    expect(getCodeFileType('rs')).toEqual({ ext: 'rs', mime: 'text/x-rust' });
    expect(getCodeFileType('rust')).toEqual({ ext: 'rs', mime: 'text/x-rust' });
    expect(getCodeFileType('rb')).toEqual({ ext: 'rb', mime: 'application/x-ruby' });
    expect(getCodeFileType('ruby')).toEqual({ ext: 'rb', mime: 'application/x-ruby' });
    expect(getCodeFileType('kt')).toEqual({ ext: 'kt', mime: 'text/x-kotlin' });
    expect(getCodeFileType('kotlin')).toEqual({ ext: 'kt', mime: 'text/x-kotlin' });
    expect(getCodeFileType('php')).toEqual({ ext: 'php', mime: 'application/x-httpd-php' });
    expect(getCodeFileType('swift')).toEqual({ ext: 'swift', mime: 'text/x-swift' });
    expect(getCodeFileType('toml')).toEqual({ ext: 'toml', mime: 'application/toml' });
    expect(getCodeFileType('scss')).toEqual({ ext: 'scss', mime: 'text/x-scss' });
    expect(getCodeFileType('sass')).toEqual({ ext: 'sass', mime: 'text/x-sass' });
    expect(getCodeFileType('less')).toEqual({ ext: 'less', mime: 'text/less' });
    expect(getCodeFileType('zsh')).toEqual({ ext: 'sh', mime: 'text/x-sh' });
    expect(getCodeFileType('ini')).toEqual({ ext: 'ini', mime: 'text/plain' });
    expect(getCodeFileType('mdx')).toEqual({ ext: 'mdx', mime: 'text/markdown' });
  });

  // A language tag with no entry above but whose name is itself a known upload extension
  // still saves as `.${lang}` (accepted server-side) rather than the generic .txt fallback.
  it('falls back to `.${lang}` for an unmapped language whose name is a known upload extension', () => {
    expect(getCodeFileType('h')).toEqual({ ext: 'h', mime: 'text/plain' });
    expect(getCodeFileType('log')).toEqual({ ext: 'log', mime: 'text/plain' });
  });

  it('still falls back to txt for a language name that is not a known upload extension', () => {
    expect(getCodeFileType('brainfuck')).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(getCodeFileType('cobol')).toEqual({ ext: 'txt', mime: 'text/plain' });
  });
});
