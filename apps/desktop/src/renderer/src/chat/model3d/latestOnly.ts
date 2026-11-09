/**
 * Wraps an async job so it never runs twice at once: calls made while it runs collapse into a
 * single follow-up run, which reads whatever inputs are latest by then. Nothing is dropped at the
 * end, so the last call always gets a run that starts after it. The job handles its own errors.
 */
export function latestOnly(job: () => Promise<unknown>): () => void {
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    running = true;
    again = false;
    try {
      await job();
    } finally {
      running = false;
      if (again) void run();
    }
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    void run();
  };
}
