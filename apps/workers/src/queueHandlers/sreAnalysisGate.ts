import type { SreGateConfig, SreSourceType } from '@bike4mind/common';

export type DiagnosticianGateResult = 'auto' | 'ask' | 'stop';

/** An 'auto' band only dispatches a fix when the payload source is allow-listed; otherwise it needs approval. */
export function resolveDiagnosticianGate(
  gate: Pick<SreGateConfig, 'enabled' | 'autoThreshold' | 'askThreshold'> & {
    autoDispatchSources?: readonly SreSourceType[];
  },
  confidence: number,
  source: SreSourceType
): DiagnosticianGateResult {
  let band: DiagnosticianGateResult = 'auto';
  if (gate.enabled) {
    if (confidence >= gate.autoThreshold) band = 'auto';
    else if (confidence >= gate.askThreshold) band = 'ask';
    else band = 'stop';
  }
  if (band === 'auto' && !(gate.autoDispatchSources ?? []).includes(source)) return 'ask';
  return band;
}
