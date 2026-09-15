---
title: World Time
description: Visual global time zone reference dashboard for coordinating across distributed team locations
sidebar_position: 29
tags: [admin, time, reference, tools]
---

# World Time

The World Time dashboard provides a visually rich, real-time global clock display for coordinating across distributed team members in different time zones. It is located in the Advanced section of the admin sidebar.

## Overview

The dashboard displays a grid of animated city cards, each showing the current local time, date, day/night status, and time zone information. The background dynamically shifts between a daytime sky and a nighttime starfield based on the average time across all displayed cities.

## Default Locations

Four team locations are displayed by default:

| City | Country | Time Zone |
|------|---------|-----------|
| Austin | USA | America/Chicago |
| Cebu | Philippines | Asia/Manila |
| Kyiv | Ukraine | Europe/Kiev |
| Louisville | USA | America/New_York |

## City Cards

Each city card displays the following information, updated every second:

| Element | Description |
|---------|-------------|
| **City name and emoji** | The city name with a representative emoji |
| **Country** | The country name |
| **Current time** | Local time in 12-hour format with seconds (e.g., `2:30:45 PM`) |
| **Current date** | Full date in `dddd, MMMM D, YYYY` format |
| **Time of day** | A colored chip indicating dawn, morning, afternoon, dusk, or night |
| **Sun/Moon icon** | Animated sun or moon icon based on calculated solar position |
| **Time zone** | IANA time zone identifier and UTC offset (e.g., `America/Chicago UTC-06:00`) |

### Time of Day Classification

| Period | Hours |
|--------|-------|
| Dawn | 5:00 AM -- 6:59 AM |
| Morning | 7:00 AM -- 11:59 AM |
| Afternoon | 12:00 PM -- 4:59 PM |
| Dusk | 5:00 PM -- 6:59 PM |
| Night | 7:00 PM -- 4:59 AM |

## Managing Locations

### Adding a Location

Click the **Add Location** button to open a search modal. The modal provides:

- A search input that filters cities by name, country, country code, time zone, or common time zone abbreviations (e.g., "PST", "CET", "JST")
- Quick-pick chips for popular cities (Los Angeles, Austin, Kyiv, Cebu, London, Tokyo, Sydney, Dubai)
- A scrollable list of matching cities from a curated world cities dataset

Click any city in the search results to add it to the dashboard. Cities already on the dashboard are excluded from search results.

### Removing a Location

Each city card has a close (X) button in the top-right corner. Clicking it immediately removes the city from the dashboard.

### Favoriting a Location

Each city card has a star button in the top-left corner. Toggling it marks the city as a favorite. Favorited cities are sorted to the top of the grid.

## Time Zone Abbreviation Search

The search supports common time zone abbreviations that map to IANA zones, including:

| Abbreviation | Zone(s) |
|-------------|---------|
| PST / PDT | America/Los_Angeles |
| CST / CDT | America/Chicago |
| EST / EDT | America/New_York |
| GMT / BST | Europe/London |
| CET / CEST | Europe/Paris, Berlin, Madrid, and others |
| IST | Asia/Kolkata |
| JST | Asia/Tokyo |
| AEST / AEDT | Australia/Sydney |

And many others including MST, HST, AKST, EET, MSK, SGT, HKT, KST, and NZST.

## Visual Effects

The dashboard includes several visual flourishes:

- **Dynamic background** -- Gradient shifts between a blue daytime sky and a dark nighttime sky based on the average hour across displayed cities
- **Star field** -- Animated pulsing stars appear during nighttime
- **Glowing cards** -- Cards have a gold glow during daytime and a purple glow at night, with hover effects
- **Floating icons** -- Sun and moon icons have a gentle floating animation
- **Smooth transitions** -- Cities animate in/out with spring physics when added or removed

## Best Practices

- Add the cities where your team members are located for quick time zone reference during scheduling.
- Favorite your most-checked locations so they appear first in the grid.
- Use time zone abbreviation search (e.g., "PST") when you know the zone but not a specific city.

---

## Related Articles

- [Team](./team.md) - Team member management
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
