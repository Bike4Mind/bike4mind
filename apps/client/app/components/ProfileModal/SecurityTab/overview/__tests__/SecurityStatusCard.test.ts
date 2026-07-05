import { describe, it, expect } from 'vitest';
import type { useTheme } from '@mui/joy';
import { getUserStatusLabel, getUserBadgeColors } from '../SecurityStatusCard';

const mockPalette = {
  security: {
    critical: { gradientStart: 'red-start', gradientEnd: 'red-end', shadow: 'red-shadow' },
    high: { gradientStart: 'orange-start', gradientEnd: 'orange-end', shadow: 'orange-shadow' },
    moderate: { gradientStart: 'yellow-start', gradientEnd: 'yellow-end', shadow: 'yellow-shadow' },
    good: { gradientStart: 'green-start', gradientEnd: 'green-end', shadow: 'green-shadow' },
    excellent: { gradientStart: 'teal-start', gradientEnd: 'teal-end', shadow: 'teal-shadow' },
    neutral: { gradientStart: 'gray-start', gradientEnd: 'gray-end', shadow: 'gray-shadow' },
  },
} as unknown as ReturnType<typeof useTheme>['palette'];

describe('getUserStatusLabel', () => {
  it('returns "High Risk" for riskLevel high regardless of score', () => {
    expect(getUserStatusLabel(90, 'high')).toBe('High Risk');
    expect(getUserStatusLabel(10, 'high')).toBe('High Risk');
  });

  it('returns "Moderate Risk" for riskLevel medium', () => {
    expect(getUserStatusLabel(60, 'medium')).toBe('Moderate Risk');
  });

  it('returns "Excellent" when score >= 85 and riskLevel low', () => {
    expect(getUserStatusLabel(85, 'low')).toBe('Excellent');
    expect(getUserStatusLabel(100, 'low')).toBe('Excellent');
  });

  it('returns "Good" when score >= 70 and < 85 and riskLevel low', () => {
    expect(getUserStatusLabel(70, 'low')).toBe('Good');
    expect(getUserStatusLabel(84, 'low')).toBe('Good');
  });

  it('returns "At Risk" when score < 70 and riskLevel low', () => {
    expect(getUserStatusLabel(0, 'low')).toBe('At Risk');
    expect(getUserStatusLabel(69, 'low')).toBe('At Risk');
  });
});

describe('getUserBadgeColors', () => {
  it('returns critical colors for riskLevel high regardless of score', () => {
    const result = getUserBadgeColors(80, 'high', mockPalette);
    expect(result.gradient).toContain('red-start');
    expect(result.gradient).toContain('red-end');
    expect(result.shadow).toContain('red-shadow');
    expect(result.textShadow).toBe('none');
  });

  it('returns high colors for riskLevel medium', () => {
    const result = getUserBadgeColors(60, 'medium', mockPalette);
    expect(result.gradient).toContain('orange-start');
    expect(result.gradient).toContain('orange-end');
    expect(result.shadow).toContain('orange-shadow');
    expect(result.textShadow).toBe('none');
  });

  it('returns high colors for riskLevel low with score < 50', () => {
    const result = getUserBadgeColors(30, 'low', mockPalette);
    expect(result.gradient).toContain('orange-start');
    expect(result.gradient).toContain('orange-end');
    expect(result.shadow).toContain('orange-shadow');
  });

  it('returns moderate colors when score >= 50 and < 70 with riskLevel low', () => {
    const result50 = getUserBadgeColors(50, 'low', mockPalette);
    expect(result50.gradient).toContain('yellow-start');
    expect(result50.gradient).toContain('yellow-end');
    expect(result50.shadow).toContain('yellow-shadow');
    expect(result50.textShadow).toBe('none');

    const result69 = getUserBadgeColors(69, 'low', mockPalette);
    expect(result69.gradient).toContain('yellow-start');
  });

  it('returns good colors when score >= 70 and < 85 with riskLevel low', () => {
    const result = getUserBadgeColors(70, 'low', mockPalette);
    expect(result.gradient).toContain('green-start');
    expect(result.gradient).toContain('green-end');
    expect(result.shadow).toContain('green-shadow');
    expect(result.textShadow).toBe('none');

    const result84 = getUserBadgeColors(84, 'low', mockPalette);
    expect(result84.gradient).toContain('green-start');
  });

  it('returns excellent colors when score >= 85 with riskLevel low', () => {
    const result = getUserBadgeColors(85, 'low', mockPalette);
    expect(result.gradient).toContain('teal-start');
    expect(result.gradient).toContain('teal-end');
    expect(result.shadow).toContain('teal-shadow');
    expect(result.textShadow).toBe('none');

    const result100 = getUserBadgeColors(100, 'low', mockPalette);
    expect(result100.gradient).toContain('teal-start');
  });
});
