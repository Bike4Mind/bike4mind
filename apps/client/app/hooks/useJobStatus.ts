import { create } from 'zustand';

type JobType = 'summarize' | 'generateTags';

interface JobStatusStore {
  jobs: Map<string, Set<JobType>>;
  startJob: (sessionId: string, jobType: JobType) => void;
  endJob: (sessionId: string, jobType: JobType) => void;
  isJobRunning: (sessionId: string, jobType?: JobType) => boolean;
  getRunningJobs: (sessionId: string) => JobType[];
}

export const useJobStatus = create<JobStatusStore>((set, get) => ({
  jobs: new Map(),

  startJob: (sessionId, jobType) =>
    set(state => {
      const newJobs = new Map(state.jobs);
      if (!newJobs.has(sessionId)) {
        newJobs.set(sessionId, new Set());
      }
      newJobs.get(sessionId)!.add(jobType);
      return { jobs: newJobs };
    }),

  endJob: (sessionId, jobType) =>
    set(state => {
      const newJobs = new Map(state.jobs);
      const sessionJobs = newJobs.get(sessionId);
      if (sessionJobs) {
        sessionJobs.delete(jobType);
        if (sessionJobs.size === 0) {
          newJobs.delete(sessionId);
        }
      }
      return { jobs: newJobs };
    }),

  isJobRunning: (sessionId, jobType) => {
    const sessionJobs = get().jobs.get(sessionId);
    if (!sessionJobs) return false;
    return jobType ? sessionJobs.has(jobType) : sessionJobs.size > 0;
  },

  getRunningJobs: sessionId => {
    const sessionJobs = get().jobs.get(sessionId);
    return sessionJobs ? Array.from(sessionJobs) : [];
  },
}));
