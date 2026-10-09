import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatVideoJob, ChatVideoLinkResult } from '@shared/chat';

export interface VideoJobsController {
  jobs: ChatVideoJob[];
  cancel: (jobId: string) => Promise<void>;
  recheck: (jobId: string) => Promise<void>;
  open: (jobId: string) => Promise<void>;
  save: (jobId: string) => Promise<boolean>;
  copyLink: (jobId: string) => Promise<ChatVideoLinkResult>;
}

/** Upsert by id, keeping the original order so a card never jumps when its job changes. */
export function upsertVideoJob(jobs: readonly ChatVideoJob[], job: ChatVideoJob): ChatVideoJob[] {
  const index = jobs.findIndex(existing => existing.id === job.id);
  if (index < 0) return [...jobs, job];
  const next = jobs.slice();
  next[index] = job;
  return next;
}

/**
 * The open conversation's video jobs, kept in step with main.
 *
 * Main owns them and does all the polling; this only lists them when the conversation opens -
 * which is also what resumes an unfinished one after a restart - and applies the 'video-job'
 * pushes after that. Nothing here runs a timer.
 */
export function useVideoJobs(sessionId: string | null): VideoJobsController {
  const [jobs, setJobs] = useState<ChatVideoJob[]>([]);
  const activeSessionId = useRef<string | null>(sessionId);
  activeSessionId.current = sessionId;

  useEffect(() => {
    setJobs([]);
    if (!sessionId) return;
    let current = true;
    void window.b4m.chat.listVideoJobs(sessionId).then(list => {
      // A push may have landed while the list was in flight; it is newer than the file read.
      if (current) setJobs(pushed => pushed.reduce(upsertVideoJob, list));
    });
    return () => {
      current = false;
    };
  }, [sessionId]);

  useEffect(
    () =>
      window.b4m.chat.onStreamEvent(event => {
        if (event.type !== 'video-job' || event.sessionId !== activeSessionId.current) return;
        setJobs(current => upsertVideoJob(current, event.job));
      }),
    []
  );

  const cancel = useCallback(
    async (jobId: string) => {
      if (sessionId) await window.b4m.chat.cancelVideoJob(sessionId, jobId);
    },
    [sessionId]
  );
  const recheck = useCallback(
    async (jobId: string) => {
      if (sessionId) await window.b4m.chat.recheckVideoJob(sessionId, jobId);
    },
    [sessionId]
  );
  const open = useCallback(
    async (jobId: string) => {
      if (sessionId) await window.b4m.chat.openVideo(sessionId, jobId);
    },
    [sessionId]
  );
  const save = useCallback(
    async (jobId: string) => (sessionId ? window.b4m.chat.saveVideo(sessionId, jobId) : false),
    [sessionId]
  );
  const copyLink = useCallback(
    async (jobId: string): Promise<ChatVideoLinkResult> =>
      sessionId ? window.b4m.chat.copyVideoLink(sessionId, jobId) : { ok: false, message: 'No conversation is open.' },
    [sessionId]
  );

  return useMemo(
    () => ({ jobs, cancel, recheck, open, save, copyLink }),
    [jobs, cancel, recheck, open, save, copyLink]
  );
}

export const VideoJobsContext = createContext<VideoJobsController | null>(null);

export function useVideoJobsContext(): VideoJobsController | null {
  return useContext(VideoJobsContext);
}
