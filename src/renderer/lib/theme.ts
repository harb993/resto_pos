/**
 * Which set of colours the screens use.
 *
 * A theme is nothing but a block of CSS variables (see index.css), switched by one
 * attribute on the root element. The choice is a matter of the eyes in front of this
 * particular screen, so it is remembered on the machine it was made on rather than in
 * the shop's settings — the till by the fryer and the office PC need not agree.
 */

export type ThemeId = 'calm' | 'classic'

export const THEMES: { id: ThemeId; label: string; hint: string; swatches: string[] }[] = [
  {
    id: 'calm',
    label: 'هادئ',
    hint: 'رمادي فاتح وأزرق هادئ — مريح للعين في الورديات الطويلة',
    swatches: ['#EEF1F3', '#2F6F8F', '#2F7D5B', '#26333D'],
  },
  {
    id: 'classic',
    label: 'الأصلي',
    hint: 'الأحمر والبرتقالي على خلفية كريمي',
    swatches: ['#F4F1EB', '#C41E2E', '#DE8709', '#241D1C'],
  },
]

const KEY = 'crispo-theme'

export function currentTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'classic' || saved === 'calm') return saved
  } catch { /* storage unavailable — the default is fine */ }
  return 'calm'
}

/** Put a theme on the page. `calm` is the stylesheet's own default, so it needs no attribute. */
export function applyTheme(theme: ThemeId): void {
  if (theme === 'calm') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

export function setTheme(theme: ThemeId): void {
  try { localStorage.setItem(KEY, theme) } catch { /* it still applies for this session */ }
  applyTheme(theme)
}
