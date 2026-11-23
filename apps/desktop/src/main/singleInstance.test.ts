import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { claimSingleInstance } from './singleInstance';

function host(locked: boolean) {
  return Object.assign(new EventEmitter(), { requestSingleInstanceLock: vi.fn(() => locked) });
}

describe('claimSingleInstance', () => {
  it('holds the lock and brings the app forward on a second launch', () => {
    const app = host(true);
    const onSecondLaunch = vi.fn();
    expect(claimSingleInstance(app, onSecondLaunch)).toBe(true);

    app.emit('second-instance', {}, ['/Applications/Bike4Mind.app/Contents/MacOS/Bike4Mind'], '/');
    expect(onSecondLaunch).toHaveBeenCalledTimes(1);
  });

  it('reports a duplicate launch without listening for others', () => {
    const app = host(false);
    expect(claimSingleInstance(app, vi.fn())).toBe(false);
    expect(app.listenerCount('second-instance')).toBe(0);
  });
});
