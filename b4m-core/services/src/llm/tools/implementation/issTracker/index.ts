import { ToolDefinition } from '../../base/types';

interface ISSTrackerParams {
  operation: 'current_position' | 'crew';
  latitude?: number;
  longitude?: number;
}

interface ISSPositionResponse {
  message: string;
  timestamp: number;
  iss_position: {
    latitude: string;
    longitude: string;
  };
}

interface AstrosResponse {
  message: string;
  number: number;
  people: Array<{
    name: string;
    craft: string;
  }>;
}

/**
 * Get the name of the location based on latitude/longitude (rough approximation)
 */
const getLocationDescription = (lat: number, lon: number): string => {
  // Rough geographic regions
  if (lat > 66.5) return 'Arctic region';
  if (lat < -66.5) return 'Antarctic region';

  // Determine east/west
  const ewDir = lon >= 0 ? 'Eastern' : 'Western';

  // Ocean detection (very rough)
  if ((lon >= -80 && lon <= 0 && lat >= 0 && lat <= 60) || (lon >= -80 && lon <= 0 && lat >= -60 && lat < 0)) {
    return 'Atlantic Ocean';
  }
  if ((lon >= 100 && lon <= 180) || (lon >= -180 && lon <= -100)) {
    if (lat >= -60 && lat <= 60) return 'Pacific Ocean';
  }
  if (lon >= 40 && lon <= 100 && lat >= -40 && lat <= 30) {
    return 'Indian Ocean';
  }

  // Continental regions (rough)
  if (lat >= 25 && lat <= 50 && lon >= -130 && lon <= -60) return 'North America';
  if (lat >= -55 && lat < 15 && lon >= -80 && lon <= -35) return 'South America';
  if (lat >= 35 && lat <= 72 && lon >= -10 && lon <= 40) return 'Europe';
  if (lat >= -35 && lat <= 37 && lon >= -20 && lon <= 55) return 'Africa';
  if (lat >= 10 && lat <= 55 && lon >= 60 && lon <= 145) return 'Asia';
  if (lat >= -50 && lat <= -10 && lon >= 110 && lon <= 180) return 'Australia/Oceania';

  return `${ewDir} Hemisphere`;
};

/**
 * Calculate approximate distance between two points (Haversine formula)
 */
const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getISSData = async (parameters: ISSTrackerParams): Promise<string> => {
  const { operation, latitude, longitude } = parameters;

  const results: string[] = [];

  try {
    if (operation === 'current_position') {
      const response = await fetch('http://api.open-notify.org/iss-now.json');

      if (!response.ok) {
        throw new Error(`ISS API error: ${response.status} ${response.statusText}`);
      }

      const data: ISSPositionResponse = await response.json();

      if (data.message !== 'success') {
        throw new Error('Failed to get ISS position from API');
      }

      const issLat = parseFloat(data.iss_position.latitude);
      const issLon = parseFloat(data.iss_position.longitude);
      const timestamp = new Date(data.timestamp * 1000);

      results.push('🛰️ **International Space Station - Current Position**');
      results.push('');
      results.push(`**Coordinates:**`);
      results.push(`- Latitude: ${issLat.toFixed(4)}° ${issLat >= 0 ? 'N' : 'S'}`);
      results.push(`- Longitude: ${issLon.toFixed(4)}° ${issLon >= 0 ? 'E' : 'W'}`);
      results.push('');
      results.push(`**Location:** Currently over ${getLocationDescription(issLat, issLon)}`);
      results.push(`**Timestamp:** ${timestamp.toUTCString()}`);
      results.push('');
      results.push('**ISS Facts:**');
      results.push('- Altitude: ~420 km (260 miles) above Earth');
      results.push('- Speed: ~28,000 km/h (17,500 mph)');
      results.push('- Orbits Earth every ~90 minutes');
      results.push('- Visible from Earth at dawn/dusk when sunlit');

      // If user provided their location, calculate distance
      if (latitude !== undefined && longitude !== undefined) {
        const distance = calculateDistance(latitude, longitude, issLat, issLon);
        results.push('');
        results.push('**Distance from Your Location:**');
        results.push(
          `- Ground distance: ${Math.round(distance).toLocaleString()} km (${Math.round(distance * 0.621371).toLocaleString()} miles)`
        );

        // Calculate if ISS is roughly overhead (within ~2000km ground distance)
        if (distance < 2000) {
          results.push('- ⭐ The ISS may be visible from your location if conditions are right!');
        }
      }

      results.push('');
      results.push('_Track the ISS in real-time: https://spotthestation.nasa.gov/_');
    } else if (operation === 'crew') {
      const response = await fetch('http://api.open-notify.org/astros.json');

      if (!response.ok) {
        throw new Error(`Astronauts API error: ${response.status} ${response.statusText}`);
      }

      const data: AstrosResponse = await response.json();

      if (data.message !== 'success') {
        throw new Error('Failed to get astronaut data from API');
      }

      // Group by spacecraft
      const craftGroups: Record<string, string[]> = {};
      for (const person of data.people) {
        if (!craftGroups[person.craft]) {
          craftGroups[person.craft] = [];
        }
        craftGroups[person.craft].push(person.name);
      }

      results.push('👨‍🚀 **People Currently in Space**');
      results.push('');
      results.push(`**Total:** ${data.number} astronauts/cosmonauts`);
      results.push('');

      for (const [craft, crew] of Object.entries(craftGroups)) {
        const emoji = craft === 'ISS' ? '🛰️' : craft.includes('Shenzhou') ? '🇨🇳' : '🚀';
        results.push(`**${emoji} ${craft}** (${crew.length} crew):`);
        crew.forEach(name => results.push(`- ${name}`));
        results.push('');
      }

      results.push('_Data from NASA Open Notify API_');
    } else {
      throw new Error(`Unknown operation: ${operation}. Supported operations: current_position, crew`);
    }

    return results.join('\n');
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch ISS data: ${String(error)}`);
  }
};

export const issTrackerTool: ToolDefinition = {
  name: 'iss_tracker',
  implementation: context => ({
    toolFn: async value => {
      const params = value as ISSTrackerParams;
      context.logger.log('🛰️ ISSTracker: Starting execution', params);

      try {
        const result = await getISSData(params);
        context.logger.log('✅ ISSTracker: Execution completed');
        return result;
      } catch (error) {
        context.logger.error('❌ ISSTracker: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'iss_tracker',
      description:
        'Track the International Space Station in real-time. Get current position, or see who is currently in space (on ISS and other spacecraft).',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            description:
              'What information to retrieve: "current_position" for ISS location, "crew" for people currently in space.',
            enum: ['current_position', 'crew'],
          },
          latitude: {
            type: 'number',
            description:
              'Your latitude (optional). If provided with longitude, will show distance from your location to ISS. Example: 40.7128 for NYC.',
          },
          longitude: {
            type: 'number',
            description:
              'Your longitude (optional). If provided with latitude, will show distance from your location to ISS. Example: -74.0060 for NYC.',
          },
        },
        additionalProperties: false,
        required: ['operation'],
      },
    },
  }),
};
