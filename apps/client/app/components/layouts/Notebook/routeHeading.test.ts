import { describe, expect, it } from 'vitest';
import { routeHeading } from './routeHeading';

describe('routeHeading', () => {
  it.each([
    ['/', 'New chat'],
    ['/new', 'New chat'],
    ['/notebooks/abc123', 'Chat'],
    ['/profile', 'Profile'],
    ['/projects/abc123', 'Project'],
    ['/skills/new', 'Skills'],
  ])('names %s', (pathname, heading) => {
    expect(routeHeading(pathname)).toBe(heading);
  });

  it.each(['/projects', '/quests', '/constructor', '/hasOwnProperty'])(
    'leaves %s to a screen with its own h1 (or an unknown one)',
    pathname => {
      expect(routeHeading(pathname)).toBeNull();
    }
  );
});
