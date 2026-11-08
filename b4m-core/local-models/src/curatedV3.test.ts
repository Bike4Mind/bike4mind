import { createHash } from 'node:crypto';
import {
  CuratedCatalogV3Schema,
  curatedV2Content,
  curatedV2FromV3,
  estimateFit,
  hubLicenseLabel,
  ollamaBuildBytes,
  ollamaBuildDraftMax,
  type HardwareProfile,
  type HubTierV3,
} from '@bike4mind/common/modelHub';
import { describe, expect, it } from 'vitest';
import bundled from '../../../catalog/model-hub/curated-v2.json';
import v3 from '../../../catalog/model-hub/curated-v3.json';

const GIB = 1024 ** 3;
const strict = () => CuratedCatalogV3Schema.parse(v3);

// The smallest machine a tier serves; a discrete tier assumes twice its VRAM in RAM, at least 32 GiB.
function tierMachine({ memoryKind, minGiB }: HubTierV3): HardwareProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    memoryKind,
    totalMemoryBytes: (memoryKind === 'discrete' ? Math.max(32, minGiB * 2) : minGiB) * GIB,
    gpuMemoryBytes: memoryKind === 'discrete' ? minGiB * GIB : null,
    gpuName: null,
    gpuCount: memoryKind === 'discrete' ? 1 : 0,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
  };
}

describe('the curated v3 list', () => {
  it('passes the published v3 schema', () => {
    expect(() => strict()).not.toThrow();
  });

  it('down-converts to the bundled v2 list exactly, so v2 clients see no change', () => {
    expect(JSON.stringify(curatedV2FromV3(v3 as never))).toBe(JSON.stringify(bundled));
  });

  it('labels every entry and build license', () => {
    for (const entry of strict().entries) {
      expect(entry.license.label, entry.id).toBe(hubLicenseLabel(entry.license));
      for (const build of entry.builds) expect(build.license.label, `${entry.id} ${build.id}`).toMatch(/\S/);
    }
  });

  it('records every entry in a changelog item no newer than the list', () => {
    const manifest = strict();
    expect(manifest.changelog[0].sequence).toBe(manifest.sequence);
    expect(manifest.updatedAt.startsWith(manifest.changelog[0].date)).toBe(true);
    const recorded = manifest.changelog.flatMap(item => [...item.added, ...item.changed]);
    for (const entry of manifest.entries) expect(recorded, entry.id).toContain(entry.id);
  });

  it('gives every build a measured profile with flash attention, its batch size and its peak GPU memory', () => {
    for (const entry of strict().entries)
      for (const build of entry.builds) {
        const at = `${entry.id} ${build.id}`;
        expect(build.profiles.length, at).toBeGreaterThan(0);
        for (const profile of build.profiles) {
          expect(profile.settings.flashAttn, at).not.toBe('off');
          expect(profile.settings.numBatch, at).toBeGreaterThan(0);
          expect(profile.metrics.gpuPeakMiB, at).toBeGreaterThan(0);
        }
      }
  });

  it('records the bundled v2 content hash under the current v2 sequence', () => {
    const channel = strict().v2Channel;
    const sha = createHash('sha256')
      .update(JSON.stringify(curatedV2Content(bundled as never)))
      .digest('hex');
    expect(channel?.contentSha256[String(channel.sequence)]).toBe(sha);
    expect(bundled.sequence).toBe(channel?.sequence);
  });

  // Planned as Ollama runs the profile: flash attention on, the profile's KV type and draft count.
  it('fits each GPU tier pick on the smallest machine of its tier', () => {
    const manifest = strict();
    const byId = new Map(manifest.entries.map(entry => [entry.id, entry]));
    const gpuTiers = manifest.tiers.filter(tier => tier.memoryKind !== 'cpu' && tier.minGiB > 0);
    expect(gpuTiers.length).toBeGreaterThan(0);
    for (const tier of gpuTiers)
      for (const pick of tier.picks) {
        const label = `${tier.memoryKind} ${tier.minGiB} ${pick.slot} ${pick.entry}/${pick.build}`;
        const entry = byId.get(pick.entry);
        const build = entry?.builds.find(candidate => candidate.id === pick.build);
        if (!entry || !build) throw new Error(`${label} names a missing build`);
        const profile = build.profiles.find(p => p.id === (pick.profile ?? build.profiles[0]?.id));
        if (!profile) throw new Error(`${label} has no profile`);
        const { kv, flashAttn, draftNumPredict } = profile.settings;
        const draftMax = draftNumPredict ?? ollamaBuildDraftMax(entry, build);
        const fit = estimateFit({
          model: {
            arch: entry.arch,
            ...ollamaBuildBytes(build),
            activeParamsFraction:
              entry.params.activeB === null ? undefined : entry.params.activeB / entry.params.totalB,
          },
          hardware: tierMachine(tier),
          mode: 'chat',
          runtime: { kind: 'ollama', kv: { k: kv, v: kv }, flashAttn, slots: 1, draftMax, speculative: draftMax > 0 },
          context: pick.numCtx ?? profile.settings.numCtx,
        });
        expect(fit.requested?.fits, label).toBe(true);
        // A long-context pick may spill layers to reach its context; best and fast stay on the GPU.
        if (pick.slot !== 'long-context') expect(fit.requested?.placement, label).toBe('gpu');
      }
  });
});
