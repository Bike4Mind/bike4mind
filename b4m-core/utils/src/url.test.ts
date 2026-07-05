import { describe, it, expect } from 'vitest';
import { extractFilename } from './url';

describe('extractFilename', () => {
  describe('URL inputs', () => {
    it('should extract filename from a simple URL', () => {
      const input = 'https://example.com/file.txt';
      const result = extractFilename(input);
      expect(result).toBe('file.txt');
    });

    it('should extract filename from a URL with nested paths', () => {
      const input = 'https://example.com/path/to/document.pdf';
      const result = extractFilename(input);
      expect(result).toBe('document.pdf');
    });

    it('should extract filename from a URL with query parameters', () => {
      const input = 'https://example.com/files/image.png?width=800&height=600';
      const result = extractFilename(input);
      expect(result).toBe('image.png');
    });

    it('should extract filename from a URL with fragment/hash', () => {
      const input = 'https://example.com/docs/readme.md#section-1';
      const result = extractFilename(input);
      expect(result).toBe('readme.md');
    });

    it('should extract filename from a URL with both query params and hash', () => {
      const input = 'https://example.com/assets/video.mp4?quality=hd&codec=h264#player';
      const result = extractFilename(input);
      expect(result).toBe('video.mp4');
    });

    it('should extract filename from http:// URL', () => {
      const input = 'http://example.com/download/archive.zip';
      const result = extractFilename(input);
      expect(result).toBe('archive.zip');
    });

    it('should extract filename from URL with port', () => {
      const input = 'https://example.com:8080/files/data.json';
      const result = extractFilename(input);
      expect(result).toBe('data.json');
    });

    it('should extract filename from URL with subdomain', () => {
      const input = 'https://cdn.example.com/images/logo.svg';
      const result = extractFilename(input);
      expect(result).toBe('logo.svg');
    });

    it('should return empty string for URL ending with trailing slash', () => {
      const input = 'https://example.com/path/to/folder/';
      const result = extractFilename(input);
      expect(result).toBe('');
    });

    it('should return empty string for URL without filename', () => {
      const input = 'https://example.com/';
      const result = extractFilename(input);
      expect(result).toBe('');
    });

    it('should handle URL with filename containing dots', () => {
      const input = 'https://example.com/my.file.name.tar.gz';
      const result = extractFilename(input);
      expect(result).toBe('my.file.name.tar.gz');
    });

    it('should handle URL with filename containing special characters', () => {
      const input = 'https://example.com/file-name_123.txt';
      const result = extractFilename(input);
      expect(result).toBe('file-name_123.txt');
    });
  });

  describe('filename inputs (non-URLs)', () => {
    it('should return filename as-is when already a filename', () => {
      const input = 'document.pdf';
      const result = extractFilename(input);
      expect(result).toBe('document.pdf');
    });

    it('should return filename with multiple extensions as-is', () => {
      const input = 'archive.tar.gz';
      const result = extractFilename(input);
      expect(result).toBe('archive.tar.gz');
    });

    it('should handle filename with spaces', () => {
      const input = 'my document.pdf';
      const result = extractFilename(input);
      expect(result).toBe('my document.pdf');
    });

    it('should handle filename without extension', () => {
      const input = 'README';
      const result = extractFilename(input);
      expect(result).toBe('README');
    });

    it('should remove query params from filename string', () => {
      const input = 'file.txt?param=value';
      const result = extractFilename(input);
      expect(result).toBe('file.txt');
    });

    it('should remove hash from filename string', () => {
      const input = 'document.pdf#section';
      const result = extractFilename(input);
      expect(result).toBe('document.pdf');
    });

    it('should remove both query params and hash from filename string', () => {
      const input = 'data.json?version=2#details';
      const result = extractFilename(input);
      expect(result).toBe('data.json');
    });
  });

  describe('edge cases', () => {
    it('should handle protocol-relative URLs', () => {
      const input = '//cdn.example.com/file.js';
      const result = extractFilename(input);
      expect(result).toBe('file.js');
    });

    it('should handle data URLs', () => {
      const input = 'data:image/png;base64,iVBORw0KGgoAAAANS';
      const result = extractFilename(input);
      expect(result).toBe('');
    });

    it('should handle file:// URLs', () => {
      const input = 'file:///home/user/documents/report.docx';
      const result = extractFilename(input);
      expect(result).toBe('report.docx');
    });

    it('should handle empty string', () => {
      const input = '';
      const result = extractFilename(input);
      expect(result).toBe('');
    });

    it('should handle S3-style URLs', () => {
      const input = 'https://s3.amazonaws.com/bucket-name/folder/file.csv';
      const result = extractFilename(input);
      expect(result).toBe('file.csv');
    });

    it('should handle CloudFront URLs', () => {
      const input = 'https://d111111abcdef8.cloudfront.net/images/photo.jpg';
      const result = extractFilename(input);
      expect(result).toBe('photo.jpg');
    });

    it('should handle URL-encoded filenames', () => {
      const input = 'https://example.com/my%20file.pdf';
      const result = extractFilename(input);
      expect(result).toBe('my%20file.pdf');
    });
  });
});
