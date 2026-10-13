import type { ValidatedVideoRequest } from '@bike4mind/common';
import {
  describeAsyncProviderConformance,
  type ConformanceScenario,
  type ConformanceSetup as AsyncConformanceSetup,
} from '../generationProviders/conformance';
import type { VideoProvider } from './types';

// Test-only like the shared harness: never export from index.ts (it imports vitest).
export type { ConformanceScenario };
export type ConformanceSetup = AsyncConformanceSetup<ValidatedVideoRequest, VideoProvider>;

export const describeVideoProviderConformance = (name: string, setup: ConformanceSetup): void =>
  describeAsyncProviderConformance(name, setup);
