// Outlives Home: opening Settings navigates away and unmounts it, and closing Settings must land
// back on the local session. A reload starts signed out again, as before.
let active = false;

export function isLocalChatActive(): boolean {
  return active;
}

export function setLocalChatActive(next: boolean): void {
  active = next;
}
