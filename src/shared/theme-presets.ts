import type { AccentColor, GlassIntensity, ThemeMode, ThemePreset } from './types';

export interface ThemePresetMeta {
  id: ThemePreset;
  label: string;
  base: 'dark' | 'light';
  sidebarBg: string;
  canvasBg: string;
  elevatedBg: string;
  symbolColor: string;
  defaultAccent: AccentColor;
}

export const THEME_PRESETS: ThemePresetMeta[] = [
  {
    id: 'obsidian',
    label: 'Obsidian',
    base: 'dark',
    sidebarBg: '#0e0e10',
    canvasBg: '#141417',
    elevatedBg: '#19191d',
    symbolColor: '#e4e4e7',
    defaultAccent: 'blue',
  },
  {
    id: 'midnight',
    label: 'Midnight Slate',
    base: 'dark',
    sidebarBg: '#0b101b',
    canvasBg: '#0f1624',
    elevatedBg: '#151f32',
    symbolColor: '#e2e8f0',
    defaultAccent: 'blue',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    base: 'dark',
    sidebarBg: '#141416',
    canvasBg: '#1a1a1e',
    elevatedBg: '#222227',
    symbolColor: '#ededf0',
    defaultAccent: 'emerald',
  },
  {
    id: 'alabaster',
    label: 'Alabaster',
    base: 'light',
    sidebarBg: '#f7f7f8',
    canvasBg: '#ffffff',
    elevatedBg: '#ffffff',
    symbolColor: '#18181b',
    defaultAccent: 'blue',
  },
  {
    id: 'warm-paper',
    label: 'Warm Paper',
    base: 'light',
    sidebarBg: '#f4efe6',
    canvasBg: '#faf7f2',
    elevatedBg: '#fffdf9',
    symbolColor: '#292524',
    defaultAccent: 'amber',
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    base: 'dark',
    sidebarBg: '#000000',
    canvasBg: '#070709',
    elevatedBg: '#101014',
    symbolColor: '#ffffff',
    defaultAccent: 'default',
  },
];

export const ACCENT_SWATCHES: Array<{
  id: AccentColor;
  label: string;
  swatchDark: string;
  swatchLight: string;
}> = [
  { id: 'default', label: 'Mono', swatchDark: '#f5f5f7', swatchLight: '#111216' },
  { id: 'blue', label: 'Azure', swatchDark: '#60a5fa', swatchLight: '#2563eb' },
  { id: 'emerald', label: 'Emerald', swatchDark: '#34d399', swatchLight: '#15803d' },
  { id: 'violet', label: 'Violet', swatchDark: '#a78bfa', swatchLight: '#7c3aed' },
  { id: 'amber', label: 'Amber', swatchDark: '#fbbf24', swatchLight: '#b45309' },
  { id: 'rose', label: 'Rose', swatchDark: '#fb7185', swatchLight: '#e11d48' },
];

export function resolveTitlebarColors(
  theme: ThemeMode,
  preset: ThemePreset = 'obsidian',
  systemDark = true,
): { color: string; symbolColor: string; backgroundColor: string } {
  const effectiveMode = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const meta = THEME_PRESETS.find((p) => p.id === preset);
  if (meta && meta.base === effectiveMode) {
    return {
      color: meta.sidebarBg,
      symbolColor: meta.symbolColor,
      backgroundColor: meta.canvasBg,
    };
  }
  const fallback =
    effectiveMode === 'light'
      ? THEME_PRESETS.find((p) => p.id === 'alabaster')!
      : THEME_PRESETS.find((p) => p.id === 'obsidian')!;
  return {
    color: fallback.sidebarBg,
    symbolColor: fallback.symbolColor,
    backgroundColor: fallback.canvasBg,
  };
}

export interface WindowMaterialConfig {
  effectiveMode: 'light' | 'dark';
  useAcrylic: boolean;
  backgroundColor: string;
  overlayColor: string;
  symbolColor: string;
}

export function resolveWindowMaterial(
  theme: ThemeMode,
  preset: ThemePreset = 'obsidian',
  glassIntensity: GlassIntensity = 'subtle',
  systemDark = true,
): WindowMaterialConfig {
  const effectiveMode: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const meta = THEME_PRESETS.find((p) => p.id === preset);
  const resolved =
    meta && meta.base === effectiveMode
      ? meta
      : effectiveMode === 'light'
        ? THEME_PRESETS.find((p) => p.id === 'alabaster')!
        : THEME_PRESETS.find((p) => p.id === 'obsidian')!;

  const useAcrylic = glassIntensity !== 'off' && resolved.id !== 'high-contrast';
  return {
    effectiveMode,
    useAcrylic,
    backgroundColor: useAcrylic ? '#00000000' : resolved.canvasBg,
    overlayColor: useAcrylic ? '#00000000' : resolved.sidebarBg,
    symbolColor: resolved.symbolColor,
  };
}
