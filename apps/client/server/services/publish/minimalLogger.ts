/** The slice of a logger these publish services accept, shared so the folder's copies cannot drift. */
export interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}
