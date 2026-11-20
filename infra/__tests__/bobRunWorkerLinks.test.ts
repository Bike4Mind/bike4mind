/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { balanced, soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUEUES = stripComments(readFileSync(path.join(REPO_ROOT, 'infra/queues.ts'), 'utf8'));

describe('Bob run worker links', () => {
  // Debiting a run can queue an org credit alert email as an email.send event on the bus.
  it('links the event bus', () => {
    const subscribe = soleMatch(
      QUEUES,
      /const bobRunQueueSubscription = bobRunQueue\.subscribe\(/g,
      'bob run queue subscription'
    );
    const subscription = balanced(QUEUES, subscribe.index, '(', ')');
    const [, link] = soleMatch(subscription, /\blink:\s*\[([^\]]*)\]/g, 'bob run worker link');
    expect(link.split(',').map(entry => entry.trim())).toContain('eventBus');
  });
});
