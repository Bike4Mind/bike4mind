import { useCallback, useEffect, useState } from 'react';
import { NO_SKILLS, type SkillsState } from '@shared/skills';

export interface SkillsController extends SkillsState {
  /** Re-read from disk. The picker calls this when it opens, so a skill written a minute ago shows. */
  refresh: () => Promise<void>;
  /** Let this session's project contribute its skills, and remember the answer for that path. */
  trustProject: () => Promise<void>;
}

/**
 * The skills the open conversation can run.
 *
 * Read on demand rather than pushed, unlike the MCP servers: nothing changes a skill set except
 * the user editing a markdown file or trusting a project, so there is no transition worth
 * subscribing to - and the picker asks for a fresh read every time it opens, which covers the
 * file they just wrote.
 */
export function useSkills(sessionId: string | null): SkillsController {
  const [state, setState] = useState<SkillsState>(NO_SKILLS);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setState(NO_SKILLS);
      return;
    }
    setState(await window.b4m.chat.listSkills(sessionId));
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const trustProject = useCallback(async () => {
    if (!sessionId) return;
    setState(await window.b4m.chat.setProjectSkillsTrusted(sessionId, true));
  }, [sessionId]);

  return { ...state, refresh, trustProject };
}
