import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        gold: {
          DEFAULT: '#f59e0b',
          light: '#fbbf24',
          dark: '#d97706',
          dim: '#78350f',
        },
        navy: {
          950: '#060b18',
          900: '#0a1128',
          800: '#0d1424',
          700: '#131c30',
          600: '#1a2540',
          500: '#243352',
        },
        slate: {
          750: '#253044',
        },
      },
      fontFamily: {
        display: ['Outfit', 'system-ui', 'sans-serif'],
        body: ['DM Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      backgroundImage: {
        'grid-pattern': 'radial-gradient(circle, #1e293b 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid': '24px 24px',
      },
      // Tailwind 4 renamed these scale steps; keep the existing portal appearance.
      backdropBlur: { sm: '4px' },
      boxShadow: { sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)' },
    },
  },
  plugins: [],
};
export default config;
