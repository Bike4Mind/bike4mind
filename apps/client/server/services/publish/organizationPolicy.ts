import {
  artifactRepository,
  sessionRepository,
  projectRepository,
  fabFileRepository,
  assertOrganizationPublicLink,
} from '@bike4mind/database';
import type { PublishScopeTier } from '@bike4mind/common';

export type PublicationPolicyContext = {
  tier?: PublishScopeTier;
  scopeId?: string;
  source?: { artifactId?: string; sessionId?: string; fabFileId?: string };
};

export async function publicationOrganizationIds(context: PublicationPolicyContext): Promise<string[]> {
  const ids = new Set<string>();
  if (context.tier === 'organization' && context.scopeId) ids.add(context.scopeId);
  if (context.tier === 'project' && context.scopeId) {
    const project = await projectRepository.findById(context.scopeId);
    if (project?.organizationId) ids.add(project.organizationId);
  }
  const source = context.source;
  if (source?.artifactId) {
    const artifact = await artifactRepository.findOne({ id: source.artifactId });
    if (artifact?.organizationId) ids.add(artifact.organizationId);
    if (artifact?.sessionId) {
      const session = await sessionRepository.findById(artifact.sessionId);
      if (session?.organizationId) ids.add(session.organizationId);
    }
    if (artifact?.projectId) {
      const project = await projectRepository.findById(artifact.projectId);
      if (project?.organizationId) ids.add(project.organizationId);
    }
  }
  if (source?.sessionId) {
    const session = await sessionRepository.findById(source.sessionId);
    if (session?.organizationId) ids.add(session.organizationId);
    // A session keeps the organizationId it was created with, so one added to an org-bound project
    // later answers to that project's org through the project, as the artifact arm does.
    for (const project of await projectRepository.findAllBySessionId(source.sessionId)) {
      if (project.organizationId) ids.add(project.organizationId);
    }
  }
  if (source?.fabFileId) {
    const file = await fabFileRepository.findById(source.fabFileId);
    if (file?.organizationId) ids.add(file.organizationId);
  }
  return [...ids];
}

export async function assertPublicationPublicLink(context: PublicationPolicyContext): Promise<void> {
  for (const id of await publicationOrganizationIds(context)) await assertOrganizationPublicLink(id);
}
