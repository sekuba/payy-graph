/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    fontFamily: {
      sans: ['system-ui', 'sans-serif'],
      mono: ['ui-monospace', 'Menlo', 'Consolas', 'monospace'],
    },
  },
  plugins: [],
}
