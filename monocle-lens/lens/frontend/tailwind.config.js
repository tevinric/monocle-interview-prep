/** @type {import('tailwindcss').Config} */
// The Monocle brand system, taken from monoclesolutions.com rather than approximated:
// the corporate red is #E82B2B, the type is Montserrat, and the teals are #75C9D6 /
// #268599. CLAUDE.md §13 was written before the real values were to hand; these
// supersede it. Token *names* are unchanged, so the whole interface retones at once.
//
// Three type layers:
//   `sans`  Montserrat     — the interface: nav, labels, tables, figures. The brand face.
//   `serif` Source Serif 4 — the reading surface: questions, answers, quoted regulation.
//   `mono`  Share Tech Mono — hashes, prompts, JSON. Also drawn from the Monocle site.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#112232', deep: '#0A1724', rule: '#24374A', soft: '#1B2E42' },
        // `dark` is Monocle's #268599 nudged to #22788A: the original lands at
        // 4.29:1 on white, and every use of it is small text — eyebrows, links.
        teal: { DEFAULT: '#75C9D6', dark: '#22788A', deep: '#1A5F6E', tint: '#E8F6F8' },
        // `red` is the corporate red exactly, and stays that way: it is the mark,
        // the diagonal and the large graphic accents, where contrast minimums do
        // not apply. `redInk` is the same red darkened until small text on white
        // — and white text on it — clear 4.5:1. Never use `red` for either.
        brand: { red: '#E82B2B', redInk: '#D41F1F', redDeep: '#BE1A1A', redTint: '#FDF0F0' },
        // Two muted greys because no single one passes on both surfaces: #767676
        // clears 4.5:1 on paper, #9AA6AE clears it on the navy rail.
        slate2: { DEFAULT: '#5C5C5C', light: '#767676', onDark: '#9AA6AE' },
        ok: '#31AE6B',
        paper: { DEFAULT: '#FFFFFF', tint: '#F4F7F9', soft: '#FAFCFD' },
        line: { DEFAULT: '#E6EBEF', strong: '#C9D3DA' },
        retrieval: '#7FA8B8',
      },
      fontFamily: {
        sans: ['Montserrat', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'Cambria', 'serif'],
        mono: ['"Share Tech Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontWeight: { light: '300', normal: '400', medium: '500', semibold: '600' },
      fontSize: {
        meta: ['11.5px', '17px'],
        table: ['12.5px', '19px'],
        body: ['14px', '22px'],
        quote: ['15.5px', '27px'],
        read: ['16.5px', '30px'],
        lead: ['18.5px', '31px'],
        section: ['19px', '28px'],
        headline: ['26px', '34px'],
        title: ['34px', '42px'],
        display: ['44px', '52px'],
        json: ['12.5px', '20px'],
      },
      borderRadius: { DEFAULT: '6px', sm: '4px', md: '8px', lg: '12px', xl: '16px' },
      boxShadow: {
        card: '0 1px 2px rgba(17, 34, 50, 0.04), 0 12px 32px -20px rgba(17, 34, 50, 0.26)',
        lift: '0 2px 6px rgba(17, 34, 50, 0.06), 0 22px 48px -22px rgba(17, 34, 50, 0.30)',
        rail: '-28px 0 70px -34px rgba(10, 23, 36, 0.45)',
        composer: '0 1px 2px rgba(17, 34, 50, 0.05), 0 18px 40px -24px rgba(17, 34, 50, 0.35)',
        glow: '0 0 0 1px rgba(38, 133, 153, 0.18), 0 0 28px -6px rgba(117, 201, 214, 0.45)',
      },
      letterSpacing: { eyebrow: '0.16em', brand: '0.02em' },
      spacing: { gutter: '32px', nav: '248px' },
      maxWidth: { measure: '70ch' },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
        spring: 'cubic-bezier(0.34, 1.32, 0.48, 1)',
      },
      keyframes: {
        'rise-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shimmer: { from: { backgroundPosition: '-180% 0' }, to: { backgroundPosition: '180% 0' } },
      },
      animation: {
        'rise-in': 'rise-in 380ms cubic-bezier(0.22, 0.61, 0.36, 1) both',
        'fade-in': 'fade-in 260ms cubic-bezier(0.22, 0.61, 0.36, 1) both',
      },
    },
  },
  plugins: [],
}
