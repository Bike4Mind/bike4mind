// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { LOCATION_MAP_LANGUAGE, SEARCH_RESULT_CARDS_LANGUAGE } from '@bike4mind/common';
import { buildReplyDownloads } from './replyDownloads';

describe('buildReplyDownloads', () => {
  it('extracts a csv fence as a .csv entry', () => {
    const reply = ['Here is the data:', '```csv', 'a,b,c', '1,2,3', '```'].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-1');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('msg-1-1.csv');
    expect(downloads[0].mimeType).toBe('text/csv');
  });

  it('extracts a python fence as a .py entry', () => {
    const reply = ['```python', 'def main():', '    print("hi")', '```'].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-2');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('msg-2-1.py');
  });

  it('extracts a cpp fence as a .cpp entry', () => {
    const reply = ['```cpp', '#include <iostream>', 'int main() { return 0; }', '```'].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-3');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('msg-3-1.cpp');
  });

  it('extracts a c fence as a .c entry, distinct from cpp', () => {
    const reply = ['```c', '#include <stdio.h>', 'int main(void) { return 0; }', '```'].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-c');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('msg-c-1.c');
  });

  it('extracts a sql fence as a .sql entry', () => {
    const reply = ['```sql', 'SELECT id, name', 'FROM users;', '```'].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-sql');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('msg-sql-1.sql');
  });

  it('returns two entries with distinct filenames for two different fences', () => {
    const reply = [
      '```json',
      '{',
      '  "a": 1,',
      '  "b": 2',
      '}',
      '```',
      'and also:',
      '```yaml',
      'key: value',
      'other: thing',
      '```',
    ].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-4');
    expect(downloads).toHaveLength(2);
    const fileNames = downloads.map(d => d.fileName);
    expect(new Set(fileNames).size).toBe(2);
    expect(fileNames).toEqual(['msg-4-1.json', 'msg-4-2.yml']);
  });

  it('slugs the filename from an artifact title', () => {
    const reply = [
      '<artifact identifier="report-1" type="text/html" title="Quarterly Report">',
      '<html><body>hi there, more than one line here</body></html>',
      '</artifact>',
    ].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-5');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe('quarterly-report.html');
    expect(downloads[0].label).toBe('Quarterly Report (HTML)');
  });

  it('does not double-count an artifact body as a separate fence', () => {
    const reply = [
      '<artifact identifier="a1" type="application/vnd.ant.python" title="Analysis Script">',
      'import pandas as pd',
      'print(pd.__version__)',
      '</artifact>',
      'Also here is:',
      '```csv',
      'x,y',
      '1,2',
      '```',
    ].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-6');
    expect(downloads).toHaveLength(2);
    expect(downloads.some(d => d.fileName === 'analysis-script.py')).toBe(true);
    expect(downloads.some(d => d.fileName.endsWith('.csv'))).toBe(true);
  });

  it('falls back to detection for an unknown fence language rather than throwing', () => {
    const reply = ['```brainfuck', '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.', '>---.', '```'].join('\n');
    expect(() => buildReplyDownloads(reply, 'msg-7')).not.toThrow();
    const downloads = buildReplyDownloads(reply, 'msg-7');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toMatch(/^msg-7-1\./);
  });

  it('de-duplicates filenames from duplicate artifact titles', () => {
    const reply = [
      '<artifact identifier="a1" type="text/plain" title="Notes">',
      'first block of notes here',
      'second line of notes',
      '</artifact>',
      '<artifact identifier="a2" type="text/plain" title="Notes">',
      'first block of notes again',
      'second line again',
      '</artifact>',
    ].join('\n');
    const downloads = buildReplyDownloads(reply, 'msg-8');
    expect(downloads).toHaveLength(2);
    const fileNames = downloads.map(d => d.fileName);
    expect(fileNames).toContain('notes.txt');
    expect(fileNames).toContain('notes-2.txt');
  });

  it('returns [] for an empty string', () => {
    expect(buildReplyDownloads('', 'msg-9')).toEqual([]);
    expect(buildReplyDownloads('   \n\t  ', 'msg-9')).toEqual([]);
  });

  it('returns [] for a prose-only reply with no fences', () => {
    const reply = 'Sure, here is a plain explanation with no code blocks at all.';
    expect(buildReplyDownloads(reply, 'msg-10')).toEqual([]);
  });

  it('skips a tiny one-line fence', () => {
    const reply = ['```python', 'x = 1', '```'].join('\n');
    expect(buildReplyDownloads(reply, 'msg-11')).toEqual([]);
  });

  it('never offers the model-authored image-card fence as a download', () => {
    const reply = [
      'Here are three.',
      '```' + SEARCH_RESULT_CARDS_LANGUAGE,
      '{"cards":[{"name":"Orient Bambino","note":"A default pick.","images":["https://cdn.example.com/a.jpg"]}]}',
      '```',
      'All three are automatics.',
    ].join('\n');
    expect(buildReplyDownloads(reply, 'msg-12')).toEqual([]);
  });

  it('never offers the model-authored map fence as a download', () => {
    const reply = [
      'Dinner nearby:',
      '```' + LOCATION_MAP_LANGUAGE,
      '{"places":[{"id":"ChIJa","name":"Barr"},',
      '{"id":"ChIJb","name":"Kadeau"}]}',
      '```',
    ].join('\n');
    expect(buildReplyDownloads(reply, 'msg-13')).toEqual([]);
  });
});
