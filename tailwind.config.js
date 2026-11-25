/** Tailwind is compiled once into public/styles.css (npm run build:css). The app itself needs no build step. */
module.exports = {
  content: ['./public/index.html', './public/app.js'],
  theme: { extend: { colors: { navy: '#0b3d91', brand: '#1769e0', ink: '#0b1f3a', mut: '#566a85', line: '#d3e0f0', soft: '#e3eefc', ok: '#0d7a4a', bad: '#a61b1b', amber: '#e39b12' }, fontFamily: { sans: ['"Public Sans"', 'system-ui', 'sans-serif'], display: ['Sora', '"Public Sans"', 'system-ui', 'sans-serif'] } } },
  plugins: []
};
