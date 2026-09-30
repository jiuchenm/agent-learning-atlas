export const THEME_KEY = 'agent-learning-atlas.theme';

export function resolveTheme(saved, prefersDark) {
  return saved === 'light' || saved === 'dark' ? saved : prefersDark ? 'dark' : 'light';
}

export function oppositeTheme(theme) {
  return theme === 'dark' ? 'light' : 'dark';
}
