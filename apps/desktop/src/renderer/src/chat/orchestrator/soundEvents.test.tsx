// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Roster = { id: string; state: AgentState }[];
const agents = (...entries: [string, AgentState][]): Roster => entries.map(([id, state]) => ({ id, state }));

let container: HTMLDivElement;
let root: Root;

function Probe({ list, parent }: { list: Roster; parent: boolean }): ReactElement | null {
  useAgentSoundEvents(list, parent);
  return null;
}
const render = (list: Roster, parent = false) => act(async () => root.render(<Probe list={list} parent={parent} />));

describe('useAgentSoundEvents', () => {
  beforeEach(() => {
    chime.playSoundEvent.mockClear();
    resetSoundPacksForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('takes the first roster as the baseline and plays once per transition, never per render', async () => {
    await render(agents(['a', 'working'], ['b', 'done']));
    expect(chime.playSoundEvent).not.toHaveBeenCalled();

    await render(agents(['a', 'done'], ['b', 'done']));
    expect(chime.playSoundEvent).toHaveBeenCalledTimes(1);
    expect(chime.playSoundEvent).toHaveBeenLastCalledWith('agent-done', undefined);

    // A fresh array with the same states, as every status push produces, plays nothing.
    await render(agents(['a', 'done'], ['b', 'done']));
    await render(agents(['a', 'done'], ['b', 'done']));
    expect(chime.playSoundEvent).toHaveBeenCalledTimes(1);
  });

  it('plays again for a later transition of the same agent', async () => {
    await render(agents(['a', 'working']));
    await render(agents(['a', 'failed']));
    await render(agents(['a', 'working']));
    await render(agents(['a', 'failed']));
    expect(chime.playSoundEvent.mock.calls.map(([event]) => event)).toEqual(['agent-error', 'agent-error']);
  });

  it('counts the parent waiting on an approval', async () => {
    await render(agents(['a', 'working']), false);
    await render(agents(['a', 'working']), true);
    expect(chime.playSoundEvent).toHaveBeenCalledTimes(1);
    expect(chime.playSoundEvent).toHaveBeenLastCalledWith('approval-requested', undefined);
  });

  it('uses the stored pack from mount, without the view menu ever opening', async () => {
    const pack: SoundPackSummary = {
      status: 'ok',
      id: 'chimes',
      name: 'Chimes',
      version: '1.0.0',
      sounds: { 'agent-done': skinAssetUrl('chimes', 'sounds/done.ogg') },
    };
    window.localStorage.setItem('b4m.orchestrator.soundPack', 'chimes');
    const list = vi.fn(async () => [pack]);
    (window as unknown as { b4m: unknown }).b4m = { soundPacks: { list, onChanged: vi.fn() } };
    const soundPacks = await import('./soundPacks');
    soundPacks.resetSoundPacksForTests([], 'chimes', false);

    await render(agents(['a', 'working']));
    await render(agents(['a', 'done']));
    expect(list).toHaveBeenCalledTimes(1);
    expect(chime.playSoundEvent).toHaveBeenLastCalledWith('agent-done', 'b4m-skin://chimes/sounds/done.ogg');
    delete (window as unknown as { b4m?: unknown }).b4m;
  });

  it('plays the active pack file for the event, resolved when it fires', async () => {
    const pack: SoundPackSummary = {
      status: 'ok',
      id: 'chimes',
      name: 'Chimes',
      version: '1.0.0',
      sounds: { 'agent-done': skinAssetUrl('chimes', 'sounds/done.ogg') },
    };
    resetSoundPacksForTests([pack], 'chimes');
    await render(agents(['a', 'working'], ['b', 'working']));
    await render(agents(['a', 'done'], ['b', 'failed']));
    expect(chime.playSoundEvent.mock.calls).toEqual([
      ['agent-done', 'b4m-skin://chimes/sounds/done.ogg'],
      ['agent-error', undefined],
    ]);
  });
});
