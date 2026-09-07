/**
 * 色の解析・補間・整形。
 *
 * 補間は OKLab を既定とする。sRGB の直線補間は中間色が濁りやすく、
 * 段数の多い波紋グラフィックでは帯が汚れて見えるため。
 * どうしても sRGB のランプに合わせたい場合のために 'srgb' も残してある。
 */

const HEX3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** '#rgb' / '#rrggbb' を {r,g,b}（各 0-255）にする。解析できなければ null。 */
export function parseHex(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = s.match(HEX6);
  if (m) {
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }
  m = s.match(HEX3);
  if (m) {
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
    };
  }
  return null;
}

/** {r,g,b}（0-255、小数可）を '#rrggbb' にする。 */
export function toHex({ r, g, b }) {
  const ch = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// --- sRGB <-> OKLab -------------------------------------------------------
// Björn Ottosson の OKLab による。sRGB のガンマを外してから線形変換する。

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(c * 255, 0, 255);
}

function rgbToOklab({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** 2 色を t（0-1）で混ぜる。space は 'oklab' か 'srgb'。 */
export function mix(c1, c2, t, space = 'oklab') {
  if (space === 'srgb') {
    return {
      r: c1.r + (c2.r - c1.r) * t,
      g: c1.g + (c2.g - c1.g) * t,
      b: c1.b + (c2.b - c1.b) * t,
    };
  }
  const a = rgbToOklab(c1);
  const b = rgbToOklab(c2);
  return oklabToRgb({
    L: a.L + (b.L - a.L) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/**
 * 色停止のリストを 1 本のランプとみなし、位置 t（0-1）の色を取り出す。
 * 停止は等間隔に置かれているものとして扱う。
 */
export function sampleRamp(stops, t, space = 'oklab') {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 };
  if (stops.length === 1) return { ...stops[0] };

  const pos = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  return mix(stops[i], stops[i + 1], pos - i, space);
}

/**
 * 段数ぶんの色を作る。
 * mode 'ramp'  … 停止色を補間して端から端へ渡す
 * mode 'cycle' … 停止色をそのまま順番に繰り返す
 */
export function buildColors(stops, count, mode = 'ramp', space = 'oklab') {
  const palette = stops.map(parseHex).filter(Boolean);
  if (palette.length === 0) return Array.from({ length: count }, () => '#000000');

  const out = [];
  for (let i = 0; i < count; i++) {
    if (mode === 'cycle') {
      out.push(toHex(palette[i % palette.length]));
    } else {
      const t = count === 1 ? 0 : i / (count - 1);
      out.push(toHex(sampleRamp(palette, t, space)));
    }
  }
  return out;
}
