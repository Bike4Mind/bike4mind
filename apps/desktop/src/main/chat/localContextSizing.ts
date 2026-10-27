import { OllamaRuntime, probeHardware, type HardwareProfile, type ModelInspection } from '@bike4mind/local-models';
import type { LocalContextSetting } from '@shared/localContextSetting';
import type { LocalModelFootprint } from './localContext';
import type { LocalContextSizing } from './OllamaLocal';

type Shape = Pick<LocalModelFootprint, 'arch' | 'weightsBytes'>;

export interface LocalContextSizingDeps {
  setting(): Promise<LocalContextSetting>;
  inspect?(model: string): Promise<Pick<ModelInspection, 'arch'> & { model: { sizeBytes: number | null } }>;
  probe?(): Promise<HardwareProfile>;
}

const UNKNOWN: Shape = { arch: null, weightsBytes: null };

/**
 * The machine is probed once and each model inspected once per app run, so Auto gives a model the
 * same context on every request. A failed inspection is retried on the next request.
 */
export function localContextSizing({
  setting,
  inspect = model => new OllamaRuntime().inspect(model),
  probe = () => probeHardware(),
}: LocalContextSizingDeps): LocalContextSizing {
  let hardware: Promise<HardwareProfile | null> | undefined;
  const shapes = new Map<string, Promise<Shape>>();
  const shapeOf = (model: string): Promise<Shape> => {
    const known = shapes.get(model);
    if (known) return known;
    const pending = inspect(model).then(
      inspection => ({ arch: inspection.arch, weightsBytes: inspection.model.sizeBytes }),
      () => {
        shapes.delete(model);
        return UNKNOWN;
      }
    );
    shapes.set(model, pending);
    return pending;
  };
  return {
    setting,
    async footprint(model) {
      hardware ??= probe().catch(() => null);
      const [machine, shape] = await Promise.all([hardware, shapeOf(model)]);
      return { ...shape, hardware: machine };
    },
  };
}
