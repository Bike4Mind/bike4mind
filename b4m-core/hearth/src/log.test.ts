import { describe, expect, it } from 'vitest';
import { HearthLog } from './log';
import { InMemoryHearthStore } from './store';
import type { AppendEventInput } from './types';

const message = (overrides: Partial<AppendEventInput> = {}): AppendEventInput => ({
  channelId: 'ch1',
  actorId: 'agent1',
  kind: 'message',
  human: { text: 'hello', format: 'md' },
  refs: {},
  ...overrides,
});

describe('HearthLog', () => {
  it('assigns monotonic per-channel seq starting at 1', async () => {
    const log = new HearthLog(new InMemoryHearthStore());

    const a = await log.append(message());
    const b = await log.append(message());
    const other = await log.append(message({ channelId: 'ch2' }));

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(other.seq).toBe(1);
  });

  it('dedupes appends sharing a refs.externalId within a channel', async () => {
    const log = new HearthLog(new InMemoryHearthStore());

    const first = await log.append(message({ refs: { externalId: 'slack:123.456' } }));
    const echo = await log.append(message({ refs: { externalId: 'slack:123.456' } }));
    const otherChannel = await log.append(message({ channelId: 'ch2', refs: { externalId: 'slack:123.456' } }));

    expect(echo.id).toBe(first.id);
    expect(echo.seq).toBe(first.seq);
    expect(otherChannel.id).not.toBe(first.id);
  });

  it('catchup returns ordered gap-free events and advances the cursor', async () => {
    const store = new InMemoryHearthStore();
    const log = new HearthLog(store);

    await log.append(message({ human: { text: 'one', format: 'md' } }));
    await log.append(message({ human: { text: 'two', format: 'md' } }));

    const firstRead = await log.catchup('agent1', 'ch1');
    expect(firstRead.map(e => e.human.text)).toEqual(['one', 'two']);
    expect(firstRead.map(e => e.seq)).toEqual([1, 2]);

    const secondRead = await log.catchup('agent1', 'ch1');
    expect(secondRead).toEqual([]);

    await log.append(message({ human: { text: 'three', format: 'md' } }));
    const thirdRead = await log.catchup('agent1', 'ch1');
    expect(thirdRead.map(e => e.human.text)).toEqual(['three']);
  });

  it('catchup respects limit and does not skip events on the next read', async () => {
    const log = new HearthLog(new InMemoryHearthStore());

    for (const text of ['a', 'b', 'c']) {
      await log.append(message({ human: { text, format: 'md' } }));
    }

    const page1 = await log.catchup('agent1', 'ch1', { limit: 2 });
    expect(page1.map(e => e.human.text)).toEqual(['a', 'b']);

    const page2 = await log.catchup('agent1', 'ch1', { limit: 2 });
    expect(page2.map(e => e.human.text)).toEqual(['c']);
  });

  it('catchup with advance:false leaves the cursor untouched', async () => {
    const log = new HearthLog(new InMemoryHearthStore());
    await log.append(message());

    const peek = await log.catchup('agent1', 'ch1', { advance: false });
    expect(peek).toHaveLength(1);

    const readAgain = await log.catchup('agent1', 'ch1');
    expect(readAgain).toHaveLength(1);
  });

  it('rejects malformed input', async () => {
    const log = new HearthLog(new InMemoryHearthStore());

    await expect(log.append(message({ human: { text: '', format: 'md' } }))).rejects.toThrow();

    await expect(
      // any: deliberately malformed input to exercise runtime validation
      log.append({ ...message(), kind: 'not-a-kind' } as any)
    ).rejects.toThrow();
  });
});
