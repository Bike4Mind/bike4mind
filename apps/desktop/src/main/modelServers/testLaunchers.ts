import type { Launchers } from './LocalServerSupervisor';

/** For tests that start no server: Ollama counts as found, and a start fails without spawning anything. */
export function inertLaunchers(): Launchers {
  return {
    program: async () => ({ path: '/opt/test/ollama' }),
    start: async () => {
      throw new Error('This test starts no servers.');
    },
  };
}
