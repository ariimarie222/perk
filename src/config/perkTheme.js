export const PERK_THEME = Object.freeze({
  name: 'Perk',
  footer: 'Perk • shop safely, stay cute',
  footerIcon: process.env.PERK_LOGO_URL || null,
  logo: process.env.PERK_LOGO_URL || null,
  colors: Object.freeze({
    general: '#F4A7C1',
    marketplace: '#F39BBD',
    success: '#F7B2CC',
    important: '#E97AA8',
    warning: '#F29A8A',
    error: '#C94F76',
    neutral: '#F8DDE8',
    moderation: '#A83F68',
  }),
  emojis: Object.freeze({
    general: '🌸',
    marketplace: '💗',
    success: '✨',
    important: '💕',
    warning: '🌷',
    error: '⚠️',
    moderation: '🎀',
  }),
});

const COLOR_ALIASES = Object.freeze({
  primary: 'general',
  secondary: 'neutral',
  light: 'neutral',
  gray: 'neutral',
  dark: 'moderation',
  success: 'success',
  green: 'success',
  error: 'error',
  red: 'error',
  warning: 'warning',
  yellow: 'warning',
  info: 'important',
  blurple: 'important',
  fuchsia: 'marketplace',
  marketplace: 'marketplace',
  moderation: 'moderation',
  important: 'important',
  neutral: 'neutral',
  general: 'general',
});

function hexToNumber(hex) {
  return Number.parseInt(hex.slice(1), 16);
}

export function getPerkColor(type = 'general') {
  const key = COLOR_ALIASES[String(type).toLowerCase()] || 'general';
  return PERK_THEME.colors[key];
}

export function normalizePerkColor(input) {
  if (typeof input === 'string' && COLOR_ALIASES[input.toLowerCase()]) {
    return getPerkColor(input);
  }

  if (Array.isArray(input)) return input;
  let number = null;
  if (typeof input === 'number') number = input;
  if (typeof input === 'string' && /^#?[0-9a-f]{6}$/i.test(input)) {
    number = Number.parseInt(input.replace('#', ''), 16);
  }
  if (!Number.isFinite(number)) return input;

  const legacyMap = new Map([
    [0x57F287, 'success'],
    [0x2ECC71, 'success'],
    [0x00FF00, 'success'],
    [0xED4245, 'error'],
    [0xE74C3C, 'error'],
    [0xFF0000, 'error'],
    [0x8B0000, 'moderation'],
    [0xFEE75C, 'warning'],
    [0xF1C40F, 'warning'],
    [0xFFFF00, 'warning'],
    [0xFF6600, 'warning'],
    [0xFAA61A, 'warning'],
    [0xF39C12, 'warning'],
    [0x3498DB, 'important'],
    [0x5865F2, 'important'],
    [0xEB459E, 'marketplace'],
    [0xE91E63, 'marketplace'],
    [0xFF69B4, 'marketplace'],
    [0x9B59B6, 'important'],
    [0x95A5A6, 'neutral'],
    [0xFF6B6B, 'error'],
    [0x51CF66, 'success'],
    [0x74C0FC, 'important'],
    [0xFFD43B, 'warning'],
    [0x000000, 'moderation'],
    [0x202225, 'moderation'],
    [0x2F3136, 'neutral'],
    [0x99AAB5, 'neutral'],
    [0x336699, 'general'],
  ]);
  const mapped = legacyMap.get(number);
  return mapped ? getPerkColor(mapped) : input;
}

export const PERK_COLOR_NUMBERS = Object.freeze(
  Object.fromEntries(Object.entries(PERK_THEME.colors).map(([key, value]) => [key, hexToNumber(value)])),
);
