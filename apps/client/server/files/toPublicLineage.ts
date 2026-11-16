import type { FileLineageNode, FileLineageResponse } from '@bike4mind/common';
import type { FileLineage, LineageNode } from './fileLineage';

/** Every field a redacted node reveals beyond its id and depth: none. */
const toPublicNode = (node: LineageNode): FileLineageNode =>
  node.redacted
    ? {
        file_id: node.fileId,
        depth: node.depth,
        redacted: true,
        file_name: null,
        mime_type: null,
        generator: null,
        model_id: null,
        prompt: null,
        download_url: null,
        created_at: null,
        request: null,
      }
    : {
        file_id: node.fileId,
        depth: node.depth,
        redacted: false,
        file_name: node.fileName,
        mime_type: node.mimeType,
        generator: node.generator,
        model_id: node.modelId,
        prompt: node.prompt,
        download_url: node.url,
        created_at: node.createdAt,
        request: node.request,
      };

/** Allowlist projection of the internal trail (fileLineage.ts) onto the published snake_case shape. */
export function toPublicLineage(lineage: FileLineage): FileLineageResponse {
  return {
    file_id: lineage.fileId,
    ancestors: lineage.ancestors.map(toPublicNode),
    children: lineage.children.map(toPublicNode),
    edges: lineage.edges.map(edge => ({ parent_id: edge.parentId, child_id: edge.childId, role: edge.role })),
    truncated: lineage.truncated,
  };
}
