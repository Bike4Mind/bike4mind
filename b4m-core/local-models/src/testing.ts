/** Test doubles for packages that drive these runtimes, such as the CLI's `b4m models` tests. Not for runtime use. */
export { FAKE_VLLM_MAX_MODEL_LEN, FAKE_VLLM_SERVED, startFakeVllm, type FakeVllm } from './__test__/fakeVllm';
export {
  delay,
  hang,
  json,
  sendJson,
  startFakeServer,
  type FakeServer,
  type Handler,
  type RecordedRequest,
} from './__test__/fakeServer';
