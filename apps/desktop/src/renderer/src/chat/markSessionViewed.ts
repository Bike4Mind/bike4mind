export function canAcknowledgeSession(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function markSessionViewed(sessionId: string): void {
  if (!canAcknowledgeSession()) return;
  void window.b4m.chat.getSession(sessionId, true).catch(error => {
    console.warn('Could not acknowledge viewed session', error);
  });
}
