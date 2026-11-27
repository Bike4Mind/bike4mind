/**
 * What a native emitter produces: file contents keyed by a path relative to
 * the target's output root. The emitter does not know where a platform keeps
 * the files; scripts/nativeOutputs.ts maps each one into the app's tree.
 */
export type EmittedFiles = Readonly<Record<string, string>>;
