import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { getAvailableModels, setModelPriceRowsProvider } from './index';

// Only LocalImageBackend does a network call for getModelInfo here; the rest of
// the backends (with apiKeys=null) are either null or return static arrays.
vi.mock('axios');
const mockedGet = vi.mocked(axios.get);

const savedSelfHost = process.env.B4M_SELF_HOST;
const savedUrl = process.env.IMAGE_GEN_BASE_URL;

describe('getAvailableModels local-image env gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // setModelPriceRowsProvider(null) also resets the module-level model cache,
    // so each case re-runs the backend fan-out instead of reusing a cached list.
    setModelPriceRowsProvider(null);
    mockedGet.mockResolvedValue({ data: [{ title: 'sd15.safetensors [x]', model_name: 'sd15' }] });
  });

  afterEach(() => {
    setModelPriceRowsProvider(null);
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedUrl === undefined) delete process.env.IMAGE_GEN_BASE_URL;
    else process.env.IMAGE_GEN_BASE_URL = savedUrl;
  });

  it('does NOT enumerate local image models when IMAGE_GEN_BASE_URL is set but B4M_SELF_HOST is not', async () => {
    delete process.env.B4M_SELF_HOST;
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';

    const models = await getAvailableModels(null);

    expect(models.some(m => m.id.startsWith('local-image/'))).toBe(false);
    // The backend must not even be constructed / queried outside self-host.
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('enumerates local image models under B4M_SELF_HOST', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';

    const models = await getAvailableModels(null);

    expect(models.some(m => m.id === 'local-image/sd15')).toBe(true);
  });
});
