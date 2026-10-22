import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage, ChatVideoJob } from '@shared/chat';
import { describe, expect, it, vi } from 'vitest';
import { OrphanVideoJobs, VideoJobCard, VideoJobsForCall } from './VideoJobCard';
import { upsertVideoJob, VideoJobsContext, type VideoJobsController } from './useVideoJobs';

/** String-rendered like the other cards here: this package's vitest runs on node. */
function job(overrides: Partial<ChatVideoJob> = {}): ChatVideoJob {
  return {
    id: 'job-1',
    callId: 'call-1',
    modelId: 'gemini-omni-1.1-flash',
    modelName: 'Gemini Omni Flash',
    prompt: 'a red lighthouse',
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '720p',
    estimatedCredits: 1217,
    state: 'pending',
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function controller(jobs: ChatVideoJob[] = []): VideoJobsController {
  return {
    jobs,
    cancel: vi.fn(),
    recheck: vi.fn(),
    open: vi.fn(),
    save: vi.fn(),
    copyLink: vi.fn(),
  };
}

const card = (value: ChatVideoJob) => renderToStaticMarkup(<VideoJobCard job={value} actions={controller()} />);

describe('VideoJobCard', () => {
  it('shows a queued job with its settings, credits, progress and a Cancel button', () => {
    const html = card(job());
    expect(html).toContain('Queued');
    expect(html).toContain('Gemini Omni Flash, 6s, 16:9, 720p, 1,217 credits');
    expect(html).toContain('data-testid="video-job-card-progress"');
    expect(html).toContain('data-testid="video-job-card-cancel-btn"');
    expect(html).not.toContain('<video');
  });

  it('shows provider progress while running', () => {
    expect(card(job({ state: 'running', progress: 0.4 }))).toContain('40%');
  });

  it('plays a finished clip inline from local media only, light on load', () => {
    const html = card(
      job({
        state: 'succeeded',
        media: { url: 'b4m-media://media/s/a.mp4', mimeType: 'video/mp4', byteLength: 3 * 1024 * 1024 },
      })
    );
    expect(html).toMatch(/<video[^>]*controls/);
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('src="b4m-media://media/s/a.mp4"');
    expect(html).toContain('data-testid="video-job-card-open-btn"');
    expect(html).toContain('data-testid="video-job-card-save-btn"');
    expect(html).toContain('data-testid="video-job-card-copy-link-btn"');
    expect(html).not.toContain('video-job-card-cancel-btn');
  });

  it('never puts a remote URL in the player', () => {
    const html = card(
      job({ state: 'succeeded', media: { url: 'https://evil.example/x.mp4', mimeType: 'video/mp4', byteLength: 1 } })
    );
    expect(html).not.toContain('<video');
    expect(html).not.toContain('evil.example');
  });

  it('says why a job ended, with no Cancel', () => {
    const html = card(job({ state: 'failed', error: 'The provider failed to generate the video.' }));
    expect(html).toContain('Failed');
    expect(html).toContain('The provider failed to generate the video.');
    expect(html).not.toContain('video-job-card-cancel-btn');
  });

  it('offers Check again on a stalled job, and explains a scan in progress', () => {
    expect(card(job({ state: 'running', stalled: true }))).toContain('data-testid="video-job-card-recheck-btn"');
    expect(card(job({ state: 'succeeded', availability: 'pending_scan' }))).toContain('being checked');
  });
});

describe('placing cards in the thread', () => {
  const message = (callId: string): ChatMessage => ({
    id: `m-${callId}`,
    role: 'assistant',
    content: '',
    createdAt: '2026-10-09T00:00:00.000Z',
    toolCalls: [{ id: callId, name: 'generate_video', input: {}, status: 'done' }],
  });

  it('draws a call its own jobs only', () => {
    const jobs = [job({ id: 'a', callId: 'call-1' }), job({ id: 'b', callId: 'call-2' })];
    const html = renderToStaticMarkup(
      <VideoJobsContext.Provider value={controller(jobs)}>
        <VideoJobsForCall callId="call-2" />
      </VideoJobsContext.Provider>
    );
    expect(html).toContain('data-job-id="b"');
    expect(html).not.toContain('data-job-id="a"');
  });

  it('gathers jobs whose reply was never saved at the foot of the thread', () => {
    const jobs = [job({ id: 'kept', callId: 'call-1' }), job({ id: 'lost', callId: 'call-gone' })];
    const html = renderToStaticMarkup(
      <VideoJobsContext.Provider value={controller(jobs)}>
        <OrphanVideoJobs messages={[message('call-1')]} />
      </VideoJobsContext.Provider>
    );
    expect(html).toContain('data-job-id="lost"');
    expect(html).not.toContain('data-job-id="kept"');
  });

  it('updates a job in place, so a card never jumps', () => {
    const list = [job({ id: 'a' }), job({ id: 'b' })];
    expect(upsertVideoJob(list, job({ id: 'a', state: 'running' })).map(entry => `${entry.id}:${entry.state}`)).toEqual(
      ['a:running', 'b:pending']
    );
    expect(upsertVideoJob(list, job({ id: 'c' })).map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });
});
