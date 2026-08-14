/**
 * The three colour operations the mini-games borrow from Qt.
 *
 * The desktop games are painted with QColor.lighter(n) / darker(n) and
 * per-shape alpha. Both have exact definitions worth matching rather than
 * approximating, since the two builds are meant to look like the same room:
 * Qt scales the HSV **value** by n/100 (lighter) or divides by it (darker),
 * leaving hue and saturation alone. Doing it in RGB instead -- mixing toward
 * white -- desaturates as it lightens, which turned the gold star pale and
 * the teal bubble grey.
 */

function hexToRgb(hex) {
  const s = String(hex).replace("#", "").trim();
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsv({ r, g, b }) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToCss({ h, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg < 0 ? seg + 6 : seg];
  const to = (n) => Math.round(Math.min(255, Math.max(0, (n + m) * 255)));
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

function scaleValue(hex, factor) {
  const hsv = rgbToHsv(hexToRgb(hex));
  hsv.v = Math.min(1, Math.max(0, hsv.v * factor));
  return hsvToCss(hsv);
}

/** QColor.lighter(pct): value * pct/100, hue and saturation untouched. */
export function lighten(hex, pct = 150) {
  return scaleValue(hex, pct / 100);
}

/** QColor.darker(pct): value / (pct/100). */
export function darken(hex, pct = 200) {
  return scaleValue(hex, 100 / pct);
}

/** `hex` at `alpha` (0..1), as a canvas fill/stroke string. Accepts the
 * rgb(...) strings lighten/darken return, so effects can be layered on an
 * already-adjusted colour. */
export function rgba(colour, alpha) {
  const a = Math.min(1, Math.max(0, alpha));
  const s = String(colour);
  if (s.startsWith("rgb(")) return s.replace("rgb(", "rgba(").replace(")", `, ${a})`);
  if (s.startsWith("rgba(")) return s.replace(/,[^,]*\)$/, `, ${a})`);
  const { r, g, b } = hexToRgb(s);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
