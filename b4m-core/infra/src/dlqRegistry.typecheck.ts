import {
  createDlqRegistry,
  createInspectableDlqRegistry,
  type DlqDescriptor,
  type InspectableDlqDescriptor,
} from './index.js';

// Compile-only coverage for consumers of the published descriptor and const-inferred factory.
function verifyDescriptorCompatibility(descriptor: DlqDescriptor): string {
  const legacySource: string = descriptor.sourceQueue;
  const registry = createDlqRegistry(
    [{ label: 'fixture', displayName: 'Fixture', application: 'Example', sourceQueue: 'fixtureSource' }] as const,
    { resolveDlqUrl: () => 'dlq-url', resolveSourceQueueUrl: () => 'source-url' }
  );
  const inferredSource: 'fixtureSource' = registry.getAllDescriptors()[0].sourceQueue;
  registry.getSourceQueueUrl(inferredSource);
  // @ts-expect-error The source resolver retains the descriptor's inferred source vocabulary.
  registry.getSourceQueueUrl('unregisteredSource');
  return legacySource;
}

function verifyLegacyFactoryType(registry: ReturnType<typeof createDlqRegistry>): string | undefined {
  return registry.getAllDescriptors()[0]?.sourceQueue;
}

function verifyInspectionCompatibility() {
  const inspection = {
    label: 'inspection',
    displayName: 'Inspection',
    application: 'Example',
    sourceQueue: null,
  } as const satisfies InspectableDlqDescriptor;
  const registry = createInspectableDlqRegistry(
    [
      inspection,
      { label: 'replay', displayName: 'Replay', application: 'Example', sourceQueue: 'fixtureSource' },
    ] as const,
    { resolveDlqUrl: () => 'dlq-url', resolveSourceQueueUrl: () => 'source-url' }
  );
  registry.getSourceQueueUrl('fixtureSource');
  const source: 'fixtureSource' | null = registry.getAllDescriptors()[0].sourceQueue;
  // @ts-expect-error An inspection-only descriptor has no source queue URL to resolve.
  registry.getSourceQueueUrl(null);
  // @ts-expect-error The original factory retains its non-null input contract.
  createDlqRegistry([inspection], { resolveDlqUrl: () => 'dlq-url', resolveSourceQueueUrl: () => 'source-url' });
  return source;
}

void verifyDescriptorCompatibility;
void verifyLegacyFactoryType;
void verifyInspectionCompatibility;
