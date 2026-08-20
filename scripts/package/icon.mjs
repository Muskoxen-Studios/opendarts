/*
 * The app icon, generated from the same geometry the scoreboard draws.
 *
 * Drawn rather than drawn-by-hand so it cannot drift from the board in the
 * app: same segment order, same ring radii, same palette.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build-resources');

const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const MM = { BULL_INNER: 7, BULL_OUTER: 17, TRIPLE_INNER: 97, TRIPLE_OUTER: 107, DOUBLE_INNER: 160, DOUBLE_OUTER: 170 };

const SIZE = 1024;
const C = SIZE / 2;
const R = SIZE * 0.44;
const r = (mm) => (mm / MM.DOUBLE_OUTER) * R;

const WHITE = '#f5f0dc';
const BLACK = '#20242b';
const RED = '#d8453f';
const GREEN = '#3f9d54';

const polar = (radius, deg) => {
  const rad = (deg * Math.PI) / 180;
  return [C + radius * Math.cos(rad), C + radius * Math.sin(rad)];
};

function band(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
}

const parts = [
  `<rect width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.18}" fill="#0c0e12"/>`,
  `<circle cx="${C}" cy="${C}" r="${R * 1.06}" fill="#15181d"/>`,
];

ORDER.forEach((_, i) => {
  const centre = -90 + i * 18;
  const a0 = centre - 9;
  const a1 = centre + 9;
  const dark = i % 2 === 1;
  const rings = [
    [r(MM.DOUBLE_INNER), r(MM.DOUBLE_OUTER), dark ? RED : GREEN],
    [r(MM.TRIPLE_OUTER), r(MM.DOUBLE_INNER), dark ? BLACK : WHITE],
    [r(MM.TRIPLE_INNER), r(MM.TRIPLE_OUTER), dark ? RED : GREEN],
    [r(MM.BULL_OUTER), r(MM.TRIPLE_INNER), dark ? BLACK : WHITE],
  ];
  for (const [r0, r1, fill] of rings) {
    parts.push(`<path d="${band(r0, r1, a0, a1)}" fill="${fill}" stroke="#0c0e12" stroke-width="2"/>`);
  }
});

parts.push(`<circle cx="${C}" cy="${C}" r="${r(MM.BULL_OUTER)}" fill="${GREEN}" stroke="#0c0e12" stroke-width="2"/>`);
parts.push(`<circle cx="${C}" cy="${C}" r="${r(MM.BULL_INNER)}" fill="${RED}" stroke="#0c0e12" stroke-width="2"/>`);

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${parts.join('')}</svg>\n`,
);
console.log(`wrote ${join(OUT, 'icon.svg')}`);
console.log('now: rsvg-convert -w 1024 -h 1024 build-resources/icon.svg -o build-resources/icon.png');
