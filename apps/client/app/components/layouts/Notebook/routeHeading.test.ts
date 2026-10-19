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
    ['/hearth', 'Hearth'],
    ['/deep-agents', 'Deep agents'],
    ['/report/abc123', 'Report'],
    ['/quests-v5', 'Quests'],
    ['/hud', 'The Keep'],
    ['/feedback/rollup', 'Your feedback'],
    ['/organizations/abc123', 'Teams'],
  ])('names %s', (pathname, heading) => {
    expect(routeHeading(pathname)).toBe(heading);
  });

  it.each([
    '/projects',
    '/studio/music',
    '/quests',
    '/subscriptions/checkout',
    '/artifacts-demo',
    '/constructor',
    '/hasOwnProperty',
  ])('leaves %s to a screen with its own h1 (or an unknown one)', pathname => {
    expect(routeHeading(pathname)).toBeNull();
  });
});
