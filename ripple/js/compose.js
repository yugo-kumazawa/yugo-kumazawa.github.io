/**
 * 設定から出力用の SVG を組み立てる。
 *
 * 素は defs の中に 1 つだけ置き、各段は <use> で参照する。
 * 段数を増やしても中身は増えないので、100 段でも出力は軽いままで、
 * 書き出した SVG を後から編集するときも 1 か所直せば全段に効く。
 */

import { scaleSeries, opacitySeries } from './series.js';
import { buildColors } from './color.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const UNIT_ID = 'ripple-unit';

/** vector-effect は継承されないので、図形要素に直接付ける必要がある。 */
const SHAPE_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'textpath',
]);

/** fill: / stroke: の宣言だけを消す。stroke-width や fill-rule は残す。 */
const PAINT_DECL = /\b(fill|stroke)\s*:\s*[^;}]*;?/gi;

const round = (n) => Math.round(n * 1000) / 1000;
const DEG = Math.PI / 180;

/**
 * 素の複製から、元々の塗り指定を取り除く。
 * これをやっておくと <use> 側に置いた fill / stroke が中まで継承される。
 */
function stripPaint(root) {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    el.removeAttribute('fill');
    el.removeAttribute('stroke');
    el.removeAttribute('stroke-width');

    const style = el.getAttribute('style');
    if (style) {
      const next = style.replace(PAINT_DECL, '').trim();
      if (next) el.setAttribute('style', next);
      else el.removeAttribute('style');
    }
  }
  // Illustrator 書き出しなどは <style> のクラスで色を持たせてくるので、そこも外す
  for (const styleEl of root.querySelectorAll('style')) {
    styleEl.textContent = styleEl.textContent.replace(PAINT_DECL, '');
  }
}

function applyNonScalingStroke(root) {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (SHAPE_TAGS.has(el.tagName.toLowerCase())) {
      el.setAttribute('vector-effect', 'non-scaling-stroke');
    }
  }
}

/**
 * 各段の外接矩形を合わせた全体の箱（概算）。
 * 4 隅を変換して包むだけなので、回転が入ると実際の図形よりかなり大きく出る。
 * 実測できなかったときの控えとしてのみ使う。
 */
function unionBounds(viewBox, transforms) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const corners = [
    [viewBox.x, viewBox.y],
    [viewBox.x + viewBox.w, viewBox.y],
    [viewBox.x, viewBox.y + viewBox.h],
    [viewBox.x + viewBox.w, viewBox.y + viewBox.h],
  ];

  for (const t of transforms) {
    for (const [px, py] of corners) {
      const { x, y } = applyTransform(t, px, py);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 描いた結果から実際の外接矩形を測る。
 * viewBox の箱を回して包む概算だと、星形のように角の尖った図形で
 * 余白が大きく出てしまい、フレームのトリミングが効かなくなる。
 * 一度だけ画面外に置いて getBBox で取るほうが素直で正確。
 */
function measureLayer(svg, layer) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden';
  host.appendChild(svg);
  document.body.appendChild(host);

  let box = null;
  try {
    const b = layer.getBBox();
    if (b.width > 0 && b.height > 0) {
      box = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
  } catch {
    box = null;
  } finally {
    host.remove();
  }
  return box;
}

/** 原点まわりに回してから拡大する変換。 */
function applyTransform({ ox, oy, scale, angle }, px, py) {
  const dx = px - ox;
  const dy = py - oy;
  const cos = Math.cos(angle * DEG);
  const sin = Math.sin(angle * DEG);
  return {
    x: ox + scale * (dx * cos - dy * sin),
    y: oy + scale * (dx * sin + dy * cos),
  };
}

/**
 * 表示するフレーム（出力の viewBox）を決める。
 *
 * 'auto'  … 全段がちょうど収まる箱に余白を足す
 * 'fixed' … 指定した縦横比の箱にする。ズームを上げると外側がフレームから
 *           はみ出して切り落とされ、いちばん外の段が背景のように働く。
 */
function computeFrame(bounds, origin, settings) {
  const { frameMode, aspect, zoom, frameCenter, padding } = settings;

  if (frameMode !== 'fixed') {
    const pad = (Math.max(bounds.w, bounds.h) * padding) / 100;
    return { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  }

  const cx = frameCenter === 'origin' ? origin.x : bounds.x + bounds.w / 2;
  const cy = frameCenter === 'origin' ? origin.y : bounds.y + bounds.h / 2;

  // 中心を動かさずに全段を包む最小の箱（指定の縦横比で）
  const hx = Math.max(Math.abs(bounds.x - cx), Math.abs(bounds.x + bounds.w - cx));
  const hy = Math.max(Math.abs(bounds.y - cy), Math.abs(bounds.y + bounds.h - cy));

  let w = Math.max(hx * 2, hy * 2 * aspect);
  w *= 1 + padding / 50;

  const z = Math.max(zoom, 1) / 100;
  w /= z;
  const h = w / aspect;

  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * @param {{group:SVGGElement, viewBox:object}} source
 * @param {object} settings
 */
export function compose(source, settings) {
  const {
    count, scaleStart, scaleEnd, distribution, rotationStep,
    originX, originY,
    paintMode, strokeWidth, constantStroke,
    colorStops, colorMode, colorSpace,
    opacityStart, opacityEnd,
    order,
    background, transparentBackground,
    frameMode, outputWidth, aspect,
  } = settings;

  const vb = source.viewBox;
  const scales = scaleSeries({ count, start: scaleStart, end: scaleEnd, distribution });
  const colors = buildColors(colorStops, scales.length, colorMode, colorSpace);
  const opacities = opacitySeries({ count: scales.length, start: opacityStart, end: opacityEnd });

  // 原点は viewBox に対する割合で持つ。素を差し替えても同じ位置を指すようにするため。
  const ox = vb.x + originX * vb.w;
  const oy = vb.y + originY * vb.h;
  const origin = { x: ox, y: oy };

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);

  const unit = source.group.cloneNode(true);
  unit.setAttribute('id', UNIT_ID);
  if (paintMode !== 'original') stripPaint(unit);
  if (constantStroke) applyNonScalingStroke(unit);

  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.appendChild(unit);
  svg.appendChild(defs);

  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('id', 'ripple-copies');

  // 段の並びと描画順は別物。色と倍率の対応は保ったまま、重なりの前後だけ入れ替える。
  const indices = scales.map((_, i) => i);
  indices.sort((a, b) => (order === 'outer-first' ? scales[b] - scales[a] : scales[a] - scales[b]));

  for (const i of indices) {
    const s = scales[i];
    const angle = i * rotationStep;
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${UNIT_ID}`);
    // SVG 1.1 しか解さない読み手（Illustrator など）は xlink:href しか見ない。
    // 両方書いておかないと、そうしたアプリでは中身が空のまま開く。
    use.setAttributeNS(XLINK_NS, 'xlink:href', `#${UNIT_ID}`);

    // 原点を動かさずに回して拡大するので、原点へ寄せて変換して戻す
    const parts = [`translate(${round(ox)} ${round(oy)})`];
    if (angle % 360 !== 0) parts.push(`rotate(${round(angle)})`);
    parts.push(`scale(${round(s)})`, `translate(${round(-ox)} ${round(-oy)})`);
    use.setAttribute('transform', parts.join(' '));

    if (paintMode !== 'original') {
      const color = colors[i];
      if (paintMode === 'fill') {
        use.setAttribute('fill', color);
        use.setAttribute('stroke', 'none');
      } else if (paintMode === 'stroke') {
        use.setAttribute('fill', 'none');
        use.setAttribute('stroke', color);
        use.setAttribute('stroke-width', round(strokeWidth));
      } else {
        use.setAttribute('fill', color);
        use.setAttribute('stroke', color);
        use.setAttribute('stroke-width', round(strokeWidth));
      }
    }

    const op = opacities[i];
    if (op < 1) use.setAttribute('opacity', round(op));

    layer.appendChild(use);
  }
  svg.appendChild(layer);

  // 枠を決めるには全段の実寸が要るので、先に組み立ててから測る。
  const transforms = scales.map((scale, i) => ({ ox, oy, scale, angle: i * rotationStep }));
  let bounds = measureLayer(svg, layer) ?? unionBounds(vb, transforms);

  // getBBox は線幅を含まないので、線を塗るときは半分だけ広げておく
  if (paintMode === 'stroke' || paintMode === 'both') {
    const half = strokeWidth / 2;
    bounds = { x: bounds.x - half, y: bounds.y - half, w: bounds.w + half * 2, h: bounds.h + half * 2 };
  }

  const frame = computeFrame(bounds, origin, settings);
  svg.setAttribute('viewBox', `${round(frame.x)} ${round(frame.y)} ${round(frame.w)} ${round(frame.h)}`);

  if (frameMode === 'fixed') {
    svg.setAttribute('width', Math.round(outputWidth));
    svg.setAttribute('height', Math.round(outputWidth / aspect));
  } else {
    svg.setAttribute('width', round(frame.w));
    svg.setAttribute('height', round(frame.h));
  }

  if (!transparentBackground) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', round(frame.x));
    rect.setAttribute('y', round(frame.y));
    rect.setAttribute('width', round(frame.w));
    rect.setAttribute('height', round(frame.h));
    rect.setAttribute('fill', background);
    svg.insertBefore(rect, svg.firstChild);
  }

  return { svg, frame, bounds, scales, colors, origin };
}

/** 出力 SVG を単体のファイルとして通用する文字列にする。 */
export function serialize(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', XLINK_NS);

  // プレビューは画面に収めるため style で寸法を上書きしている。
  // それが残ると width / height 属性より強く効いてしまうので、外に出す前に落とす。
  clone.style.removeProperty('width');
  clone.style.removeProperty('height');
  if (!clone.getAttribute('style')) clone.removeAttribute('style');

  const xml = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
}
