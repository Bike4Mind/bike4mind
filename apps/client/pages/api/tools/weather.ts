import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@server/middlewares/rateLimit';
import { runAuditedTool } from '@server/cli/runAuditedTool';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { z } from 'zod';

const WeatherBodySchema = z.object({
  lat: z.number(),
  lon: z.number(),
  units: z.enum(['imperial', 'metric']).optional(),
});

// Same 100/hour budget as ai/v1/tools.ts, shared across the three /api/tools/* routes. Embed
// (confined) keys hold neither scope, so they are refused.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE] })
  .use(rateLimit({ limit: 100, windowMs: 60 * 60 * 1000, bucket: 'tools' }))
  .post(async (req, res) =>
    runAuditedTool('weather_info', req.user!.id, req.logger, async () => {
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

      const result = `Right now it's ${temp}\u00b0 in ${cityName}, with ${description}.`;

      return res.json({
        result,
      });
    })
  );

export default handler;
