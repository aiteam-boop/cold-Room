/** @type {import('tailwindcss').Config} */
// Crystal brand kit (crystal-design-system.html): navy #052379, amber #FBC213,
// Manrope (display) / Inter (body) / JetBrains Mono (mono).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand navy — accent tokens from the design system.
        navy: {
          DEFAULT: '#052379', //  --accent
          50: '#EAF0FB',       //  --accent-soft   (light tint bg)
          100: '#DCE5F7',      //  --accent-soft-2
          700: '#031A5C',      //  --accent-hover
          900: '#02123F',      //  --accent-press
        },
        // Brand amber accent (#FBC213). Tailwind's own `amber-*` scale stays for
        // semantic warning/pending states; `gold` is the pure brand accent.
        gold: {
          DEFAULT: '#FBC213',
          600: '#E8B30C',
          700: '#D2A20A',
          soft: '#FFF6DD',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '10px',
        lg: '14px',
      },
      boxShadow: {
        // Brand shadows are tinted navy (design system --shadow-1..4).
        sm: '0 1px 2px rgba(5,35,121,.06)',
        DEFAULT: '0 2px 8px rgba(5,35,121,.08)',
        md: '0 6px 16px rgba(5,35,121,.12)',
        lg: '0 12px 28px rgba(5,35,121,.16)',
      },
    },
  },
  plugins: [],
};
