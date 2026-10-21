import { describe, expect, it } from 'vitest';
import { publicVideoModel } from '../media/__fixtures__/videoModels';
import { toolsForRequest } from './registry';
import { readsUntrusted, sendsOut, spendsCredits } from './riskAssessment';

describe('the credit-spending axis', () => {
  it.each(['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music', 'session_spawn'])(
    '%s spends credits and always asks',
    name => {
      expect(spendsCredits(name)).toBe(true);
    }
  );

  it('does not fold the shell tools into the cost axis', () => {
    expect(spendsCredits('bash_execute')).toBe(false);
    expect(spendsCredits('file_write')).toBe(false);
  });

  it('leaves session_send to the approval mode, because the relay bounds already cap the chain', () => {
    expect(spendsCredits('session_send')).toBe(false);
  });
});

describe('the untrusted-content and outbound axes', () => {
  it('reads the tools whose result is someone else\'s text, by name and by family', () => {
    for (const name of ['web_fetch', 'web_search', 'skill', 'session_read', 'browser_snapshot', 'mcp__notion_search']) {
      expect(readsUntrusted(name), name).toBe(true);
    }
    for (const name of ['bash_execute', 'file_read', 'grep_search', 'session_send']) {
      expect(readsUntrusted(name), name).toBe(false);
    }
  });

  it('sends out on the shell, the browser, the web and another conversation', () => {
    for (const name of [
      'bash_execute',
      'bash_background',
      'web_fetch',
      'browser_navigate',
      'browser_tabs',
      'session_send',
      'mcp__notion_search',
    ]) {
      expect(sendsOut(name), name).toBe(true);
    }
    for (const name of ['bash_output', 'bash_list', 'file_read', 'session_read', 'web_search']) {
      expect(sendsOut(name), name).toBe(false);
    }
  });

  /**
   * The families are matched by prefix, so a new member is covered as it ships; a tool that
   * belongs to none of the three axes has to be named here instead. This is what makes a new
   * tool's classification a decision rather than a default: add one without a line here and
   * this test fails.
   */
  const NEITHER: readonly string[] = [
    // Reads and edits of the user's own files, which the path check already judges.
    'file_read',
    'glob_files',
    'grep_search',
    'file_write',
    'file_edit',
    // Inspecting or stopping a process the user already approved.
    'bash_output',
    'bash_list',
    'bash_kill',
    'todo_write',
    'explore',
    // Conversations of this project: reading one taints, listing and archiving do not.
    'session_list',
    'session_archive',
    'session_delete',
    // Cards only a human click can answer.
    'session_suggestion_update',
    'session_suggestion_dismiss',
    'ask_user',
    'request_directory',
    'mcp_list_servers',
    'mcp_add_server',
    'mcp_update_server',
    'mcp_set_server_enabled',
    'mcp_reconnect_server',
    'mcp_remove_server',
    // The project's own memory store.
    'memory_read',
    'memory_write',
    'memory_delete',
  ];

  it('classifies every tool the app can offer', () => {
    const declared = toolsForRequest({
      roots: ['/tmp/proj'],
      media: true,
      video: [publicVideoModel('gemini-omni-1.1-flash')],
      host: true,
      explore: true,
      browser: true,
      memory: true,
      skills: true,
      web: true,
      ask: true,
      mcpServers: true,
      mcp: [],
      modelId: 'claude-sonnet-5-5',
    }).map(entry => entry.toolSchema.name);

    const unclassified = declared.filter(
      name => !spendsCredits(name) && !readsUntrusted(name) && !sendsOut(name)
    );
    expect([...unclassified].sort()).toEqual([...NEITHER].sort());
  });
});
