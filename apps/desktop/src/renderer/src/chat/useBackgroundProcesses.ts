import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundProcessInfo } from '@shared/chat';

/** Per process, in the panel. Live output is a view, not a record - main holds the real buffer. */
const MAX_PANEL_CHARS = 20_000;

export interface BackgroundProcessView extends BackgroundProcessInfo {
  /** The tail of what it has printed, as the panel shows it. */
  output: string;
}

export interface BackgroundProcessesController {
  processes: BackgroundProcessView[];
  running: number;
  stop: (processId: string) => void;
}

/**
 * The conversation's background processes, kept in step with main.
 *
 * Main owns them outright, so this holds nothing it cannot rebuild: on mount - including after
 * a window reload, which kills the renderer and nothing else - it asks for the current list and
 * each process's buffered tail, then follows the live stream from there.
 */
export function useBackgroundProcesses(sessionId: string | null): BackgroundProcessesController {
  const [processes, setProcesses] = useState<BackgroundProcessView[]>([]);

  // Read inside the stream subscription, which is mounted once: rebuilding it per session
  // change would drop whatever arrived during the swap.
  const activeSessionId = useRef<string | null>(sessionId);
  activeSessionId.current = sessionId;

  useEffect(() => {
    if (!sessionId) {
      setProcesses([]);
      return;
    }

    let current = true;
    void window.b4m.chat.listBackgroundProcesses(sessionId).then(async list => {
      const withOutput = await Promise.all(
        list.map(async info => ({
          ...info,
          output: (await window.b4m.chat.readBackgroundOutput(sessionId, info.id)) ?? '',
        }))
      );
      if (current) setProcesses(withOutput);
    });

    return () => {
      current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    return window.b4m.chat.onStreamEvent(event => {
      if (event.type !== 'background-output' && event.type !== 'background-status') return;
      if (event.sessionId !== activeSessionId.current) return;

      if (event.type === 'background-status') {
        setProcesses(current => {
          const known = current.some(entry => entry.id === event.process.id);
          return known
            ? current.map(entry => (entry.id === event.process.id ? { ...entry, ...event.process } : entry))
            : [...current, { ...event.process, output: '' }];
        });
        return;
      }

      setProcesses(current =>
        current.map(entry => {
          if (entry.id !== event.processId) return entry;
          const next = entry.output + event.text;
          return { ...entry, output: next.length > MAX_PANEL_CHARS ? next.slice(-MAX_PANEL_CHARS) : next };
        })
      );
    });
  }, []);

  const stop = useCallback(
    (processId: string) => {
      if (sessionId) void window.b4m.chat.stopBackgroundProcess(sessionId, processId);
    },
    [sessionId]
  );

  return { processes, running: processes.filter(entry => entry.status === 'running').length, stop };
}
