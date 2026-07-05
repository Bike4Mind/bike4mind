import { describe, it, expect } from 'vitest';
import { formatFileSize, getFileTypeEmoji, detectMimeType, extensionFromMimeType, MIME_TYPE_MAP } from '../utils';

describe('formatFileSize', () => {
  it('should format bytes in KB for values under 1MB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(512)).toBe('0.5 KB');
    expect(formatFileSize(256 * 1024)).toBe('256.0 KB');
  });

  it('should format bytes in MB for values at or above 1MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.50 MB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10.00 MB');
  });

  it('should handle zero bytes', () => {
    expect(formatFileSize(0)).toBe('0.0 KB');
  });

  it('should handle boundary just below 1MB', () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1024.0 KB');
  });
});

describe('getFileTypeEmoji', () => {
  it('should return image emoji for image MIME types', () => {
    expect(getFileTypeEmoji('image/png')).toBe('🖼️');
    expect(getFileTypeEmoji('image/jpeg')).toBe('🖼️');
    expect(getFileTypeEmoji('image/svg+xml')).toBe('🖼️');
  });

  it('should return document emoji for PDF', () => {
    expect(getFileTypeEmoji('application/pdf')).toBe('📄');
  });

  it('should return document emoji for Word documents', () => {
    expect(getFileTypeEmoji('application/msword')).toBe('📄');
    expect(getFileTypeEmoji('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('📄');
  });

  it('should return spreadsheet emoji for Excel/CSV', () => {
    expect(getFileTypeEmoji('application/vnd.ms-excel')).toBe('📊');
    expect(getFileTypeEmoji('text/csv')).toBe('📊');
  });

  it('should return presentation emoji for PowerPoint', () => {
    expect(getFileTypeEmoji('application/vnd.ms-powerpoint')).toBe('📽️');
  });

  it('should return archive emoji for compressed files', () => {
    expect(getFileTypeEmoji('application/zip')).toBe('📦');
    expect(getFileTypeEmoji('application/gzip')).toBe('📦');
  });

  it('should return audio emoji for audio types', () => {
    expect(getFileTypeEmoji('audio/mpeg')).toBe('🎵');
  });

  it('should return video emoji for video types', () => {
    expect(getFileTypeEmoji('video/mp4')).toBe('🎬');
  });

  it('should return text emoji for text/code types', () => {
    expect(getFileTypeEmoji('text/plain')).toBe('📝');
    expect(getFileTypeEmoji('application/json')).toBe('📝');
    expect(getFileTypeEmoji('text/javascript')).toBe('📝');
  });

  it('should return default emoji for unknown types', () => {
    expect(getFileTypeEmoji('application/octet-stream')).toBe('📎');
    expect(getFileTypeEmoji('unknown/type')).toBe('📎');
  });

  it('should be case-insensitive', () => {
    expect(getFileTypeEmoji('IMAGE/PNG')).toBe('🖼️');
    expect(getFileTypeEmoji('Application/PDF')).toBe('📄');
  });
});

describe('detectMimeType', () => {
  it('should detect common image types', () => {
    expect(detectMimeType('photo.png')).toBe('image/png');
    expect(detectMimeType('photo.jpg')).toBe('image/jpeg');
    expect(detectMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(detectMimeType('icon.svg')).toBe('image/svg+xml');
  });

  it('should detect document types', () => {
    expect(detectMimeType('report.pdf')).toBe('application/pdf');
    expect(detectMimeType('doc.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(detectMimeType('sheet.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('should detect text/code types', () => {
    expect(detectMimeType('readme.md')).toBe('text/markdown');
    expect(detectMimeType('data.json')).toBe('application/json');
    expect(detectMimeType('config.yaml')).toBe('text/yaml');
    expect(detectMimeType('config.yml')).toBe('text/yaml');
  });

  it('should handle case-insensitive extensions', () => {
    expect(detectMimeType('IMAGE.PNG')).toBe('image/png');
    expect(detectMimeType('FILE.PDF')).toBe('application/pdf');
  });

  it('should return octet-stream for unknown extensions', () => {
    expect(detectMimeType('file.xyz')).toBe('application/octet-stream');
    expect(detectMimeType('file.unknown')).toBe('application/octet-stream');
  });

  it('should handle filenames with multiple dots', () => {
    expect(detectMimeType('my.file.name.txt')).toBe('text/plain');
  });

  it('should handle extensionless filenames', () => {
    expect(detectMimeType('Makefile')).toBe('application/octet-stream');
    expect(detectMimeType('README')).toBe('application/octet-stream');
  });
});

describe('extensionFromMimeType', () => {
  it('maps the Excel spreadsheetml type to xlsx (not the bogus "sheet")', () => {
    // Regression: naive `mime.split('/')[1]` produced ".sheet" downloads
    expect(extensionFromMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
  });

  it('maps common image types', () => {
    expect(extensionFromMimeType('image/png')).toBe('png');
    expect(extensionFromMimeType('image/gif')).toBe('gif');
    // First match wins, so the canonical .jpg is preferred over .jpeg
    expect(extensionFromMimeType('image/jpeg')).toBe('jpg');
  });

  it('maps document types', () => {
    expect(extensionFromMimeType('application/pdf')).toBe('pdf');
    expect(extensionFromMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'docx'
    );
  });

  it('ignores MIME parameters and casing', () => {
    expect(extensionFromMimeType('text/plain; charset=utf-8')).toBe('txt');
    expect(extensionFromMimeType('IMAGE/PNG')).toBe('png');
  });

  it('returns undefined for unknown or empty types', () => {
    expect(extensionFromMimeType('application/octet-stream')).toBeUndefined();
    expect(extensionFromMimeType('')).toBeUndefined();
  });

  it('round-trips with detectMimeType for known extensions', () => {
    expect(extensionFromMimeType(detectMimeType('sheet.xlsx'))).toBe('xlsx');
    expect(extensionFromMimeType(detectMimeType('notes.md'))).toBe('md');
  });
});

describe('MIME_TYPE_MAP', () => {
  it('should contain all expected categories', () => {
    // Images
    expect(MIME_TYPE_MAP['.png']).toBe('image/png');
    expect(MIME_TYPE_MAP['.gif']).toBe('image/gif');
    // Documents
    expect(MIME_TYPE_MAP['.pdf']).toBe('application/pdf');
    // Archives
    expect(MIME_TYPE_MAP['.zip']).toBe('application/zip');
    // Code
    expect(MIME_TYPE_MAP['.ts']).toBe('text/typescript');
    expect(MIME_TYPE_MAP['.py']).toBe('text/x-python');
  });
});
