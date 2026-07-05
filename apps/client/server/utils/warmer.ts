/** Detects a Lambda warmer invocation. */
export function isWarmerInvocation(event: any): boolean {
  return Boolean(event?.warmer || event?.source === 'warmer');
}

/** Lets Lambda handlers exit early on warmer calls. */
export function handleWarmerInvocation(event: any): boolean {
  if (isWarmerInvocation(event)) {
    console.log('Warmer invocation detected, keeping function warm');
    return true;
  }
  return false;
}
