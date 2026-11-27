export async function withinTriageBudget<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('DLQ triage deadline reached');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DLQ triage deadline reached')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
