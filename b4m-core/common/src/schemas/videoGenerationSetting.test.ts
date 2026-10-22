import { describe, expect, it } from 'vitest';
import { MessageDataToClient } from './actions';
import { settingsMap, VideoGenerationSettingsSchema } from './settings';

describe('videoGeneration admin setting', () => {
  it('defaults to an empty override map', () => {
    expect(VideoGenerationSettingsSchema.parse({})).toEqual({ enabledModels: {} });
    expect(settingsMap.videoGeneration.defaultValue).toEqual({ enabledModels: {} });
  });
});

describe('generation_job_updated action', () => {
  it('parses through the client message union', () => {
    const parsed = MessageDataToClient.parse({
      action: 'generation_job_updated',
      job: { id: 'j1', kind: 'video', state: 'running', progress: 0.5 },
    });
    expect(parsed.action).toBe('generation_job_updated');
  });
});
