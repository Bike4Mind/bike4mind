import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ModelServerAccess,
  ModelServerAddInput,
  ModelServerCredentialInput,
  ModelServerKind,
  ModelServerMutationResult,
  ModelServerProbeInput,
  ModelServerSpecs,
  ModelServerUpdateInput,
  ModelServerView,
} from '@shared/modelServers';
import { readSpecsShape } from '@shared/modelServers';
import type { MachineView } from '@shared/models';
import type { ModelServerRegistry } from './ModelServerRegistry';
import { MAX_HEADER_NAME_CHARS, MAX_SECRET_CHARS } from './ModelServerStore';

const text = (value: unknown, max = 4_096) => (typeof value === 'string' ? value.slice(0, max) : '');

function kind(value: unknown): ModelServerKind | undefined {
  return value === 'ollama' || value === 'openai-compatible' ? value : undefined;
}

function access(value: unknown): ModelServerAccess | undefined {
  return value === 'chat' || value === 'manage' ? value : undefined;
}

// Trimmed first, then one past the limit, so credentialHeaders rejects an over-long value instead of it being saved truncated.
const credentialText = (value: unknown, max: number) => text(typeof value === 'string' ? value.trim() : value, max + 1);

/** The renderer is ours, but these reach the network: anything malformed becomes "no credential". */
export function credentialInput(value: unknown): ModelServerCredentialInput {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (raw.type === 'bearer') return { type: 'bearer', token: credentialText(raw.token, MAX_SECRET_CHARS) };
  if (raw.type === 'header') {
    return {
      type: 'header',
      name: credentialText(raw.name, MAX_HEADER_NAME_CHARS),
      value: credentialText(raw.value, MAX_SECRET_CHARS),
    };
  }
  return { type: 'none' };
}

/** Undefined leaves the specs as they are; null clears them. The store checks the figures. */
export function specsInput(value: unknown): ModelServerSpecs | null | undefined {
  if (value === undefined) return undefined;
  return readSpecsShape(value);
}

function probeInput(value: unknown): ModelServerProbeInput {
  const raw = (value ?? {}) as Record<string, unknown>;
  return { address: text(raw.address, 2_048), credential: credentialInput(raw.credential) };
}

export function registerModelServersIpc(
  ipc: Pick<IpcMain, 'handle'>,
  registry: Pick<ModelServerRegistry, 'views' | 'probe' | 'add' | 'update' | 'remove' | 'check'>,
  /** This computer's hardware as probed, before any entered specs; null when the probe failed. */
  probedHardware: () => Promise<MachineView | null> = async () => null
): void {
  const mutate = async (work: () => Promise<ModelServerView[]>): Promise<ModelServerMutationResult> => {
    try {
      return { ok: true, servers: await work() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save that server.' };
    }
  };

  ipc.handle(IPC_CHANNELS.modelServersList, () => registry.views());
  ipc.handle(IPC_CHANNELS.modelServersProbe, (_event, input: unknown) => registry.probe(probeInput(input)));
  ipc.handle(IPC_CHANNELS.modelServersAdd, (_event, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const add: ModelServerAddInput = {
      ...probeInput(raw),
      name: text(raw.name, 200),
      kind: kind(raw.kind) ?? 'ollama',
      access: access(raw.access) ?? 'chat',
      acceptOpen: raw.acceptOpen === true,
    };
    return mutate(() => registry.add(add));
  });
  ipc.handle(IPC_CHANNELS.modelServersUpdate, (_event, id: unknown, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const update: ModelServerUpdateInput = {
      ...(typeof raw.name === 'string' ? { name: text(raw.name, 200) } : {}),
      ...(kind(raw.kind) ? { kind: kind(raw.kind) } : {}),
      ...(access(raw.access) ? { access: access(raw.access) } : {}),
      ...(raw.credential !== undefined ? { credential: credentialInput(raw.credential) } : {}),
      ...(raw.specs !== undefined ? { specs: specsInput(raw.specs) } : {}),
    };
    return mutate(() => registry.update(text(id, 64), update));
  });
  ipc.handle(IPC_CHANNELS.modelServersProbedHardware, () => probedHardware().catch(() => null));
  ipc.handle(IPC_CHANNELS.modelServersRemove, (_event, id: unknown) => mutate(() => registry.remove(text(id, 64))));
  ipc.handle(IPC_CHANNELS.modelServersCheck, (_event, id: unknown) =>
    registry.check(typeof id === 'string' ? text(id, 64) : undefined)
  );
}
