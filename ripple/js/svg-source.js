/**
 * 読み込んだ SVG を「複製の素」として使える形に整える。
 *
 * やっていることは 3 つ。
 *  1. 無害化      … script や onload などを落とす
 *  2. ID の付け替え … グラデーションや clipPath の ID が出力側とぶつからないようにする
 *  3. 寸法の確定   … viewBox / width,height / 実測 の順に基準の箱を決める
 *
 * 塗りの除去はここではやらない。「元の色を使う」を切り替えるたびに
 * element を作り直さずに済むよう、素は無加工のまま保ち、
 * 描画のたびに複製した側へ加工をかける（compose.js を参照）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** 中身ごと消す要素。foreignObject は任意の HTML を持ち込めるため落とす。 */
const FORBIDDEN_TAGS = new Set(['script', 'foreignobject', 'animate', 'set']);

/** url(#id) を持ちうる属性。 */
const REF_ATTRS = [
  'fill', 'stroke', 'clip-path', 'mask', 'filter',
  'marker', 'marker-start', 'marker-mid', 'marker-end',
  'style',
];

let idCounter = 0;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** script / イベントハンドラ / javascript: を取り除く。 */
function sanitize(root, warnings) {
  let removedTags = 0;
  let removedAttrs = 0;

  for (const el of [...root.querySelectorAll('*')]) {
    if (FORBIDDEN_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      removedTags++;
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        removedAttrs++;
        continue;
      }
      if ((name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(value)) {
        el.removeAttribute(attr.name);
        removedAttrs++;
      }
    }
  }

  if (removedTags > 0) {
    warnings.push(`スクリプトなど ${removedTags} 個の要素を安全のため取り除きました。`);
  }
  if (removedAttrs > 0) {
    warnings.push(`イベント属性 ${removedAttrs} 個を取り除きました。`);
  }
}

/**
 * 素の中の ID をすべて付け替え、参照も追従させる。
 * 素は 1 つしか出力しない（複製は use で参照する）ので、
 * ここさえ通しておけばグラデーションや clipPath は壊れずに使い回せる。
 */
function namespaceIds(root) {
  const prefix = `rs${idCounter++}-`;
  const map = new Map();

  for (const el of root.querySelectorAll('[id]')) {
    const old = el.getAttribute('id');
    if (!old || map.has(old)) continue;
    map.set(old, prefix + old.replace(/[^\w-]/g, '_'));
  }
  if (map.size === 0) return;

  for (const el of root.querySelectorAll('[id]')) {
    const next = map.get(el.getAttribute('id'));
    if (next) el.setAttribute('id', next);
  }

  for (const el of root.querySelectorAll('*')) {
    // href="#id" は完全一致のときだけ差し替える
    for (const [attr, ns] of [['href', null], ['xlink:href', XLINK_NS]]) {
      const value = ns ? el.getAttributeNS(ns, 'href') : el.getAttribute(attr);
      if (!value || !value.startsWith('#')) continue;
      const next = map.get(value.slice(1));
      if (!next) continue;
      if (ns) el.setAttributeNS(ns, attr, `#${next}`);
      else el.setAttribute(attr, `#${next}`);
    }

    // それ以外は url(#id) の形のときだけ差し替える。
    // 生の "#id" まで置換すると fill="#fff" のような色を壊しかねない。
    for (const attr of REF_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value || !value.includes('url(')) continue;
      el.setAttribute(attr, rewriteUrlRefs(value, map));
    }
  }

  for (const style of root.querySelectorAll('style')) {
    style.textContent = rewriteCssRefs(style.textContent, map);
  }
}

function rewriteUrlRefs(value, map) {
  return value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (whole, quote, id) => {
    const next = map.get(id);
    return next ? `url(${quote}#${next}${quote})` : whole;
  });
}

function rewriteCssRefs(css, map) {
  let out = rewriteUrlRefs(css, map);
  for (const [old, next] of map) {
    // CSS の ID セレクタ。後ろに識別子文字が続かないものだけを対象にする。
    out = out.replace(new RegExp(`#${escapeRegExp(old)}(?![\\w-])`, 'g'), `#${next}`);
  }
  return out;
}

function parseLength(value) {
  if (!value) return null;
  if (value.includes('%')) return null; // 相対値は基準にできない
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseViewBox(value) {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** viewBox も width/height も無い SVG のために、実際に描いて外接矩形を測る。 */
function measureBBox(group) {
  const probe = document.createElementNS(SVG_NS, 'svg');
  probe.setAttribute('width', '0');
  probe.setAttribute('height', '0');
  probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;overflow:hidden';
  const clone = group.cloneNode(true);
  probe.appendChild(clone);
  document.body.appendChild(probe);

  let box = null;
  try {
    const b = clone.getBBox();
    if (b.width > 0 && b.height > 0) {
      box = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
  } catch {
    box = null;
  } finally {
    probe.remove();
  }
  return box;
}

/**
 * SVG のテキストを読み込む。
 * @param {string} text
 * @returns {{group:SVGGElement, viewBox:{x:number,y:number,w:number,h:number}, warnings:string[]}}
 */
export function loadSvgSource(text) {
  const warnings = [];
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('SVG として読み取れませんでした。ファイルが壊れていないか確認してください。');
  }
  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') {
    throw new Error('ルート要素が <svg> ではありません。');
  }

  sanitize(svg, warnings);

  const group = document.createElementNS(SVG_NS, 'g');
  // ルートの <svg> に付いていた見た目の指定は、中身と一緒に引き継ぐ
  for (const attr of ['fill', 'stroke', 'stroke-width', 'fill-rule', 'style', 'opacity']) {
    const v = svg.getAttribute(attr);
    if (v) group.setAttribute(attr, v);
  }
  // 別ドキュメント（DOMParser の結果）からの移動になるので importNode を挟む
  for (const child of [...svg.childNodes]) {
    group.appendChild(document.importNode(child, true));
  }

  namespaceIds(group);

  const viewBox =
    parseViewBox(svg.getAttribute('viewBox')) ??
    boxFromSize(svg) ??
    measureBBox(group);

  if (!viewBox) {
    throw new Error('図形の大きさを判定できませんでした。viewBox 付きの SVG で試してください。');
  }
  if (!svg.getAttribute('viewBox')) {
    warnings.push('viewBox が無いため、大きさを推定しました。原点の位置がずれる場合があります。');
  }

  return { group, viewBox, warnings };
}

function boxFromSize(svg) {
  const w = parseLength(svg.getAttribute('width'));
  const h = parseLength(svg.getAttribute('height'));
  return w && h ? { x: 0, y: 0, w, h } : null;
}
