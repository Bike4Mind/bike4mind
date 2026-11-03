import type { FC } from 'react';
import type { ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';

/**
 * Raw parsed artifact before ID resolution or data transformation.
 * Matches the shape produced by parseArtifacts() in artifactParser.ts.
 */
export type ParsedArtifact = {
  type: string;
  title: string;
  content: string;
  identifier?: string;
  language?: string;
};

/**
 * Props passed to every artifact type handler's PreviewCard component.
 */
export type ArtifactPreviewProps = {
  artifact: ParsedArtifact;
  artifactId: string;
  index: number;
  /** Set for a React artifact that is part of a multi-file app in its reply; other types ignore it. */
  reactGroup?: ReactArtifactGroupRole;
};

/**
 * A handler for a single artifact type. Implement this to add support for a
 * new artifact type - no switch statements, no changes to the rendering pipeline.
 */
export type ArtifactTypeHandler = {
  /** Must match the artifact type string from the parser (e.g., 'react', 'html', 'chess') */
  type: string;
  /** Renders the inline preview card shown in the chat stream */
  PreviewCard: FC<ArtifactPreviewProps>;
};

// Internal registry - not exported as a public API
const handlers = new Map<string, ArtifactTypeHandler>();

/**
 * Register an artifact type handler. Called at module scope by each
 * handler file. Silently replaces on duplicate registration so that
 * HMR / fast-refresh re-runs don't crash the app.
 */
export function registerArtifactType(handler: ArtifactTypeHandler): void {
  handlers.set(handler.type, handler);
}

/**
 * Look up the handler for a given artifact type.
 * Returns undefined for unknown types.
 */
export function getArtifactHandler(type: string): ArtifactTypeHandler | undefined {
  return handlers.get(type);
}
