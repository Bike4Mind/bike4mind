/**
 * Extracts the filename from a URL or returns the string as-is if it's already a filename.
 *
 * @param input - A URL string or filename string
 * @returns The extracted filename or the original string if it's already a filename
 *
 * @example
 * extractFilename('https://example.com/path/to/file.txt') // Returns: 'file.txt'
 * extractFilename('https://example.com/path/to/file.txt?query=1#hash') // Returns: 'file.txt'
 * extractFilename('file.txt') // Returns: 'file.txt'
 * extractFilename('https://example.com/path/') // Returns: ''
 */
export function extractFilename(input: string): string {
  if (!input) {
    return '';
  }

  // Handle special protocols that don't have filenames
  if (input.startsWith('data:')) {
    return '';
  }

  // If the input doesn't contain a protocol (http://, https://, file://, data:, etc.)
  // and doesn't start with //, treat it as a filename
  if (!input.includes('://') && !input.startsWith('//')) {
    // Remove query params and fragments if present in the filename
    return input.split('?')[0].split('#')[0];
  }

  try {
    // For protocol-relative URLs (starting with //), add a dummy protocol for parsing
    const urlToParse = input.startsWith('//') ? `https:${input}` : input;

    const url = new URL(urlToParse);

    // Handle special protocols that don't have filenames
    if (url.protocol === 'data:') {
      return '';
    }

    const pathname = url.pathname;

    // If pathname ends with a slash (directory, not a file), return empty string
    if (pathname.endsWith('/')) {
      return '';
    }

    // Extract the filename from the pathname (last segment)
    const segments = pathname.split('/').filter(segment => segment.length > 0);
    const filename = segments[segments.length - 1] || '';

    return filename;
  } catch (error) {
    // If URL parsing fails, treat as filename and clean it
    return input.split('?')[0].split('#')[0];
  }
}
