import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  SoftwareTask,
  SoftwareEngineer,
  SWAGEstimate,
  SoftwareScheduleResult,
  SolverMode,
  DurationMode,
} from '@bike4mind/common';

const EXPIRATION_HOURS = 24;

export type PiSource = 'github' | 'jira';

// ── Per-source data shape ─────────────────────────────────────────────────────

interface SourceData {
  tasks: SoftwareTask[];
  engineers: SoftwareEngineer[];
  estimates: SWAGEstimate[];
  scheduleResult: SoftwareScheduleResult | null;
  solverMode: SolverMode;
  durationMode: DurationMode;
  savedAt: number | null;

  // Filtering & engineer-repo assignments
  repoFilter: string[];
  statusFilter: string[];
  engineerFilter: string[];
  labelFilter: string[];
  assigneeFilter: string[];
  priorityFilter: string[];
  complexityFilter: string[];
  excludedTaskIds: string[];
  engineerRepoAssignments: Record<string, string[]>;

  // Dirty tracking for sync
  originalTasks: SoftwareTask[];
  modifiedTaskIds: string[];

  // Jira-specific sync metadata (unused for github source, but keeping shape uniform)
  jiraAccountIdMap: Record<string, string>;
  jiraOriginalStatuses: Record<string, string>;
}

const EMPTY_SOURCE_DATA: SourceData = {
  tasks: [],
  engineers: [],
  estimates: [],
  scheduleResult: null,
  solverMode: 'balanced',
  durationMode: 'p50',
  savedAt: null,
  repoFilter: [],
  statusFilter: [],
  engineerFilter: [],
  labelFilter: [],
  assigneeFilter: [],
  priorityFilter: [],
  complexityFilter: [],
  excludedTaskIds: [],
  engineerRepoAssignments: {},
  originalTasks: [],
  modifiedTaskIds: [],
  jiraAccountIdMap: {},
  jiraOriginalStatuses: {},
};

// ── Store interface ───────────────────────────────────────────────────────────

interface SwagStore {
  // Per-source namespaces
  github: SourceData;
  jira: SourceData;

  // Actions - all scoped to a source
  setTasks: (source: PiSource, tasks: SoftwareTask[]) => void;
  setEngineers: (source: PiSource, engineers: SoftwareEngineer[]) => void;
  setEstimates: (source: PiSource, estimates: SWAGEstimate[]) => void;
  setScheduleResult: (source: PiSource, result: SoftwareScheduleResult | null) => void;
  setSolverMode: (source: PiSource, mode: SolverMode) => void;
  setDurationMode: (source: PiSource, mode: DurationMode) => void;
  setRepoFilter: (source: PiSource, repos: string[]) => void;
  setStatusFilter: (source: PiSource, statuses: string[]) => void;
  setEngineerFilter: (source: PiSource, engineerIds: string[]) => void;
  setLabelFilter: (source: PiSource, labels: string[]) => void;
  setAssigneeFilter: (source: PiSource, filter: string[]) => void;
  setPriorityFilter: (source: PiSource, priorities: string[]) => void;
  setComplexityFilter: (source: PiSource, complexities: string[]) => void;
  setEngineerRepoAssignments: (source: PiSource, assignments: Record<string, string[]>) => void;
  toggleTaskExclusion: (source: PiSource, taskId: string) => void;
  bulkExcludeTasks: (source: PiSource, taskIds: string[]) => void;
  bulkIncludeTasks: (source: PiSource, taskIds: string[]) => void;
  clearExcludedTasks: (source: PiSource) => void;
  updateTask: (source: PiSource, taskId: string, updates: Partial<SoftwareTask>) => void;
  updateEstimateDuration: (source: PiSource, taskId: string, p50: number) => void;
  reassignScheduledTask: (source: PiSource, taskId: string, newEngineerId: string) => void;
  discardTaskChanges: (source: PiSource) => void;
  setJiraSyncMeta: (
    source: PiSource,
    accountIdMap: Record<string, string>,
    originalStatuses: Record<string, string>
  ) => void;
  clearSyncedTasks: (source: PiSource, taskIds: string[]) => void;
  clearAll: (source: PiSource) => void;
}

// ── Helper: update a single source namespace ──────────────────────────────────

type SourceUpdate = Partial<SourceData>;

function updateSource(state: SwagStore, source: PiSource, update: SourceUpdate | ((prev: SourceData) => SourceUpdate)) {
  const prev = state[source];
  const patch = typeof update === 'function' ? update(prev) : update;
  return { [source]: { ...prev, ...patch } };
}

// ── Store implementation ──────────────────────────────────────────────────────

export const useSwagStore = create<SwagStore>()(
  persist(
    set => ({
      // Initial state - two independent namespaces
      github: { ...EMPTY_SOURCE_DATA },
      jira: { ...EMPTY_SOURCE_DATA },

      // Actions
      setTasks: (source, tasks) =>
        set(state =>
          updateSource(state, source, {
            tasks,
            originalTasks: tasks.map(t => ({ ...t })),
            modifiedTaskIds: [],
            excludedTaskIds: [],
            estimates: [],
            scheduleResult: null,
            savedAt: Date.now(),
          })
        ),

      setEngineers: (source, engineers) =>
        set(state => updateSource(state, source, { engineers, savedAt: Date.now() })),

      setEstimates: (source, estimates) =>
        set(state => updateSource(state, source, { estimates, scheduleResult: null, savedAt: Date.now() })),

      setScheduleResult: (source, scheduleResult) =>
        set(state => updateSource(state, source, { scheduleResult, savedAt: Date.now() })),

      setSolverMode: (source, solverMode) =>
        set(state => updateSource(state, source, { solverMode, savedAt: Date.now() })),

      setDurationMode: (source, durationMode) =>
        set(state => updateSource(state, source, { durationMode, scheduleResult: null, savedAt: Date.now() })),

      setRepoFilter: (source, repoFilter) =>
        set(state => updateSource(state, source, { repoFilter, scheduleResult: null, savedAt: Date.now() })),

      setStatusFilter: (source, statusFilter) =>
        set(state =>
          updateSource(state, source, { statusFilter, estimates: [], scheduleResult: null, savedAt: Date.now() })
        ),

      setEngineerFilter: (source, engineerFilter) =>
        set(state => updateSource(state, source, { engineerFilter, scheduleResult: null, savedAt: Date.now() })),

      setLabelFilter: (source, labelFilter) =>
        set(state => updateSource(state, source, { labelFilter, scheduleResult: null, savedAt: Date.now() })),

      setAssigneeFilter: (source, assigneeFilter) =>
        set(state => updateSource(state, source, { assigneeFilter, scheduleResult: null, savedAt: Date.now() })),

      setPriorityFilter: (source, priorityFilter) =>
        set(state => updateSource(state, source, { priorityFilter, scheduleResult: null, savedAt: Date.now() })),

      setComplexityFilter: (source, complexityFilter) =>
        set(state => updateSource(state, source, { complexityFilter, scheduleResult: null, savedAt: Date.now() })),

      setEngineerRepoAssignments: (source, engineerRepoAssignments) =>
        set(state =>
          updateSource(state, source, { engineerRepoAssignments, scheduleResult: null, savedAt: Date.now() })
        ),

      toggleTaskExclusion: (source, taskId) =>
        set(state =>
          updateSource(state, source, prev => ({
            excludedTaskIds: prev.excludedTaskIds.includes(taskId)
              ? prev.excludedTaskIds.filter(id => id !== taskId)
              : [...prev.excludedTaskIds, taskId],
            scheduleResult: null,
            savedAt: Date.now(),
          }))
        ),

      bulkExcludeTasks: (source, taskIds) =>
        set(state =>
          updateSource(state, source, prev => {
            const existing = new Set(prev.excludedTaskIds);
            const merged = [...prev.excludedTaskIds, ...taskIds.filter(id => !existing.has(id))];
            return { excludedTaskIds: merged, scheduleResult: null, savedAt: Date.now() };
          })
        ),

      bulkIncludeTasks: (source, taskIds) =>
        set(state =>
          updateSource(state, source, prev => {
            const removeSet = new Set(taskIds);
            return {
              excludedTaskIds: prev.excludedTaskIds.filter(id => !removeSet.has(id)),
              scheduleResult: null,
              savedAt: Date.now(),
            };
          })
        ),

      clearExcludedTasks: source =>
        set(state => updateSource(state, source, { excludedTaskIds: [], scheduleResult: null, savedAt: Date.now() })),

      updateTask: (source, taskId, updates) =>
        set(state =>
          updateSource(state, source, prev => ({
            tasks: prev.tasks.map(t => (t.id === taskId ? { ...t, ...updates } : t)),
            modifiedTaskIds: prev.modifiedTaskIds.includes(taskId)
              ? prev.modifiedTaskIds
              : [...prev.modifiedTaskIds, taskId],
            scheduleResult: null,
            savedAt: Date.now(),
          }))
        ),

      updateEstimateDuration: (source, taskId, p50) =>
        set(state =>
          updateSource(state, source, prev => ({
            estimates: prev.estimates.map(e => (e.taskId === taskId ? { ...e, duration: { ...e.duration, p50 } } : e)),
            scheduleResult: null,
            savedAt: Date.now(),
          }))
        ),

      reassignScheduledTask: (source, taskId, newEngineerId) =>
        set(state => {
          const prev = state[source];
          if (!prev.scheduleResult) return {};

          const updatedSchedule = prev.scheduleResult.schedule.map(item =>
            item.taskId === taskId ? { ...item, engineerId: newEngineerId } : item
          );

          // Re-pack tasks per engineer to eliminate gaps and overlaps
          const byEngineer = new Map<string, typeof updatedSchedule>();
          for (const item of updatedSchedule) {
            const list = byEngineer.get(item.engineerId) ?? [];
            list.push(item);
            byEngineer.set(item.engineerId, list);
          }
          const newSchedule: typeof updatedSchedule = [];
          const newLoads: Record<string, number> = {};
          for (const eng of prev.engineers) {
            newLoads[eng.id] = 0;
          }
          let makespan = 0;
          for (const [engId, items] of byEngineer) {
            items.sort((a, b) => a.startTime - b.startTime);
            let cursor = 0;
            for (const item of items) {
              newSchedule.push({ ...item, startTime: cursor, endTime: cursor + item.duration });
              cursor += item.duration;
              if (newLoads[engId] !== undefined) newLoads[engId] += item.duration;
            }
            if (cursor > makespan) makespan = cursor;
          }

          return updateSource(state, source, {
            tasks: prev.tasks.map(t => (t.id === taskId ? { ...t, assignee: newEngineerId } : t)),
            modifiedTaskIds: prev.modifiedTaskIds.includes(taskId)
              ? prev.modifiedTaskIds
              : [...prev.modifiedTaskIds, taskId],
            scheduleResult: {
              ...prev.scheduleResult,
              schedule: newSchedule,
              engineerLoads: newLoads,
              makespan,
            },
            savedAt: Date.now(),
          });
        }),

      setJiraSyncMeta: (source, accountIdMap, originalStatuses) =>
        set(state =>
          updateSource(state, source, { jiraAccountIdMap: accountIdMap, jiraOriginalStatuses: originalStatuses })
        ),

      discardTaskChanges: source =>
        set(state =>
          updateSource(state, source, prev => ({
            tasks: prev.originalTasks.map(t => ({ ...t })),
            modifiedTaskIds: [],
            scheduleResult: null,
            savedAt: Date.now(),
          }))
        ),

      clearSyncedTasks: (source, taskIds) =>
        set(state =>
          updateSource(state, source, prev => {
            const syncedSet = new Set(taskIds);
            const taskMap = new Map(prev.tasks.map(t => [t.id, t]));
            return {
              originalTasks: prev.originalTasks.map(t =>
                syncedSet.has(t.id) && taskMap.has(t.id) ? { ...taskMap.get(t.id)! } : t
              ),
              modifiedTaskIds: prev.modifiedTaskIds.filter(id => !syncedSet.has(id)),
              savedAt: Date.now(),
            };
          })
        ),

      clearAll: source => set(state => updateSource(state, source, { ...EMPTY_SOURCE_DATA })),
    }),
    {
      name: 'b4m-pi-swag-store',
      version: 6,

      // Migrate store across versions
      migrate: (persisted, version) => {
        // v5 -> v6: Add labelFilter, assigneeFilter, priorityFilter, complexityFilter, durationMode
        if (version === 5) {
          const old = persisted as { github: Record<string, unknown>; jira: Record<string, unknown> };
          return {
            github: {
              ...old.github,
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
            jira: {
              ...old.jira,
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
          };
        }

        // v4 -> v6: Add excludedTaskIds, new filters, and durationMode
        if (version === 4) {
          const old = persisted as { github: Record<string, unknown>; jira: Record<string, unknown> };
          return {
            github: {
              ...old.github,
              excludedTaskIds: [],
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
            jira: {
              ...old.jira,
              excludedTaskIds: [],
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
          };
        }

        // v3 -> v6: Add engineerFilter, excludedTaskIds, new filters, and durationMode
        if (version === 3) {
          const old = persisted as { github: Record<string, unknown>; jira: Record<string, unknown> };
          return {
            github: {
              ...old.github,
              engineerFilter: (old.github.engineerFilter as string[]) ?? [],
              excludedTaskIds: [],
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
            jira: {
              ...old.jira,
              engineerFilter: (old.jira.engineerFilter as string[]) ?? [],
              excludedTaskIds: [],
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
          };
        }

        // v2 -> v6: Add statusFilter, engineerFilter, excludedTaskIds, new filters to each namespace, and durationMode
        if (version === 2) {
          const old = persisted as { github: Record<string, unknown>; jira: Record<string, unknown> };
          return {
            github: {
              ...old.github,
              statusFilter: (old.github.statusFilter as string[]) ?? [],
              engineerFilter: [],
              excludedTaskIds: [],
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
            jira: {
              ...old.jira,
              statusFilter: (old.jira.statusFilter as string[]) ?? [],
              engineerFilter: [],
              excludedTaskIds: [],
              labelFilter: [],
              assigneeFilter: [],
              priorityFilter: [],
              complexityFilter: [],
              durationMode: 'p50',
            },
          };
        }

        // v0/v1 -> v6: Flat shape -> namespaced with all filters
        if (version === 0 || version === 1) {
          // v1 (or unversioned) had flat shape - move everything into github namespace
          const old = persisted as Record<string, unknown>;
          const migrated: SourceData = {
            tasks: (old.tasks as SoftwareTask[]) ?? [],
            engineers: (old.engineers as SoftwareEngineer[]) ?? [],
            estimates: (old.estimates as SWAGEstimate[]) ?? [],
            scheduleResult: (old.scheduleResult as SoftwareScheduleResult | null) ?? null,
            solverMode: (old.solverMode as SolverMode) ?? 'balanced',
            durationMode: (old.durationMode as DurationMode) ?? 'p50',
            savedAt: (old.savedAt as number | null) ?? null,
            repoFilter: (old.repoFilter as string[]) ?? [],
            statusFilter: (old.statusFilter as string[]) ?? [],
            engineerFilter: [],
            labelFilter: [],
            assigneeFilter: [],
            priorityFilter: [],
            complexityFilter: [],
            excludedTaskIds: [],
            engineerRepoAssignments: (old.engineerRepoAssignments as Record<string, string[]>) ?? {},
            originalTasks: (old.originalTasks as SoftwareTask[]) ?? [],
            modifiedTaskIds: (old.modifiedTaskIds as string[]) ?? [],
            jiraAccountIdMap: (old.jiraAccountIdMap as Record<string, string>) ?? {},
            jiraOriginalStatuses: (old.jiraOriginalStatuses as Record<string, string>) ?? {},
          };

          // If old tasks had mixed sources, split them
          const githubTasks = migrated.tasks.filter(t => (t.source || 'github') === 'github');
          const jiraTasks = migrated.tasks.filter(t => t.source === 'jira');
          const githubOriginals = migrated.originalTasks.filter(t => (t.source || 'github') === 'github');
          const jiraOriginals = migrated.originalTasks.filter(t => t.source === 'jira');
          const githubTaskIds = new Set(githubTasks.map(t => t.id));
          const jiraTaskIds = new Set(jiraTasks.map(t => t.id));

          return {
            github: {
              ...migrated,
              tasks: githubTasks,
              originalTasks: githubOriginals,
              modifiedTaskIds: migrated.modifiedTaskIds.filter(id => githubTaskIds.has(id)),
              estimates: migrated.estimates.filter(e => githubTaskIds.has(e.taskId)),
              // Keep scheduleResult only if all scheduled tasks are github
              scheduleResult:
                migrated.scheduleResult && migrated.scheduleResult.schedule.every(s => githubTaskIds.has(s.taskId))
                  ? migrated.scheduleResult
                  : null,
              // Clear Jira metadata from github namespace
              jiraAccountIdMap: {},
              jiraOriginalStatuses: {},
            },
            jira: {
              ...EMPTY_SOURCE_DATA,
              tasks: jiraTasks,
              originalTasks: jiraOriginals,
              modifiedTaskIds: migrated.modifiedTaskIds.filter(id => jiraTaskIds.has(id)),
              estimates: migrated.estimates.filter(e => jiraTaskIds.has(e.taskId)),
              savedAt: jiraTasks.length > 0 ? migrated.savedAt : null,
              jiraAccountIdMap: migrated.jiraAccountIdMap,
              jiraOriginalStatuses: Object.fromEntries(
                Object.entries(migrated.jiraOriginalStatuses).filter(([id]) => jiraTaskIds.has(id))
              ),
            },
          };
        }
        return persisted;
      },

      partialize: state => ({
        github: state.github,
        jira: state.jira,
      }),

      onRehydrateStorage: () => state => {
        if (!state) return;
        const now = Date.now();
        const updates: Partial<SwagStore> = {};
        let needsUpdate = false;

        for (const source of ['github', 'jira'] as const) {
          const data = state[source];
          if (data?.savedAt) {
            const hoursSinceSave = (now - data.savedAt) / (1000 * 60 * 60);
            if (hoursSinceSave > EXPIRATION_HOURS) {
              updates[source] = { ...EMPTY_SOURCE_DATA };
              needsUpdate = true;
            }
          }
        }

        if (needsUpdate) {
          useSwagStore.setState(updates);
        }
      },
    }
  )
);
