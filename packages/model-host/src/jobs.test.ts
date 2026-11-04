import type { HubManifest, PullJobRequest } from '@bike4mind/common/modelHub';
import { curatedLibrary, curatedPins, loadCuratedManifest, ModelNotFoundError } from '@bike4mind/local-models';
import { describe, expect, it, vi } from 'vitest';
import {
  createJobs as setup,
  fakeHub,
  hubBuild as build,
  hubDetail as detail,
  jobId,
  pullRequest as request,
  REV,
  SHA,
  storedJob,
  until,
} from './__test__/jobFixtures';
import { layersMatch } from './jobs';

const ACTOR = { device: 'Laptop', user: 'ana', via: 'ssh' as const };
const OTHER = { device: 'Desktop', user: 'ben', via: 'ssh' as const };

describe('JobManager', () => {
  it('checks the approval, pulls, verifies the installed weights and records each step', async () => {
    const { jobs, fake, hub, store, events, audits, state } = setup();
    const job = await jobs.create(request(), ACTOR);
    expect(job).toMatchObject({ state: 'checking', repo: 'org/repo', startedBy: ACTOR, cancelledBy: null });
    await until(() => fake.pulls.length === 1, 'pull');
    expect(hub.getModel).toHaveBeenCalledWith('org/repo', expect.objectContaining({ refresh: true }));
    expect(state(job.id)).toBe('downloading');
    fake.pulls[0].progress(400);
    expect(jobs.get(job.id).progress).toMatchObject({ completedBytes: 400, totalBytes: 1000 });
    fake.pulls[0].finish();
    await until(() => state(job.id) === 'done', 'done');
    expect(fake.runtime.remove).not.toHaveBeenCalled();
    expect(events.map(event => event.state)).toEqual(
      expect.arrayContaining(['queued', 'checking', 'downloading', 'verifying', 'done'])
    );
    expect(store.files.get(job.id)?.job.state).toBe('done');
    expect(audits.map(entry => entry.event)).toEqual(['create', 'done']);
    expect(audits[0]).toMatchObject({ ref: 'hf.co/org/repo:Q4_K_M', revision: REV, sha256: SHA, device: 'Laptop' });
  });

  it('fails a job whose source changed since review and never asks Ollama to pull', async () => {
    const { jobs, fake, audits, state } = setup({ hub: () => fakeHub(() => detail({ revision: '2'.repeat(40) })) });
    const job = await jobs.create(request(), ACTOR);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error).toEqual({
      code: 'changed',
      message: 'org/repo changed since you reviewed it, so nothing was downloaded. Review it again.',
    });
    expect(fake.runtime.pull).not.toHaveBeenCalled();
    expect(audits.map(entry => entry.event)).toEqual(['create', 'check-failed']);
  });

  it('refuses changed licenses, another checksum, and a ref for another repo', async () => {
    const cases: Array<[Parameters<typeof request>[0], string]> = [
      [{ licenses: ['mit'] }, 'license-changed'],
      [{ sha256: 'b'.repeat(64) }, 'changed'],
      [{ ref: 'hf.co/other/repo:Q4_K_M' }, 'invalid-ref'],
    ];
    for (const [overrides, code] of cases) {
      const { jobs, fake, state } = setup();
      const job = await jobs.create(request(overrides), ACTOR);
      await until(() => state(job.id) === 'failed', code);
      expect(jobs.get(job.id).error?.code).toBe(code);
      expect(fake.runtime.pull).not.toHaveBeenCalled();
    }
  });

  it('keeps running when the Hub check throws, as a failed job with the reason', async () => {
    const { jobs, state } = setup({
      hub: () =>
        fakeHub(() => {
          throw new Error('offline');
        }),
    });
    const job = await jobs.create(request(), ACTOR);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error).toEqual({
      code: 'check-error',
      message: 'Could not check org/repo against what you reviewed: offline',
    });
  });

  it('cancels a running pull and records who cancelled it', async () => {
    const { jobs, fake, events, audits, state } = setup();
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    const cancelled = await jobs.cancel(job.id, OTHER);
    expect(cancelled).toMatchObject({ state: 'cancelled', startedBy: ACTOR, cancelledBy: OTHER });
    expect(state(job.id)).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ state: 'cancelled', cancelledBy: OTHER });
    expect(audits.at(-1)).toMatchObject({ event: 'cancel', device: 'Desktop', login: 'ben' });
    await expect(jobs.cancel(job.id, OTHER)).rejects.toMatchObject({ status: 409, code: 'job-finished' });
  });

  it('pauses, then resumes by checking everything again', async () => {
    const { jobs, fake, hub, state } = setup();
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    fake.pulls[0].progress(600);
    expect((await jobs.pause(job.id, ACTOR)).state).toBe('paused');
    await expect(jobs.pause(job.id, ACTOR)).rejects.toMatchObject({ status: 409 });
    await jobs.resume(job.id, OTHER);
    await until(() => fake.pulls.length === 2, 'second pull');
    expect(hub.getModel).toHaveBeenCalledTimes(2);
    fake.pulls[1].finish();
    await until(() => state(job.id) === 'done', 'done');
  });

  it('marks a job that was running when the host stopped as interrupted, and resumes it', async () => {
    const first = setup();
    const job = await first.jobs.create(request(), ACTOR);
    await until(() => first.fake.pulls.length === 1, 'pull');
    const saved = [...first.store.files.values()];
    expect(saved[0].job.state).toBe('downloading');

    const second = setup({}, saved);
    await second.jobs.load();
    expect(second.state(job.id)).toBe('interrupted');
    expect(second.store.files.get(job.id)?.job.state).toBe('interrupted');
    await second.jobs.resume(job.id, ACTOR);
    await until(() => second.fake.pulls.length === 1, 'resumed pull');
    second.fake.pulls[0].finish();
    await until(() => second.state(job.id) === 'done', 'done');
    await first.jobs.close();
  });

  it('turns running jobs into interrupted ones on close', async () => {
    const { jobs, fake, store, state } = setup();
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    await jobs.close();
    expect(state(job.id)).toBe('interrupted');
    expect(store.files.get(job.id)?.job.state).toBe('interrupted');
    await expect(jobs.create(request({ buildId: 'x' }), ACTOR)).rejects.toMatchObject({ status: 503 });
  });

  it('refuses the second of two pulls that fit only one at a time, with both numbers, before Ollama is asked', async () => {
    const { jobs, fake, audits } = setup({
      freeBytes: async () => 6.1e9,
      floorBytes: 1e9,
      hub: () => fakeHub(() => detail({ builds: [build({ sizeBytes: 4.9e9 })] })),
    });
    const big = { sizeBytes: 4.9e9 };
    const [first, second] = await Promise.allSettled([
      jobs.create(request(big), ACTOR),
      jobs.create(request({ ...big, buildId: 'model-Q8_0', ref: 'hf.co/org/repo:Q8_0' }), OTHER),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: {
        status: 507,
        code: 'insufficient-space',
        message:
          'Needs 4.9 GB on gpu-box; 6.1 GB free and 4.9 GB already reserved by 1 other download, and 1.0 GB is kept free.',
      },
    });
    await until(() => fake.pulls.length === 1, 'pull');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.runtime.pull).toHaveBeenCalledTimes(1);
    expect(audits.filter(entry => entry.event === 'admission-refused')).toHaveLength(1);
    await jobs.close();
  });

  it('refuses a second job for the same build or the same Ollama tag, and dismisses only finished jobs', async () => {
    const { jobs, fake, dismissed, audits } = setup();
    const job = await jobs.create(request(), ACTOR);
    await expect(jobs.create(request(), OTHER)).rejects.toMatchObject({ status: 409, code: 'job-exists' });
    const sameTag = request({ buildId: 'model-Q4_K_M-copy', ref: 'huggingface.co/org/repo:Q4_K_M' });
    await expect(jobs.create(sameTag, OTHER)).rejects.toMatchObject({
      status: 409,
      code: 'job-exists',
      message: expect.stringContaining('one copy per tag'),
    });
    await expect(jobs.dismiss(job.id, ACTOR)).rejects.toMatchObject({ status: 409 });
    await until(() => fake.pulls.length === 1, 'pull');
    await jobs.pause(job.id, ACTOR);
    await expect(jobs.create(sameTag, OTHER)).rejects.toMatchObject({ status: 409, code: 'job-exists' });
    await jobs.cancel(job.id, ACTOR);
    await jobs.dismiss(job.id, OTHER);
    expect(dismissed).toEqual([job.id]);
    expect(audits.at(-1)).toMatchObject({ event: 'dismiss', job: job.id, device: 'Desktop' });
    expect(() => jobs.get(job.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('removes weights that do not match the approval when the tag was new, and says so', async () => {
    const { jobs, fake, audits, state } = setup();
    fake.setBlob('f'.repeat(64));
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    fake.pulls[0].finish();
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error).toEqual({
      code: 'digest-mismatch',
      message:
        'The downloaded file does not match the one you approved (expected aaaaaaaa, got ffffffff), so it was removed.',
    });
    expect(fake.runtime.remove).toHaveBeenCalledWith('hf.co/org/repo:Q4_K_M');
    expect(audits.at(-1)?.event).toBe('digest-failed');
  });

  it('leaves a mismatched model in place when the tag existed before the job', async () => {
    const { jobs, fake, state } = setup();
    fake.installed.add('hf.co/org/repo:Q4_K_M');
    fake.setBlob('f'.repeat(64));
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    fake.pulls[0].finish();
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error?.message).toContain('was installed before this download');
    expect(fake.runtime.remove).not.toHaveBeenCalled();
  });

  it('pulls a gated build whose checksum is hidden only once access is confirmed, then checks it after', async () => {
    const masked = build({ files: [{ path: 'model-Q4_K_M.gguf', sizeBytes: 1000, sha256: null, url: 'u' }] });
    const gated = () => fakeHub(() => detail({ gated: 'manual', ollamaNeedsSshKey: true, builds: [masked] }));
    const refused = setup({ hub: gated });
    const first = await refused.jobs.create(request(), ACTOR);
    await until(() => refused.state(first.id) === 'failed', 'refused');
    expect(refused.jobs.get(first.id).error?.code).toBe('access-required');

    const { jobs, fake, state } = setup({ hub: gated });
    const job = await jobs.create(request({ accessConfirmed: true }), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    expect(fake.pulls[0].ref).toBe('huggingface.co/org/repo:Q4_K_M');
    expect(jobs.get(job.id).notice).toContain('checked it after the download');
    fake.pulls[0].finish();
    await until(() => state(job.id) === 'done', 'done');
  });

  it('pulls a repo the Hub hides from a reader without a token only when access is confirmed', async () => {
    const hidden = () =>
      fakeHub(() => {
        throw new ModelNotFoundError('huggingface', 'org/repo');
      });
    const refused = setup({ hub: hidden });
    const first = await refused.jobs.create(request(), ACTOR);
    await until(() => refused.state(first.id) === 'failed', 'refused');
    expect(refused.jobs.get(first.id).error?.code).toBe('check-error');

    const { jobs, fake, state } = setup({ hub: hidden });
    const job = await jobs.create(request({ accessConfirmed: true }), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    expect(fake.pulls[0].ref).toBe('huggingface.co/org/repo:Q4_K_M');
    fake.pulls[0].finish();
    await until(() => state(job.id) === 'done', 'done');
  });

  it('sends progress to the event stream at most once per interval, the latest winning', async () => {
    const { jobs, fake, events } = setup({ progressEveryMs: 40 });
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    const before = events.length;
    for (const completed of [100, 200, 300, 400]) fake.pulls[0].progress(completed);
    await new Promise(resolve => setTimeout(resolve, 80));
    const progress = events.slice(before).map(event => event.progress.completedBytes);
    expect(progress).toEqual([400]);
    await jobs.cancel(job.id, ACTOR);
  });

  it('refuses to remove a model a job is pulling, and audits a removal', async () => {
    const { jobs, fake, audits } = setup();
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    await expect(jobs.removeModel('huggingface.co/org/repo:Q4_K_M', ACTOR)).rejects.toMatchObject({
      status: 409,
      code: 'model-busy',
    });
    await jobs.cancel(job.id, ACTOR);
    await expect(jobs.removeModel('gone:latest', ACTOR)).rejects.toMatchObject({ status: 404 });
    fake.installed.add('tiny:1b');
    await jobs.removeModel('tiny:1b', ACTOR);
    expect(audits.at(-1)).toMatchObject({ event: 'remove', ref: 'tiny:1b', login: 'ana' });
  });

  it('treats a name without a tag as its :latest tag when a job is pulling it', async () => {
    const { jobs } = setup({ hub: () => fakeHub(() => new Promise<never>(() => {})) });
    await jobs.create(request({ ref: 'hf.co/org/repo:latest' }), ACTOR);
    expect(jobs.busy('hf.co/org/repo')?.ref).toBe('hf.co/org/repo:latest');
    await expect(jobs.removeModel('hf.co/org/repo', ACTOR)).rejects.toMatchObject({ status: 409, code: 'model-busy' });
    await expect(jobs.create(request({ buildId: 'other', ref: 'hf.co/org/repo' }), OTHER)).rejects.toMatchObject({
      status: 409,
      code: 'job-exists',
    });
  });

  it('audits a failed pull and a job found interrupted at load', async () => {
    const { jobs, fake, audits, state } = setup();
    fake.runtime.pull.mockRejectedValueOnce(new Error('disk full'));
    const job = await jobs.create(request(), ACTOR);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error?.code).toBe('pull-failed');
    expect(audits.at(-1)).toMatchObject({
      event: 'pull-failed',
      job: job.id,
      device: 'Laptop',
      detail: 'Ollama could not download hf.co/org/repo:Q4_K_M: disk full',
    });

    const loaded = setup({}, [storedJob(jobId(1), 'downloading')]);
    await loaded.jobs.load();
    expect(loaded.audits).toEqual([
      expect.objectContaining({
        event: 'interrupted',
        job: jobId(1),
        detail: 'b4m-host stopped while the job was downloading.',
      }),
    ]);
  });

  it('reads whether the tag existed again when a resume pulls another ref', async () => {
    const saved = storedJob(jobId(1), 'paused');
    saved.run = { hadTag: true, hadTagRef: 'hf.co/org/repo:OLD', pulled: false, afterOnly: false };
    const { jobs, fake, store, state } = setup({}, [saved]);
    fake.setBlob('f'.repeat(64));
    await jobs.load();
    await jobs.resume(jobId(1), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    expect(store.files.get(jobId(1))?.run).toMatchObject({ hadTag: false, hadTagRef: 'hf.co/org/repo:Q4_K_M' });
    fake.pulls[0].finish();
    await until(() => state(jobId(1)) === 'failed', 'failed');
    expect(jobs.get(jobId(1)).error?.message).toContain('so it was removed');
    expect(fake.runtime.remove).toHaveBeenCalledWith('hf.co/org/repo:Q4_K_M');
  });
});

/** A gate a fake can wait on, opened by the test. */
function gate() {
  let open = () => {};
  const closed = new Promise<void>(resolve => (open = resolve));
  return { closed, open };
}

const masked = () => build({ files: [{ path: 'model-Q4_K_M.gguf', sizeBytes: 1000, sha256: null, url: 'u' }] });
const gatedHub = () => fakeHub(() => detail({ gated: 'manual', ollamaNeedsSshKey: true, builds: [masked()] }));
const hiddenHub = () =>
  fakeHub(() => {
    throw new ModelNotFoundError('huggingface', 'org/repo');
  });

describe('JobManager races', () => {
  it('cancel during create wins: the run never starts and the file ends cancelled', async () => {
    const { jobs, fake, store, state } = setup();
    store.delayMs = 30;
    const creating = jobs.create(request(), ACTOR);
    await until(() => jobs.list().length === 1, 'entry');
    const { id } = jobs.list()[0];
    const [created, cancelled] = await Promise.all([creating, jobs.cancel(id, OTHER)]);
    expect(created.id).toBe(id);
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelledBy: OTHER });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(state(id)).toBe('cancelled');
    expect(fake.runtime.pull).not.toHaveBeenCalled();
    expect(store.files.get(id)?.job.state).toBe('cancelled');
    expect(store.writes.filter(write => write.startsWith(id))).toEqual([`${id}:queued`, `${id}:cancelled`]);
  });

  it('cancel during resume wins over the resume', async () => {
    const hold = { current: null as Promise<void> | null };
    const freeBytes = vi.fn(async () => {
      await hold.current;
      return 100e9;
    });
    const { jobs, fake, store, state } = setup({ freeBytes });
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    await jobs.pause(job.id, ACTOR);
    const room = gate();
    hold.current = room.closed;
    store.delayMs = 20;
    const calls = freeBytes.mock.calls.length;
    const resuming = jobs.resume(job.id, ACTOR);
    await until(() => freeBytes.mock.calls.length > calls, 'admission read');
    const cancelling = jobs.cancel(job.id, OTHER);
    room.open();
    await Promise.all([resuming, cancelling]);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(state(job.id)).toBe('cancelled');
    expect(jobs.get(job.id).cancelledBy).toEqual(OTHER);
    expect(fake.pulls).toHaveLength(1);
    expect(store.files.get(job.id)?.job.state).toBe('cancelled');
  });

  it('cancel then dismiss during resume leaves no job and no file behind', async () => {
    const hold = { current: null as Promise<void> | null };
    const freeBytes = vi.fn(async () => {
      await hold.current;
      return 100e9;
    });
    const { jobs, fake, store, dismissed } = setup({ freeBytes });
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    await jobs.pause(job.id, ACTOR);
    const room = gate();
    hold.current = room.closed;
    store.delayMs = 20;
    const calls = freeBytes.mock.calls.length;
    const resuming = jobs.resume(job.id, ACTOR);
    await until(() => freeBytes.mock.calls.length > calls, 'admission read');
    const cancelling = jobs.cancel(job.id, OTHER);
    await expect(jobs.dismiss(job.id, OTHER)).rejects.toMatchObject({ status: 409 });
    room.open();
    await cancelling;
    await jobs.dismiss(job.id, OTHER);
    await resuming;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(jobs.list()).toEqual([]);
    expect(dismissed).toEqual([job.id]);
    expect(store.files.has(job.id)).toBe(false);
    expect(store.writes.at(-1)).toBe(`${job.id}:removed`);
    expect(fake.pulls).toHaveLength(1);
  });

  it('re-checks a download that was being verified when the host died, and removes it on a mismatch', async () => {
    const first = setup({ verifyTimeoutMs: 50 });
    first.fake.runtime.inspect.mockImplementation(() => new Promise<never>(() => {}));
    const job = await first.jobs.create(request(), ACTOR);
    await until(() => first.fake.pulls.length === 1, 'pull');
    first.fake.pulls[0].finish();
    await until(() => first.state(job.id) === 'verifying', 'verifying');
    await first.jobs.close();
    await until(() => first.store.files.get(job.id)?.job.state === 'verifying', 'saved verifying');
    const saved = structuredClone([...first.store.files.values()]);
    expect(saved[0].run).toEqual({
      hadTag: false,
      hadTagRef: 'hf.co/org/repo:Q4_K_M',
      pulled: true,
      afterOnly: false,
    });

    const second = setup({}, saved);
    second.fake.installed.add('hf.co/org/repo:Q4_K_M');
    second.fake.setBlob('f'.repeat(64));
    await second.jobs.load();
    await until(() => second.state(job.id) === 'failed', 'failed');
    expect(second.jobs.get(job.id).error?.code).toBe('digest-mismatch');
    expect(second.fake.runtime.remove).toHaveBeenCalledWith('hf.co/org/repo:Q4_K_M');
    expect(second.fake.runtime.pull).not.toHaveBeenCalled();
    expect(second.hub.getModel).not.toHaveBeenCalled();
  });

  it('waits on shutdown for a check already running, so its result and audit line are kept', async () => {
    const { jobs, fake, audits, store, state } = setup();
    const answer = gate();
    const inspect = fake.runtime.inspect.getMockImplementation()!;
    fake.runtime.inspect.mockImplementationOnce(async (name: string) => {
      await answer.closed;
      return inspect(name);
    });
    const job = await jobs.create(request(), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    fake.pulls[0].finish();
    await until(() => state(job.id) === 'verifying', 'verifying');
    const closing = jobs.close();
    setTimeout(answer.open, 20);
    await closing;
    expect(state(job.id)).toBe('done');
    expect(audits.at(-1)?.event).toBe('done');
    await until(() => store.files.get(job.id)?.job.state === 'done', 'saved done');
  });

  it('resumes a job whose pull already finished straight to the check, downloading nothing', async () => {
    const saved = storedJob(jobId(1), 'interrupted');
    saved.run = { hadTag: false, pulled: true, afterOnly: false };
    const { jobs, fake, hub, state } = setup({}, [saved]);
    fake.installed.add('hf.co/org/repo:Q4_K_M');
    await jobs.load();
    await jobs.resume(jobId(1), ACTOR);
    await until(() => state(jobId(1)) === 'done', 'done');
    expect(fake.runtime.pull).not.toHaveBeenCalled();
    expect(hub.getModel).not.toHaveBeenCalled();
  });

  it('keeps a model whose download won the race with a cancel when it matches, and removes it when not', async () => {
    const kept = setup();
    const job = await kept.jobs.create(request(), ACTOR);
    await until(() => kept.fake.pulls.length === 1, 'pull');
    kept.fake.installed.add('hf.co/org/repo:Q4_K_M');
    const cancelled = await kept.jobs.cancel(job.id, OTHER);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.notice).toContain('matches what you approved and is installed');
    expect(kept.fake.runtime.remove).not.toHaveBeenCalled();

    const removed = setup();
    removed.fake.setBlob('f'.repeat(64));
    const other = await removed.jobs.create(request(), ACTOR);
    await until(() => removed.fake.pulls.length === 1, 'pull');
    removed.fake.installed.add('hf.co/org/repo:Q4_K_M');
    const paused = await removed.jobs.pause(other.id, OTHER);
    expect(paused.state).toBe('paused');
    expect(paused.notice).toContain('so it was removed');
    expect(removed.fake.runtime.remove).toHaveBeenCalledWith('hf.co/org/repo:Q4_K_M');
  });
});

describe('JobManager admission', () => {
  it('caps jobs running at once, and admits a resume only below the cap', async () => {
    const labels = ['Q4_K_M', 'Q8_0', 'Q6_K'];
    const builds = labels.map(label => build({ id: `model-${label}`, label, ollamaRef: `hf.co/org/repo:${label}` }));
    const { jobs, fake } = setup({ maxActive: 2, hub: () => fakeHub(() => detail({ builds })) });
    const of = (label: string) => request({ buildId: `model-${label}`, ref: `hf.co/org/repo:${label}` });
    const first = await jobs.create(of('Q4_K_M'), ACTOR);
    await jobs.create(of('Q8_0'), ACTOR);
    await until(() => fake.pulls.length === 2, 'pulls');
    await expect(jobs.create(of('Q6_K'), ACTOR)).rejects.toMatchObject({ status: 429, code: 'too-many-jobs' });

    await jobs.pause(first.id, ACTOR);
    const third = await jobs.create(of('Q6_K'), ACTOR);
    await expect(jobs.resume(first.id, ACTOR)).rejects.toMatchObject({ status: 429, code: 'too-many-jobs' });
    await until(() => fake.pulls.length === 3, 'third pull');
    await jobs.pause(third.id, ACTOR);
    await expect(jobs.resume(first.id, ACTOR)).resolves.toMatchObject({ id: first.id });
    await jobs.close();
  });

  it('caps unfinished jobs, paused and interrupted ones included', async () => {
    const saved = Array.from({ length: 32 }, (_, i) =>
      storedJob(
        jobId(i),
        i % 2 ? 'paused' : 'interrupted',
        {},
        request({ buildId: `b${i}`, ref: `hf.co/org/repo:B${i}` })
      )
    );
    const { jobs } = setup({}, saved);
    await jobs.load();
    await expect(jobs.create(request(), ACTOR)).rejects.toMatchObject({ status: 429, code: 'too-many-jobs' });
  });

  it('keeps the newest 200 finished jobs', async () => {
    const saved = Array.from({ length: 210 }, (_, i) =>
      storedJob(jobId(i), 'done', { updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
    );
    const { jobs, store } = setup({}, saved);
    await jobs.load();
    expect(jobs.list()).toHaveLength(200);
    expect(() => jobs.get(jobId(9))).toThrow(expect.objectContaining({ status: 404 }));
    expect(jobs.get(jobId(10)).state).toBe('done');
    await until(() => store.files.size === 200, 'pruned files');
  });

  it('credits partial bytes on resume only while the pause is recent', async () => {
    const paused = (updatedAt: string) =>
      storedJob(
        jobId(1),
        'paused',
        { updatedAt, sizeBytes: 5e9, progress: { status: 'paused', completedBytes: 4e9, totalBytes: 5e9 } },
        request({ sizeBytes: 5e9 })
      );
    const space = { freeBytes: async () => 3e9, floorBytes: 1e9 };
    const recent = setup(space, [paused(new Date().toISOString())]);
    await recent.jobs.load();
    await expect(recent.jobs.resume(jobId(1), ACTOR)).resolves.toMatchObject({ id: jobId(1), notice: null });
    await recent.jobs.close();

    const old = setup(space, [paused(new Date(Date.now() - 2 * 60 * 60_000).toISOString())]);
    await old.jobs.load();
    await expect(old.jobs.resume(jobId(1), ACTOR)).rejects.toMatchObject({
      status: 507,
      message: expect.stringContaining('Needs 5.0 GB'),
    });
  });

  it('admits a pull when the free space cannot be read, and says so on the job', async () => {
    for (const freeBytes of [async () => null, async () => Promise.reject(new Error('EIO'))]) {
      const { jobs } = setup({ freeBytes });
      const job = await jobs.create(request(), ACTOR);
      expect(job.notice).toBe(
        'b4m-host could not read the free space on gpu-box, so it did not check that the model fits.'
      );
      await jobs.close();
    }
  });
});

describe('JobManager without a Hub answer', () => {
  it('falls back to a private pull only when reading the repo itself failed', async () => {
    const base = fakeHub(() => detail());
    base.verifyOllamaRef = vi.fn(async () => {
      throw new ModelNotFoundError('huggingface', 'org/repo');
    });
    const { jobs, fake, state } = setup({ hub: () => base });
    const job = await jobs.create(request({ accessConfirmed: true }), ACTOR);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error?.code).toBe('check-error');
    expect(fake.runtime.pull).not.toHaveBeenCalled();
  });

  it('stops a private pull whose real size, once Ollama reports it, does not fit', async () => {
    const { jobs, fake, audits, state } = setup({ hub: hiddenHub, freeBytes: async () => 3e9, floorBytes: 1e9 });
    const job = await jobs.create(request({ accessConfirmed: true }), ACTOR);
    await until(() => fake.pulls.length === 1, 'pull');
    fake.pulls[0].progress(10, 5e9);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error).toMatchObject({
      code: 'insufficient-space',
      message: expect.stringContaining('Ollama reported the model is 5.0 GB'),
    });
    expect(fake.pulls[0].signal?.aborted).toBe(true);
    expect(audits.map(entry => entry.event)).toContain('admission-refused');
  });

  it('removes an unchecked model when only the check after the pull could prove it', async () => {
    const gated = setup({ hub: gatedHub });
    gated.fake.runtime.inspect.mockRejectedValue(new Error('busy'));
    const job = await gated.jobs.create(request({ accessConfirmed: true }), ACTOR);
    await until(() => gated.fake.pulls.length === 1, 'pull');
    gated.fake.pulls[0].finish();
    await until(() => gated.state(job.id) === 'failed', 'failed');
    expect(gated.jobs.get(job.id).error).toMatchObject({
      code: 'unverified',
      message: expect.stringContaining('nothing else proved it is the file you approved, so it was removed'),
    });
    expect(gated.fake.runtime.remove).toHaveBeenCalledWith('huggingface.co/org/repo:Q4_K_M');

    const proven = setup();
    proven.fake.runtime.inspect.mockRejectedValue(new Error('busy'));
    const other = await proven.jobs.create(request(), ACTOR);
    await until(() => proven.fake.pulls.length === 1, 'pull');
    proven.fake.pulls[0].finish();
    await until(() => proven.state(other.id) === 'failed', 'failed');
    expect(proven.jobs.get(other.id).error?.message).toContain('It is still installed');
    expect(proven.fake.runtime.remove).not.toHaveBeenCalled();
  });
});

describe('curated approvals', () => {
  const manifest = loadCuratedManifest(() => {});
  const pick = (() => {
    for (const entry of manifest.entries)
      for (const candidate of entry.builds) if (curatedLibrary(candidate)) return { entry, build: candidate };
    throw new Error('the bundled curated list has no library build');
  })();
  const library = curatedLibrary(pick.build)!;
  const pins = curatedPins(pick.build)!;
  const layers = {
    model: library.digest,
    template: pins.template,
    params: pins.params,
    license: pins.license,
    projector: pins.projector,
    draft: pins.draft,
  };
  const libraryRequest = (overrides: Partial<Extract<PullJobRequest, { source: 'library' }>> = {}): PullJobRequest => ({
    source: 'library',
    ref: library.ref,
    manifestDigest: library.digest,
    sizeBytes: library.sizeBytes,
    licenses: [pick.entry.license.id],
    licenseAccepted: false,
    curated: { entryId: pick.entry.id, buildId: pick.build.id, layers },
    device: { id: 'device-1', name: 'Laptop' },
    ...overrides,
  });

  it('matches approved layers against the host list pins exactly', () => {
    expect(layersMatch(layers, pick.build)).toBe(true);
    expect(layersMatch({ ...layers, template: 'c'.repeat(64) }, pick.build)).toBe(false);
    expect(layersMatch({ ...layers, model: 'c'.repeat(64) }, pick.build)).toBe(false);
  });

  it('refuses a build missing from the host list, other layers, or another license before any registry read', async () => {
    const otherLayers = { entryId: pick.entry.id, buildId: pick.build.id, layers: { ...layers, model: SHA } };
    const cases: Array<[PullJobRequest, string]> = [
      [libraryRequest({ curated: { entryId: 'nope', buildId: 'x', layers } }), 'not-listed'],
      [libraryRequest({ curated: otherLayers }), 'layers-changed'],
      [libraryRequest({ licenses: ['llama3.2'] }), 'license-changed'],
    ];
    for (const [approval, code] of cases) {
      const libraryLayers = vi.fn(async () => null);
      const { jobs, fake, state } = setup({ libraryLayers, curated: (): HubManifest => manifest });
      const job = await jobs.create(approval, ACTOR);
      await until(() => state(job.id) === 'failed', code);
      expect(jobs.get(job.id).error?.code).toBe(code);
      expect(libraryLayers).not.toHaveBeenCalled();
      expect(fake.runtime.pull).not.toHaveBeenCalled();
    }
  });

  it('refuses an entry the host list no longer offers as curated', async () => {
    const changed = structuredClone(manifest);
    const entry = changed.entries.find(candidate => candidate.id === pick.entry.id)!;
    entry.license = { ...entry.license, legal: 'blocked' };
    const { jobs, fake, state } = setup({ curated: () => changed });
    const job = await jobs.create(libraryRequest(), ACTOR);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error).toMatchObject({ code: 'not-listed', message: expect.stringContaining('no longer') });
    expect(fake.runtime.pull).not.toHaveBeenCalled();
  });

  it('checks nothing it cannot check after a pull: removes weights whose tag was new, keeps others, and says so', async () => {
    for (const hadTag of [false, true]) {
      const saved = storedJob(jobId(1), 'verifying', {}, libraryRequest());
      saved.run = { hadTag, pulled: true, afterOnly: false };
      const unlisted = (): HubManifest => ({ ...manifest, entries: [] });
      const { jobs, fake, audits, state } = setup({ curated: unlisted }, [saved]);
      fake.installed.add(library.ref);
      await jobs.load();
      await until(() => state(jobId(1)) === 'failed', 'failed');
      const { error } = jobs.get(jobId(1));
      expect(error?.code).toBe('unverified');
      expect(error?.message).toContain('was downloaded, but');
      expect(error?.message).not.toContain('nothing was downloaded');
      expect(error?.message).toContain(hadTag ? 'It is still installed' : 'so it was removed');
      if (hadTag) expect(fake.runtime.remove).not.toHaveBeenCalled();
      else expect(fake.runtime.remove).toHaveBeenCalledWith(library.ref);
      expect(audits.at(-1)).toMatchObject({ event: 'check-failed', job: jobId(1), detail: error?.message });
      expect(fake.runtime.pull).not.toHaveBeenCalled();
    }
  });

  it('refuses when the library no longer serves the reviewed layers', async () => {
    const { jobs, fake, state } = setup({ libraryLayers: async () => ({ model: SHA, others: [] }) });
    const job = await jobs.create(libraryRequest(), ACTOR);
    await until(() => state(job.id) === 'failed', 'failed');
    expect(jobs.get(job.id).error?.code).toBe('layers-changed');
    expect(fake.runtime.pull).not.toHaveBeenCalled();
  });
});
