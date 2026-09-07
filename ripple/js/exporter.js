/**
 * 書き出し。SVG はそのまま、PNG は一度画像に通してからキャンバスへ描く。
 */

import { serialize } from './compose.js';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // click 直後に revoke するとダウンロードが始まらない場合があるので少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportSvg(svg, filename) {
  const blob = new Blob([serialize(svg)], { type: 'image/svg+xml;charset=utf-8' });
  download(blob, filename);
}

/**
 * @param {SVGSVGElement} svg
 * @param {number} scale 出力倍率。1 なら SVG の座標値がそのまま px になる。
 */
export async function exportPng(svg, filename, scale = 2) {
  const source = serialize(svg);
  const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const image = await loadImage(url);
    const width = Math.max(1, Math.round(parseFloat(svg.getAttribute('width')) * scale));
    const height = Math.max(1, Math.round(parseFloat(svg.getAttribute('height')) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG に変換できませんでした。'))), 'image/png');
    });
    download(blob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG を画像として読み込めませんでした。'));
    img.src = url;
  });
}

/** ファイル名に使えない文字を落とす。 */
export function safeName(base, ext) {
  const cleaned = (base || 'ripple').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${cleaned}-${stamp}.${ext}`;
}
