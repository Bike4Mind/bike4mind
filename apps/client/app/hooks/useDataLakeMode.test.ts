import { describe, it, expect, beforeEach } from 'vitest';
import useDataLakeMode from './useDataLakeMode';

describe('useDataLakeMode', () => {
  beforeEach(() => {
    useDataLakeMode.setState({ enabled: false, seededSessionId: null });
  });

  it('seeds enabled from a session forceKnowledgeRetrieval flag on first sight', () => {
    useDataLakeMode.getState().seedFromSession({ id: 's1', forceKnowledgeRetrieval: true });
    expect(useDataLakeMode.getState().enabled).toBe(true);
    expect(useDataLakeMode.getState().seededSessionId).toBe('s1');
  });

  it('does not clobber a local toggle when the same session id is seen again', () => {
    useDataLakeMode.getState().seedFromSession({ id: 's1', forceKnowledgeRetrieval: false });
    useDataLakeMode.getState().setEnabled(true);
    useDataLakeMode.getState().seedFromSession({ id: 's1', forceKnowledgeRetrieval: false });
    expect(useDataLakeMode.getState().enabled).toBe(true);
  });

  it('re-seeds when switching to a different session id', () => {
    useDataLakeMode.getState().seedFromSession({ id: 's1', forceKnowledgeRetrieval: true });
    useDataLakeMode.getState().seedFromSession({ id: 's2', forceKnowledgeRetrieval: false });
    expect(useDataLakeMode.getState().enabled).toBe(false);
    expect(useDataLakeMode.getState().seededSessionId).toBe('s2');
  });

  it('resets to off when there is no session (e.g. /new)', () => {
    useDataLakeMode.getState().seedFromSession({ id: 's1', forceKnowledgeRetrieval: true });
    useDataLakeMode.getState().seedFromSession(null);
    expect(useDataLakeMode.getState().enabled).toBe(false);
    expect(useDataLakeMode.getState().seededSessionId).toBe(null);
  });

  it('setEnabled updates the flag', () => {
    useDataLakeMode.getState().setEnabled(true);
    expect(useDataLakeMode.getState().enabled).toBe(true);
  });
});
