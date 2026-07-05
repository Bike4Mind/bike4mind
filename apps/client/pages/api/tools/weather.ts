import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { z } from 'zod';

const WeatherBodySchema = z.object({
  lat: z.number(),
  lon: z.number(),
  units: z.enum(['imperial', 'metric']).optional(),
});

const handler = baseApi().post(async (req, res) => {
  const { lat, lon, units = 'imperial' } = WeatherBodySchema.parse(req.body);

  const dbAdapters = {
    db: {
      apiKeys: apiKeyRepository,
      adminSettings: adminSettingsRepository,
    },
  };

  const openWeatherKey = await apiKeyService.getOpenWeatherKey(dbAdapters);
  if (!openWeatherKey) {
    throw new Error('OpenWeather API key is not configured.');
  }

  // Add timeout protection for external API call
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  let response: Response;
  try {
    response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${openWeatherKey}&units=${units}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      throw new Error('Weather API request timed out after 10s');
    }
    throw fetchError;
  }

  if (!response.ok) {
    throw new Error(`OpenWeather error: ${response.statusText}`);
  }

  const data = await response.json();
  const temp = data?.main?.temp;
  const cityName = data?.name;
  const description = data?.weather?.[0]?.description;

  const result = `Right now it's ${temp}° in ${cityName}, with ${description}.`;

  return res.json({
    result,
  });
});

export default handler;
