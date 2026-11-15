
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],

  theme: {
    extend: {
      colors: {
        // shadcn theme compatibility
        background: '#030303',
        foreground: '#ffffff',
        border: '#2a302c',
        input: '#2a302c',
        ring: '#4ade80',

        // ClipFinder original color palette
        ink: '#030303',
        panel: '#0e1113',
        surface: '#1b1f1d',
        line: '#2a302c',

        green: {
          DEFAULT: '#22c55e',
          dark: '#16a34a',
          text: '#4ade80',
        },
      },

      boxShadow: {
        glow: '0 0 40px rgba(34, 197, 94, 0.10)',
      },

      fontFamily: {
        sans: [
          'Ubuntu',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
    },
  },

  plugins: [],
};
