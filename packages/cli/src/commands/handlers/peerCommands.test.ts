import { describe, expect, it, vi } from 'vitest';
import { peerCommand, type PeerControls } from './peerCommands.js';
import type { CommandContext } from '../types.js';
import type { PeerService } from '../../peers/PeerService.js';

const context = (peers: PeerControls) => ({ peers }) as CommandContext;

describe('/peers', () => {
  it('enables only through the user command and does not accept automatically', async () => {
    const enable = vi.fn(async () => {});
    const controls = { enable, disable: vi.fn(), get: () => null };
    await peerCommand.run(['on', 'API', 'worker'], context(controls));
    expect(enable).toHaveBeenCalledWith('API worker');
  });

  it('keeps recipient policy changes separate from sends and preserves literal text', async () => {
    const service = {
      resetSendBudget: vi.fn(),
      send: vi.fn(async () => ({ ok: true })),
      setPolicy: vi.fn(async () => {}),
    };
    const controls = { enable: vi.fn(), disable: vi.fn(), get: () => service as unknown as PeerService };
    await peerCommand.run(['send', 'peer', '/compact', '@secret'], context(controls));
    expect(service.send).toHaveBeenCalledWith('peer', '/compact @secret');
    expect(service.setPolicy).not.toHaveBeenCalled();
    await peerCommand.run(['hold'], context(controls));
    expect(service.setPolicy).toHaveBeenCalledWith('hold');
  });
});
