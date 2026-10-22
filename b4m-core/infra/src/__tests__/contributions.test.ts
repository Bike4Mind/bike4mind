import { describe, it, expect } from 'vitest';
import {
  describeDroppedContributions,
  isValidContributedResourceName,
  partitionContributed,
} from '../contributions.js';

const byName = (s: { name: string }) => s.name;

describe('partitionContributed', () => {
  const core = new Set(['MONGODB_URI']);

  it('registers valid unique names in declaration order', () => {
    const result = partitionContributed([{ name: 'EXAMPLE_API_TOKEN' }, { name: 'EXAMPLE_URL' }], byName, core);
    expect(result.registered.map(byName)).toEqual(['EXAMPLE_API_TOKEN', 'EXAMPLE_URL']);
    expect(result.coreCollisions).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('drops a name core already owns', () => {
    const result = partitionContributed([{ name: 'MONGODB_URI' }], byName, core);
    expect(result.registered).toEqual([]);
    expect(result.coreCollisions).toEqual(['MONGODB_URI']);
  });

  it('reports a core-name collision in coreCollisions and registers the rest', () => {
    const result = partitionContributed([{ name: 'MONGODB_URI' }, { name: 'EXAMPLE_URL' }], byName, core);
    expect(result.coreCollisions).toEqual(['MONGODB_URI']);
    expect(result.registered.map(byName)).toEqual(['EXAMPLE_URL']);
  });

  it('keeps the first of two declarations with the same name', () => {
    const first = { name: 'EXAMPLE_API_TOKEN', placeholder: 'a' };
    const result = partitionContributed([first, { name: 'EXAMPLE_API_TOKEN', placeholder: 'b' }], byName, core);
    expect(result.registered).toEqual([first]);
    expect(result.duplicates).toEqual(['EXAMPLE_API_TOKEN']);
  });

  it.each(['', '1ABC', 'HAS-DASH', 'HAS SPACE', '__proto__', '_LEADING', 'constructor', 'prototype'])(
    'rejects the invalid name %j',
    name => {
      expect(isValidContributedResourceName(name)).toBe(false);
      expect(partitionContributed([{ name }], byName, core).rejected).toEqual([name]);
    }
  );

  // Each of these would alias a core or platform variable through the env var it maps to.
  it.each([
    'MongodbUri',
    'mongodb_uri',
    'ExampleUrl',
    'NODE_OPTIONS',
    'AWS_SECRET_ACCESS_KEY',
    'LD_PRELOAD',
    'PATH',
    'HTTPS_PROXY',
    'SSL_CERT_FILE',
    'OPENSSL_CONF',
    'AWS_X',
    'HTTP_PROXY',
    'DOCUMENTDB_CA_BUNDLE_BASE64',
    'AGENT_EXECUTOR_INTERNAL_SECRET',
    'INTERNAL_WS_SECRET',
    'INTERNAL_S3_WEBHOOK_SECRET',
  ])('rejects %j, which names or aliases a variable a contribution must not own', name => {
    expect(isValidContributedResourceName(name)).toBe(false);
  });

  it('rejects a non-string name', () => {
    expect(partitionContributed([{ name: 42 }], s => s.name, core).rejected).toEqual(['42']);
  });

  it('describes each kind of drop', () => {
    const result = partitionContributed(
      [{ name: 'MONGODB_URI' }, { name: 'A' }, { name: 'A' }, { name: '' }],
      byName,
      core
    );
    expect(describeDroppedContributions('secret', result)).toHaveLength(3);
    expect(describeDroppedContributions('secret', partitionContributed([], byName, core))).toEqual([]);
  });
});
