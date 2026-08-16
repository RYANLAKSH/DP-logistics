/**
 * Palette tuned for outdoor daylight readability: high contrast, saturated
 * pass/fail colours that survive glare and are distinguishable with the most
 * common forms of colour blindness (the verdict never relies on hue alone —
 * it is always paired with a word and an icon).
 */
export const theme = {
  bg: '#0f1720',
  surface: '#1b2530',
  text: '#f2f5f8',
  muted: '#93a1b0',
  border: '#33414f',
  accent: '#2f6fed',

  pass: '#22c55e',
  passBg: '#08351c',
  block: '#ef4444',
  blockBg: '#3d1113',
  warnText: '#fbbf24',
  warnBg: '#3a2c07',
} as const;
