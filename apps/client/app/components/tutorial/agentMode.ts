import { useEffect, useState } from 'react';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useTutorialStore } from './useTutorialStore';

export const PAPERCLIP_ANCHOR = 'attach-files-btn';
export const AGENT_MODE_SWITCH_ANCHOR = 'attach-menu-agent-mode-switch';

export interface AgentModeCue {
  /** The control to ring; empty when there is none on screen to press. */
  anchor: string;
  hint: string;
}

const menuOpen = () => Boolean(document.querySelector(`[data-testid="${AGENT_MODE_SWITCH_ANCHOR}"]`));

/**
 * What the user has to change before sending, when the send would run as an agent and so could not be
 * answered from the recording. The card asks; it never changes the setting for them.
 */
export function useAgentModeCue(): AgentModeCue | null {
  const { isFeatureEnabled } = useFeatureEnabled();
  const { settings } = useUserSettings();
  const toggleOn = useLLM(state => state.agentMode.enabled);
  const block = !isFeatureEnabled('agentMode')
    ? null
    : settings.agentModeDefault === 'on'
      ? 'routing'
      : toggleOn
        ? 'toggle'
        : null;

  const [open, setOpen] = useState(menuOpen);
  useEffect(() => {
    if (block !== 'toggle') return;
    setOpen(menuOpen());
    const observer = new MutationObserver(() => setOpen(menuOpen()));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [block]);

  if (block === 'routing') {
    return {
      anchor: '',
      hint: 'Smart Routing is set to On, so every message runs in Agent mode, and the tutorial cannot answer those. Set Smart Routing to Off in your profile settings, then come back.',
    };
  }
  if (block === 'toggle') {
    return open
      ? { anchor: AGENT_MODE_SWITCH_ANCHOR, hint: 'Switch Agent mode off.' }
      : {
          anchor: PAPERCLIP_ANCHOR,
          hint: 'Agent mode is on, and the tutorial cannot answer a message sent in Agent mode. Press the + button beside the message box, then switch Agent mode off.',
        };
  }
  return null;
}

/**
 * Holds core's auto-routing off while `on`, as its Dismiss does for a session, so Smart Routing on Auto
 * cannot hand a scripted send to the agent. The flag is global and in memory, so leaving restores what
 * it was before.
 */
export function useAutoRouteOff(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const previous = useLLM.getState().disableAutoRouteForThisSession;
    useLLM.setState({ disableAutoRouteForThisSession: true });
    return () => {
      useLLM.setState({ disableAutoRouteForThisSession: previous });
    };
  }, [on]);
}

/** Holds auto-routing off while a module waits in the start box or runs on the open session, and nowhere else. */
export function useTutorialAutoRouteOff(sessionId: string | null, apiBase?: string) {
  const active = useTutorialStore(state => state.active, apiBase);
  const pending = useTutorialStore(state => state.pending, apiBase);
  useAutoRouteOff(Boolean(pending) || Boolean(active && active.sessionId === sessionId));
}
