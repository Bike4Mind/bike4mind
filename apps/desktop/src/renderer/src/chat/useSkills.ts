import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NO_SKILLS, type SkillsScope, type SkillsState } from '@shared/skills';

export interface SkillsController extends SkillsState {
  /** Re-read from disk. The picker calls this when it opens, so a skill written a minute ago shows. */
  refresh: () => Promise<void>;
  /** Let this conversation's project contribute its skills, and remember the answer for that path. */
  trustProject: () => Promise<void>;
}

/**
 * The skills the open conversation - saved, or a draft not yet sent - can run.
 *
 * Read on demand rather than pushed, unlike the MCP servers: nothing changes a skill set except
 * the user editing a markdown file or trusting a project, so there is no transition worth
 * subscribing to - and the picker asks for a fresh read every time it opens, which covers the
 * file they just wrote.
 */
export function useSkills(scope: SkillsScope | null): SkillsController {
  const [state, setState] = useState<SkillsState>(NO_SKILLS);
  const sessionId = scope && 'sessionId' in scope ? scope.sessionId : null;
  const isDraft = !!scope && 'draftDirectory' in scope;
  const draftDirectory = scope && 'draftDirectory' in scope ? scope.draftDirectory : null;
  const stable = useMemo<SkillsScope | null>(
    () => (sessionId ? { sessionId } : isDraft ? { draftDirectory } : null),
    [sessionId, isDraft, draftDirectory]
  );
  // A draft's folder can change while a read is in flight; only the latest read may land.
  const latest = useRef(0);

  const load = useCallback(
    async (read: (scope: SkillsScope) => Promise<SkillsState>) => {
      const request = ++latest.current;
      const next = stable ? await read(stable) : NO_SKILLS;
      if (request === latest.current) setState(next);
    },
    [stable]
  );

  const refresh = useCallback(() => load(target => window.b4m.chat.listSkills(target)), [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const trustProject = useCallback(async () => {
    if (!stable) return;
    await load(target => window.b4m.chat.setProjectSkillsTrusted(target, true));
  }, [stable, load]);

  return { ...state, refresh, trustProject };
}
