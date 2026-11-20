// A stand-in for baseApi/adminApi: records the middleware and method handlers, and runs them in order.
type Handler = (req: unknown, res: unknown, next?: () => void) => unknown;

export function makeChain(config?: unknown) {
  const middleware: Handler[] = [];
  const methods: Record<string, Handler> = {};
  const chain = Object.assign(
    async (req: { method?: string }, res: unknown) => {
      for (const fn of middleware) {
        let advanced = false;
        await fn(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
      return methods[(req.method ?? 'GET').toLowerCase()]?.(req, res);
    },
    {
      _config: config,
      use: (fn: Handler) => (middleware.push(fn), chain),
      get: (fn: Handler) => ((methods.get = fn), chain),
      post: (fn: Handler) => ((methods.post = fn), chain),
      put: (fn: Handler) => ((methods.put = fn), chain),
    }
  );
  return chain;
}
