import type { DlqDescriptor, DlqResolvers, CreateDlqRegistryOptions } from './types.js';

export function createDlqRegistry<const T extends readonly DlqDescriptor[]>(
  descriptors: T,
  resolvers: DlqResolvers,
  options?: CreateDlqRegistryOptions
): {
  getDlqUrl(label: T[number]['label']): string;
  getSourceQueueUrl(name: T[number]['sourceQueue']): string;
  getDlqByLabel(label: T[number]['label']): T[number] | undefined;
  getAllDescriptors(): readonly T[number][];
} {
  const seen = new Set<string>();
  for (const d of descriptors) {
    if (seen.has(d.label)) throw new Error(`createDlqRegistry: duplicate label "${d.label}"`);
    seen.add(d.label);
  }

  return {
    getDlqUrl(label: T[number]['label']): string {
      const url = resolvers.resolveDlqUrl(label as string);
      if (!url) {
        throw new Error(
          `Missing DLQ URL for label: ${label as string}.${options?.dlqErrorContext ? ` ${options.dlqErrorContext}` : ''}`
        );
      }
      return url;
    },

    getSourceQueueUrl(name: T[number]['sourceQueue']): string {
      const url = resolvers.resolveSourceQueueUrl(name as string);
      if (!url) {
        throw new Error(
          `Missing source queue URL for: ${name as string}.${options?.sourceQueueErrorContext ? ` ${options.sourceQueueErrorContext}` : ''}`
        );
      }
      return url;
    },

    getDlqByLabel(label: T[number]['label']): T[number] | undefined {
      return descriptors.find(d => d.label === (label as string)) as T[number] | undefined;
    },

    getAllDescriptors(): readonly T[number][] {
      return descriptors;
    },
  };
}
