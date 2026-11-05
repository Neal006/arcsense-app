/** Dark, high-contrast palette sized for use at arm's length during trials. */
export const colors = {
  bg: '#0B0F14',
  surface: '#141A22',
  surfaceHi: '#1C2430',
  border: '#2A3442',
  text: '#E6EDF3',
  textDim: '#9AA7B4',
  accent: '#4FA3FF',
  ok: '#3FB950',
  warn: '#D29922',
  danger: '#F85149',
  left: '#58A6FF',
  right: '#F0883E',
  normal: '#3FB950',
  freezing: '#F85149',
  shuffling: '#F0883E',
  limping: '#A371F7',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = 10;
export const font = { small: 13, body: 16, title: 20, big: 28 } as const;
