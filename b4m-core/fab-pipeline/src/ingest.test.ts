import { describe, it, expect } from 'vitest';
import { detectURLs } from './ingest';

describe('detectURLs', () => {
  it('should detect a single URL in a string', () => {
    const input = 'Check out this website: https://www.example.com';
    const result = detectURLs(input);
    expect(result).toEqual(['https://www.example.com']);
  });

  it('should detect multiple URLs in a string', () => {
    const input = 'Visit http://example.com and https://another-example.com for more info';
    const result = detectURLs(input);
    expect(result).toEqual(['http://example.com', 'https://another-example.com']);
  });

  it('should return an empty array when no URLs are present', () => {
    const input = 'This string contains no URLs';
    const result = detectURLs(input);
    expect(result).toEqual([]);
  });

  it('should detect URLs with various formats', () => {
    const input = `
      http://www.example.com
      https://example.com/path/to/page
      http://subdomain.example.com:8080/path?param=value
      https://www.example.com/path#section
    `;
    const result = detectURLs(input);
    expect(result).toEqual([
      'http://www.example.com',
      'https://example.com/path/to/page',
      'http://subdomain.example.com:8080/path?param=value',
      'https://www.example.com/path#section',
    ]);
  });

  it('should not detect invalid URLs', () => {
    const input = 'Invalid URLs: htp://invalid.com or www.not-a-url.com';
    const result = detectURLs(input);
    expect(result).toEqual([]);
  });
});
