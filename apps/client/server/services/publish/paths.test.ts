import { describe, it, expect } from 'vitest';
import { buildPublishS3KeyPrefix, buildPublishUrlPath } from './paths';

describe('publish paths', () => {
  it('builds canonical S3 key prefixes', () => {
    expect(buildPublishS3KeyPrefix('user', 'u1', 'my-slug')).toBe('user/u1/my-slug/');
    expect(buildPublishS3KeyPrefix('organization', 'org1', 'dash')).toBe('organization/org1/dash/');
  });

  it('builds public URL paths with the right tier prefix', () => {
    expect(buildPublishUrlPath('user', 'u1', 'my-slug')).toBe('/p/u/u1/my-slug');
    expect(buildPublishUrlPath('project', 'p1', 'dash')).toBe('/p/pj/p1/dash');
    expect(buildPublishUrlPath('organization', 'org1', 'dash')).toBe('/p/o/org1/dash');
  });
});
