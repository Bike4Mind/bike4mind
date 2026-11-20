// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@shared/agentState';
import { skinAssetUrl, type SoundPackSummary } from '@shared/mods';
import { soundEventsBetween, useAgentSoundEvents } from './soundEvents';
import { resetSoundPacksForTests } from './soundPacks';

const chime = vi.hoisted(() => ({ playSoundEvent: vi.fn() }));
vi.mock('./chime', () => chime);

const roster = (entries: Record<string, AgentState>) => new Map(Object.entries(entries));

describe('soundEventsBetween', () => {
  it('names each kind of transition', () => {
    expect(soundEventsBetween(roster({ a: 'working' }), roster({ a: 'done' }))).toEqual(['agent-done']);
    expect(soundEventsBetween(roster({ a: 'working' }), roster({ a: 'failed' }))).toEqual(['agent-error']);
    expect(soundEventsBetween(roster({ a: 'working' }), roster({ a: 'needs-you' }))).toEqual(['approval-requested']);
  });

  it('is silent when nothing changed, an agent is new, or one leaves', () => {
    expect(soundEventsBetween(roster({ a: 'done' }), roster({ a: 'done' }))).toEqual([]);
    expect(soundEventsBetween(roster({}), roster({ a: 'done', b: 'failed' }))).toEqual([]);
    expect(soundEventsBetween(roster({ a: 'working' }), roster({}))).toEqual([]);
    expect(soundEventsBetween(roster({ a: 'working' }), roster({ a: 'working' }))).toEqual([]);
  });

  it('is silent for states that are not one of the four moments', () => {
    expect(soundEventsBetween(roster({ a: 'working' }), roster({ a: 'stopped' }))).toEqual([]);
    expect(soundEventsBetween(roster({ a: 'needs-you' }), roster({ a: 'working' }))).toEqual([]);
  });

  it('lists each kind once, the most important last', () => {
    const before = roster({ a: 'working', b: 'working', c: 'working', d: 'working' });
    const after = roster({ a: 'needs-you', b: 'done', c: 'done', d: 'failed' });
    expect(soundEventsBetween(before, after)).toEqual(['agent-done', 'agent-error', 'approval-requested']);
  });
});

describe('useAgentSoundEvents', () => {
  const agents = (...entries: [string, AgentState][]) => entries.map(([id, state]) => ({ id, state }));

  beforeEach(() => {
    chime.playSoundEvent.mockClear();
    resetSoundPacksForTests();
  });

  it('takes the first roster as the baseline and plays once per transition, never per render', () => {
    const { rerender } = renderHook(
      ({ list, parent }: { list: ReturnType<typeof agents>; parent: boolean }) => useAgentSoundEvents(list, parent),
      { initialProps: { list: agents(['a', 'working'], ['b', 'done']), parent: false } }
    );
    expect(chime.playSoundEvent).not.toHaveBeenCalled();

    rerender({ list: agents(['a', 'done'], ['b', 'done']), parent: false });
    expect(chime.playSoundEvent).toHaveBeenCalledTimes(1);
    expect(chime.playSoundEvent).toHaveBeenLastCalledWith('agent-done', undefined);

    // A fresh array with the same states, as every status push produces, plays nothing.
    rerender({ list: agents(['a', 'done'], ['b', 'done']), parent: false });
    rerender({ list: agents(['a', 'done'], ['b', 'done']), parent: false });
    expect(chime.playSoundEvent).toHaveBeenCalledTimes(1);
  });

  it('plays again for a later transition of the same agent', () => {
    const { rerender } = renderHook(
      ({ list }: { list: ReturnType<typeof agents> }) => useAgentSoundEvents(list, false),
      {
        initialProps: { list: agents(['a', 'working']) },
      }
    );
    rerender({ list: agents(['a', 'failed']) });
    rerender({ list: agents(['a', 'working']) });
    rerender({ list: agents(['a', 'failed']) });
    expect(chime.playSoundEvent.mock.calls.map(([event]) => event)).toEqual(['agent-error', 'agent-error']);
  });

  it('counts the parent waiting on an approval', () => {
    const { rerender } = renderHook(
      ({ parent }: { parent: boolean }) => useAgentSoundEvents(agents(['a', 'working']), parent),
      { initialProps: { parent: false } }
    );
    rerender({ parent: true });
    expect(chime.playSoundEvent).toHaveBeenCalledTimes(1);
    expect(chime.playSoundEvent).toHaveBeenLastCalledWith('approval-requested', undefined);
  });

  it('plays the active pack file for the event, resolved when it fires', () => {
    const pack: SoundPackSummary = {
      status: 'ok',
      id: 'chimes',
      name: 'Chimes',
      version: '1.0.0',
      sounds: { 'agent-done': skinAssetUrl('chimes', 'sounds/done.ogg') },
    };
    resetSoundPacksForTests([pack], 'chimes');
    const { rerender } = renderHook(
      ({ list }: { list: ReturnType<typeof agents> }) => useAgentSoundEvents(list, false),
      {
        initialProps: { list: agents(['a', 'working'], ['b', 'working']) },
      }
    );
    act(() => rerender({ list: agents(['a', 'done'], ['b', 'failed']) }));
    expect(chime.playSoundEvent.mock.calls).toEqual([
      ['agent-done', 'b4m-skin://chimes/sounds/done.ogg'],
      ['agent-error', undefined],
    ]);
  });
});
