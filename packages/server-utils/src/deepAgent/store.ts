import {
  CharterSchema,
  EpisodeSchema,
  HandoffSchema,
  type Charter,
  type DeepAgentStore,
  type Episode,
  type Handoff,
} from '@bike4mind/agents';
import {
  deepAgentCharterRepository,
  deepAgentEpisodeRepository,
  deepAgentHandoffRepository,
  deserializeCharter,
  deserializeEpisode,
  deserializeHandoff,
  serializeCharter,
  serializeEpisode,
  serializeHandoff,
} from '@bike4mind/database';

const DEFAULT_RECENT_LIMIT = 10;

/**
 * Mongo-backed implementation of the persistence port - the seam between the
 * Zod domain model (`@bike4mind/agents`) and the repositories + mappers
 * (`@bike4mind/database`).
 *
 * Every read runs through the matching Zod schema, so a malformed or drifted
 * document fails loudly here rather than corrupting a wake cycle. The
 * `deserialize*(domainObject)` calls are also the compile-time drift check:
 * if a Zod type and its serialized DTO ever diverge, this file stops compiling.
 */
export class MongoDeepAgentStore implements DeepAgentStore {
  async loadCharter(agentId: string): Promise<Charter | null> {
    const doc = await deepAgentCharterRepository.findByAgentId(agentId);
    return doc ? CharterSchema.parse(serializeCharter(doc)) : null;
  }

  async saveCharter(charter: Charter): Promise<Charter> {
    // Versioned write: v0 inserts (enrollment), vN>0 only lands if the stored
    // doc is still at vN-1 - concurrent wakes fail loudly instead of clobbering.
    const doc = await deepAgentCharterRepository.saveVersioned(deserializeCharter(charter));
    return CharterSchema.parse(serializeCharter(doc));
  }

  async loadHandoff(agentId: string): Promise<Handoff | null> {
    const doc = await deepAgentHandoffRepository.findByAgentId(agentId);
    return doc ? HandoffSchema.parse(serializeHandoff(doc)) : null;
  }

  async saveHandoff(handoff: Handoff): Promise<Handoff> {
    const doc = await deepAgentHandoffRepository.upsertForAgent(deserializeHandoff(handoff));
    return HandoffSchema.parse(serializeHandoff(doc));
  }

  async appendEpisode(episode: Episode): Promise<Episode> {
    const doc = await deepAgentEpisodeRepository.append(deserializeEpisode(episode));
    return EpisodeSchema.parse(serializeEpisode(doc));
  }

  async recentEpisodes(agentId: string, limit: number = DEFAULT_RECENT_LIMIT): Promise<Episode[]> {
    const docs = await deepAgentEpisodeRepository.findRecentByAgentId(agentId, limit);
    return docs.map(doc => EpisodeSchema.parse(serializeEpisode(doc)));
  }

  // ── Review surface (ReviewStore in reviewWake.ts) ─────────────────

  async findEpisode(agentId: string, episodeId: string): Promise<Episode | null> {
    const doc = await deepAgentEpisodeRepository.findByEpisodeId(agentId, episodeId);
    return doc ? EpisodeSchema.parse(serializeEpisode(doc)) : null;
  }

  async markEpisodeReviewed(agentId: string, episodeId: string, reviewerEpisodeId: string): Promise<void> {
    await deepAgentEpisodeRepository.setReviewedBy(agentId, episodeId, reviewerEpisodeId);
  }
}
