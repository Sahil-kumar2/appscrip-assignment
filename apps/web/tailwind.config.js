/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        'surface-raised': 'var(--surface-raised)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        hairline: 'var(--hairline)',
        'hairline-subtle': 'var(--hairline-subtle)',
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          soft: 'var(--brand-soft)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
        },
        status: {
          healthy: 'var(--healthy)',
          'healthy-bg': 'var(--healthy-bg)',
          stale: 'var(--stale)',
          'stale-bg': 'var(--stale-bg)',
          critical: 'var(--critical)',
          'critical-bg': 'var(--critical-bg)',
          warning: 'var(--warning)',
          'warning-bg': 'var(--warning-bg)',
          acknowledged: 'var(--acknowledged)',
          'acknowledged-bg': 'var(--acknowledged-bg)',
          resolved: 'var(--resolved)',
          'resolved-bg': 'var(--resolved-bg)',
        },
      },
      fontFamily: {
        heading: [
          '"Space Grotesk"',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],
        sans: [
          '"IBM Plex Sans"',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: {
        control: '6px',
        panel: '8px',
      },
    },
  },
  plugins: [],
};
