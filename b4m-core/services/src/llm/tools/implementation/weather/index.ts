import { ToolDefinition } from '../../base/types';
import { GetEffectiveApiKeyAdapters, getOpenWeatherKey } from '../../../../apiKeyService';

export interface WeatherParams {
  lat: number;
  lon: number;
  units?: 'imperial' | 'metric';
}

export async function fetchWeatherData(db: GetEffectiveApiKeyAdapters['db'], params: WeatherParams): Promise<string> {
  const openWeatherKey = await getOpenWeatherKey({ db });
  if (!openWeatherKey) {
    throw new Error('OpenWeather API key is not configured.');
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${params.lat}&lon=${params.lon}&appid=${openWeatherKey}&units=${params.units || 'imperial'}`
    );
  } catch (err) {
    throw new Error(`OpenWeather fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    throw new Error(`OpenWeather error: ${response.statusText}`);
  }

  const data = await response.json();
  const temp = data?.main?.temp;
  const cityName = data?.name;
  const description = data?.weather?.[0]?.description;

  return `Right now it's ${temp}° in ${cityName}, with ${description}.`;
}

export const weatherTool: ToolDefinition = {
  name: 'weather_info',
  implementation: context => ({
    toolFn: async value => {
      const params = value as WeatherParams;
      await context.onStart?.('weather_info', params);
      return fetchWeatherData(context.db, params);
    },
    toolSchema: {
      name: 'weather_info',
      description: 'Get current weather info from the OpenWeather API using latitude and longitude',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude of the location' },
          lon: { type: 'number', description: 'Longitude of the location' },
          units: {
            type: 'string',
            description: 'Units: either "imperial" or "metric"',
            enum: ['imperial', 'metric'],
          },
        },
        required: ['lat', 'lon'],
      },
    },
  }),
};
