import { useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { ModelVersionEntry } from '@shared/model3d';
import type { CompareMode } from './ModelVersionStrip';
import type { ModelEngine } from './useModelEngine';
import type { ModelVersions } from './useModelVersions';

export type VersionPreviewStatus = 'building' | 'ready' | { error: string };

export type VersionPreview = {
  /** The version shown instead of the current build, or null for the current build. */
  selected: ModelVersionEntry | null;
  /** Its built object once ready, posed at its kept joint angles. */
  object: THREE.Group | null;
  status: VersionPreviewStatus;
  compare: CompareMode | null;
  restoring: boolean;
  select(number: number): void;
  setCompare(mode: CompareMode | null): void;
  /** Back to the current build. */
  close(): void;
  /** Makes the selected version current; resolves to an error message, or null on success. */
  restore(): Promise<string | null>;
};

/** Built versions kept per conversation for quick re-clicks; a version's source never changes. */
const CACHE_LIMIT = 6;

/**
 * The pane's version preview and compare state: which kept version is shown, its build (on the
 * engine's own version frame, so it never disturbs the file build), and restoring it.
 */
export function useVersionPreview(engine: ModelEngine, versions: ModelVersions): VersionPreview {
  const { sessionId, buildSource, setJointAngles } = engine;
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [status, setStatus] = useState<VersionPreviewStatus>('ready');
  const [compare, setCompare] = useState<CompareMode | null>(null);
  const [restoring, setRestoring] = useState(false);
  const cache = useRef(new Map<number, THREE.Group>());
  const request = useRef(0);

  const close = useCallback(() => {
    request.current += 1;
    setSelectedNumber(null);
    setObject(null);
    setStatus('ready');
    setCompare(null);
  }, []);

  // Another conversation has its own versions: drop the selection and the built cache.
  useEffect(() => {
    cache.current.clear();
    close();
  }, [sessionId, close]);

  const selected = versions.versions.find(version => version.number === selectedNumber) ?? null;
  // A pruned selection goes back to the current build.
  useEffect(() => {
    if (selectedNumber !== null && !selected) close();
  }, [selectedNumber, selected, close]);

  const select = useCallback(
    (number: number) => {
      const version = versions.versions.find(entry => entry.number === number);
      if (!version || number === versions.current) {
        close();
        return;
      }
      const id = ++request.current;
      setSelectedNumber(number);
      const cached = cache.current.get(number);
      if (cached) {
        setObject(cached);
        setStatus('ready');
        return;
      }
      setObject(null);
      setStatus('building');
      buildSource(version.source).then(
        built => {
          cache.current.set(number, built);
          if (cache.current.size > CACHE_LIMIT) {
            const oldest = cache.current.keys().next().value;
            if (oldest !== undefined) cache.current.delete(oldest);
          }
          if (request.current !== id) return;
          setObject(built);
          setStatus('ready');
        },
        (caught: unknown) => {
          if (request.current !== id) return;
          setStatus({ error: caught instanceof Error ? caught.message : String(caught) });
        }
      );
    },
    [versions, buildSource, close]
  );

  const { restore: restoreVersion } = versions;
  const restore = useCallback(async () => {
    if (!selected) return null;
    setRestoring(true);
    try {
      const restored = await restoreVersion(selected.number);
      setJointAngles(restored.jointAngles);
      close();
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    } finally {
      setRestoring(false);
    }
  }, [selected, restoreVersion, setJointAngles, close]);

  return { selected, object, status, compare, restoring, select, setCompare, close, restore };
}
