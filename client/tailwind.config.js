/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#0f2942',
          50: '#f1f5f9',
          700: '#1e3a5f',
          900: '#0f2942',
        },
      },
    },
  },
  plugins: [],
};
