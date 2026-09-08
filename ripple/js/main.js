/**
 * 画面まわりの配線。設定の読み取り → 生成 → プレビュー反映。
 */

import { loadSvgSource } from './svg-source.js';
import { compose, stripPaint } from './compose.js';
import { exportSvg, exportPng, safeName } from './exporter.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'ripple.settings.v1';

const DEFAULT_STOPS = ['#e08a80', '#6b74d8', '#b6c0dc', '#dfa96a'];

/**
 * 数値項目の既定値。入力を消している最中に 0 として読まれて
 * 図が潰れてしまわないよう、空欄のあいだはここへ退避する。
 */
const DEFAULTS = {
  count: 12,
  scaleStart: 0.12,
  scaleEnd: 1,
  rotationStep: 8,
  angleMin: -15,
  angleMax: 15,
  angleSeed: 1,
  originX: 0.5,
  originY: 0.5,
  strokeWidth: 2,
  opacityStart: 1,
  opacityEnd: 1,
  padding: 4,
  zoom: 130,
  outputWidth: 1200,
  aspectW: 3,
  aspectH: 2,
  pngScale: 2,
};

/** プレビューの見え方。生成結果そのものとは別に持つ。 */
const view = { zoom: 1, panX: 0, panY: 0 };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 重ねる図形。内側の段から順にこの並びを繰り返す。 */
let sources = [];       // { key, name, sampleName, group, viewBox, thumb }
let nextSourceKey = 0;
let stops = [...DEFAULT_STOPS];
let latest = null;      // 直近の compose 結果
let frameAtDragStart = null;

// ---------------------------------------------------------------- 設定

/** 数値項目を読む。空欄や読めない値のときは既定値に落とす。 */
function num(id) {
  const raw = $(id)?.value.trim() ?? '';
  if (raw === '') return DEFAULTS[id];
  const v = Number(raw);
  return Number.isFinite(v) ? v : DEFAULTS[id];
}

function currentAspect() {
  const preset = $('aspectPreset').value;
  if (preset === 'auto') return null;
  if (preset === 'custom') {
    const w = Math.max(1, num('aspectW'));
    const h = Math.max(1, num('aspectH'));
    return w / h;
  }
  return Number(preset);
}

function readSettings() {
  const aspect = currentAspect();
  return {
    count: num('count'),
    scaleStart: num('scaleStart'),
    scaleEnd: num('scaleEnd'),
    distribution: radio('distribution'),
    rotationStep: num('rotationStep'),
    randomizeAngle: $('randomizeAngle').checked,
    angleMin: num('angleMin'),
    angleMax: num('angleMax'),
    angleSeed: Math.max(0, Math.round(num('angleSeed'))),

    originX: num('originX'),
    originY: num('originY'),

    paintMode: radio('paintMode'),
    strokeWidth: num('strokeWidth'),
    constantStroke: $('constantStroke').checked,

    colorStops: stops,
    colorMode: $('colorMode').value,
    colorSpace: $('colorSpace').value,
    opacityStart: num('opacityStart'),
    opacityEnd: num('opacityEnd'),

    order: radio('order'),
    normalizeSizes: $('normalizeSizes').checked,
    padding: num('padding'),

    background: $('background').value,
    transparentBackground: $('transparentBackground').checked,

    clipToFrame: $('clipToFrame').checked,
    frameMode: aspect === null ? 'auto' : 'fixed',
    aspect: aspect ?? 1,
    zoom: num('zoom'),
    frameCenter: radio('frameCenter'),
    outputWidth: num('outputWidth'),
  };
}

function radio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

// ---------------------------------------------------------------- 並べ替え

/** いま掴んでいる行。dragover では dataTransfer を読めないので変数で持つ。 */
let dragging = null;

function moveItem(list, from, to) {
  if (to < 0 || to >= list.length || from === to) return false;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return true;
}

function clearDropMarks() {
  for (const el of document.querySelectorAll('.is-drop-before, .is-drop-after')) {
    el.classList.remove('is-drop-before', 'is-drop-after');
  }
}

/**
 * 行を掴んで並べ替えられるようにする。
 *
 * draggable にするのは取っ手を押している間だけ。行ごと常時 draggable にすると、
 * 中の入力欄で文字を選ぶだけでドラッグが始まってしまう。
 * 取っ手は button なので、上下キーでも動かせる。
 */
function attachReorder({ row, handle, index, list, onMove }) {
  handle.addEventListener('pointerdown', () => { row.draggable = true; });
  handle.addEventListener('pointerup', () => { row.draggable = false; });
  handle.addEventListener('keydown', (e) => {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    onMove(index, index + delta);
  });

  row.addEventListener('dragstart', (e) => {
    dragging = { list, index };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index)); // 中身が空だと始まらない環境がある
    row.classList.add('is-dragging');
  });

  row.addEventListener('dragend', () => {
    row.draggable = false;
    dragging = null;
    row.classList.remove('is-dragging');
    clearDropMarks();
  });

  row.addEventListener('dragover', (e) => {
    if (dragging?.list !== list || dragging.index === index) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    row.classList.add(dragging.index < index ? 'is-drop-after' : 'is-drop-before');
  });

  row.addEventListener('drop', (e) => {
    if (dragging?.list !== list) return;
    e.preventDefault();
    const from = dragging.index;
    clearDropMarks();
    onMove(from, index);
  });
}

function dragHandle(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'handle';
  btn.title = `${label}（ドラッグ、または上下キーで並べ替え）`;
  btn.setAttribute('aria-label', btn.title);
  return btn;
}

// ---------------------------------------------------------------- 色の停止

function renderStops() {
  const host = $('stops');
  host.textContent = '';

  stops.forEach((hex, i) => {
    const row = document.createElement('div');
    row.className = 'stop';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = hex;
    picker.setAttribute('aria-label', `色 ${i + 1}`);
    picker.addEventListener('input', () => {
      stops[i] = picker.value;
      text.value = picker.value;
      schedule();
    });

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'stop__hex';
    text.value = hex;
    text.spellcheck = false;
    text.setAttribute('aria-label', `色 ${i + 1} の値`);
    text.addEventListener('change', () => {
      const v = text.value.trim();
      if (/^#?[0-9a-f]{3}$|^#?[0-9a-f]{6}$/i.test(v)) {
        const normalized = v.startsWith('#') ? v : `#${v}`;
        stops[i] = normalized;
        picker.value = normalized.length === 4
          ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
          : normalized;
        schedule();
      } else {
        text.value = stops[i];
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'stop__remove';
    remove.textContent = '×';
    remove.title = 'この色を削除';
    remove.disabled = stops.length <= 1;
    remove.addEventListener('click', () => {
      stops.splice(i, 1);
      renderStops();
      schedule();
    });

    const handle = dragHandle(`色 ${i + 1}`);
    row.append(handle, picker, text, remove);
    attachReorder({
      row,
      handle,
      index: i,
      list: 'stops',
      onMove: (from, to) => {
        if (!moveItem(stops, from, to)) return;
        renderStops();
        schedule();
      },
    });

    host.appendChild(row);
  });
}

// ---------------------------------------------------------------- 図形の読み込み

function setNotice(message, isError = false) {
  const notice = $('notice');
  if (!message) {
    notice.hidden = true;
    return;
  }
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle('notice--error', isError);
}

/**
 * 一覧に出す見本。data URI の <img> にして、本体とは別の文書に閉じ込める。
 * DOM に直に差すと、図形が持つ clipPath などの ID が二重になり、
 * url(#…) の参照先が取り違えられる恐れがある。
 */
function buildThumb(group, viewBox) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);

  const clone = group.cloneNode(true);
  stripPaint(clone);
  clone.setAttribute('fill', '#5b6270');
  svg.appendChild(clone);

  const xml = new XMLSerializer().serializeToString(svg);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

/** 読み込んで一覧の末尾に足す。読めなければ投げる。 */
function addSource(text, name, sampleName) {
  const loaded = loadSvgSource(text);
  sources.push({
    key: `s${nextSourceKey++}`,
    name,
    sampleName,
    group: loaded.group,
    viewBox: loaded.viewBox,
    thumb: buildThumb(loaded.group, loaded.viewBox),
  });
  return loaded.warnings;
}

function afterSourcesChanged({ warnings = [], error = '' } = {}) {
  renderSourceList();
  markSampleChips();
  setNotice(error || warnings.join(' '), Boolean(error));
  resetView();
  render();
}

async function sampleText(name) {
  // 単一ファイル版ではサンプルが埋め込まれている。無ければ取りに行く。
  const inline = globalThis.RIPPLE_SAMPLES?.[name];
  if (inline !== undefined) return inline;

  const res = await fetch(`samples/${name}.svg`);
  if (!res.ok) {
    throw new Error(
      `サンプルを取得できませんでした（${res.status}）。` +
      'ローカルで開いている場合は、簡易サーバー経由で表示してください。'
    );
  }
  return res.text();
}

function sampleLabel(name) {
  return document.querySelector(`[data-sample="${name}"]`)?.textContent?.trim() ?? name;
}

/** サンプルの札は入り切りの切り替え。押すたびに足したり外したりする。 */
async function toggleSample(name) {
  const at = sources.findIndex((src) => src.sampleName === name);
  if (at !== -1) {
    if (sources.length <= 1) {
      setNotice('図形をすべて外すことはできません。', true);
      return;
    }
    sources.splice(at, 1);
    afterSourcesChanged();
    return;
  }
  try {
    const warnings = addSource(await sampleText(name), sampleLabel(name), name);
    afterSourcesChanged({ warnings });
  } catch (err) {
    setNotice(err.message, true);
  }
}

async function readFiles(list) {
  const files = [...(list ?? [])]
    .filter((f) => /svg/i.test(f.type) || /\.svg$/i.test(f.name));

  if (files.length === 0) {
    setNotice('SVG ファイルを指定してください。', true);
    return;
  }

  const warnings = [];
  const failed = [];
  for (const file of files) {
    try {
      warnings.push(...addSource(await file.text(), file.name));
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  afterSourcesChanged({ warnings, error: failed.join(' / ') });
}

function moveSource(from, delta) {
  if (moveItem(sources, from, from + delta)) afterSourcesChanged();
}

function removeSource(at) {
  if (sources.length <= 1) return;
  sources.splice(at, 1);
  afterSourcesChanged();
}

function renderSourceList() {
  const host = $('sources');
  host.textContent = '';

  sources.forEach((src, i) => {
    const row = document.createElement('li');
    row.className = 'source';

    // 番号札がそのまま取っ手。何番目に重なるかを示しつつ掴める。
    const order = dragHandle(src.name);
    order.classList.add('source__order');
    order.textContent = String(i + 1);

    const thumb = document.createElement('img');
    thumb.className = 'source__thumb';
    thumb.src = src.thumb;
    thumb.alt = '';

    const name = document.createElement('span');
    name.className = 'source__name';
    name.textContent = src.name;
    name.title = src.name;

    row.append(order, thumb, name,
      iconButton('↑', '上へ', i === 0, () => moveSource(i, -1)),
      iconButton('↓', '下へ', i === sources.length - 1, () => moveSource(i, 1)),
      iconButton('×', '取り除く', sources.length <= 1, () => removeSource(i)));

    attachReorder({
      row,
      handle: order,
      index: i,
      list: 'sources',
      onMove: (from, to) => {
        if (moveItem(sources, from, to)) afterSourcesChanged();
      },
    });

    host.appendChild(row);
  });

  $('cycleHint').textContent = sources.length > 1
    ? `内側から ${sources.map((s) => s.name).join(' → ')} の順に繰り返す。`
    : '';
}

function iconButton(glyph, title, disabled, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'source__btn';
  btn.textContent = glyph;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function markSampleChips() {
  const used = new Set(sources.map((src) => src.sampleName).filter(Boolean));
  for (const chip of document.querySelectorAll('[data-sample]')) {
    chip.classList.toggle('is-active', used.has(chip.dataset.sample));
    chip.setAttribute('aria-pressed', String(used.has(chip.dataset.sample)));
  }
}

/** 書き出しのファイル名。図形が複数のときは先頭の名前を使う。 */
function exportBaseName() {
  return sources[0]?.name ?? 'ripple';
}

// ---------------------------------------------------------------- 描画

function showError(message) {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.add('notice--error');
}

let pending = false;

function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function render() {
  if (sources.length === 0) return;

  syncOutputs();
  const settings = readSettings();
  latest = compose(sources, settings);

  const canvas = $('canvas');
  canvas.textContent = '';
  canvas.appendChild(latest.svg);

  layout();
  saveSettings();
}

/** プレビュー領域に収まる大きさへ整えて、ズームと移動を反映する。 */
function layout() {
  if (!latest) return;

  const viewEl = $('view');
  const canvas = $('canvas');
  const svg = latest.svg;

  const rect = viewEl.getBoundingClientRect();
  const pad = 48;
  const availW = Math.max(80, rect.width - pad);
  const availH = Math.max(80, rect.height - pad);
  const ratio = latest.frame.w / latest.frame.h;

  let w = availW;
  let h = w / ratio;
  if (h > availH) {
    h = availH;
    w = h * ratio;
  }
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;

  canvas.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;

  placeOriginHandle();
  updateInfo();
}

function placeOriginHandle() {
  const handle = $('originHandle');
  if (!latest || !$('showOrigin').checked) {
    handle.hidden = true;
    return;
  }
  const viewEl = $('view');
  const svgRect = latest.svg.getBoundingClientRect();
  const viewRect = viewEl.getBoundingClientRect();
  const { frame, origin } = latest;

  const x = svgRect.left - viewRect.left + ((origin.x - frame.x) / frame.w) * svgRect.width;
  const y = svgRect.top - viewRect.top + ((origin.y - frame.y) / frame.h) * svgRect.height;

  handle.hidden = false;
  handle.style.left = `${x}px`;
  handle.style.top = `${y}px`;
}

function updateInfo() {
  if (!latest) return;
  const w = Math.round(Number(latest.svg.getAttribute('width')));
  const h = Math.round(Number(latest.svg.getAttribute('height')));
  const first = latest.scales[0];
  const last = latest.scales[latest.scales.length - 1];

  $('stageInfo').textContent =
    `${w} × ${h} px ・ ${latest.scales.length} 段 ・ 倍率 ${first.toFixed(3)} → ${last.toFixed(3)}`;

  const mult = num('pngScale');
  $('pngSize').textContent = `書き出しサイズ ${Math.round(w * mult)} × ${Math.round(h * mult)} px`;
}

/** スライダーの位置合わせと、状況に応じた項目の出し入れ。 */
function syncOutputs() {
  syncRanges();

  $('distHint').textContent = radio('distribution') === 'geometric'
    ? '段の比が一定。外へ行くほど間隔が広がる。'
    : '段の差が一定。等間隔の同心円になる。';

  const paint = radio('paintMode');
  $('strokeField').hidden = paint === 'fill' || paint === 'original';
  $('colorField').hidden = paint === 'original';
  $('colorModeField').hidden = paint === 'original';

  $('angleRandomField').hidden = !$('randomizeAngle').checked;

  const isAuto = $('aspectPreset').value === 'auto';
  $('customAspectField').hidden = $('aspectPreset').value !== 'custom';
  $('zoomField').hidden = isAuto;
  $('frameCenterField').hidden = isAuto;
  $('outputWidth').disabled = isAuto;
}

/**
 * 数値入力とスライダーの対応づけ。
 *
 * 正となる値は数値入力のほうが持つ。スライダーは掴んで動かすための
 * 補助で、こちらのほうが範囲が狭い。数値に範囲外の値を入れても
 * 捨てずに保ち、スライダーだけが端で止まる。
 */
function pairedRanges() {
  return [...document.querySelectorAll('input[type="range"][id$="Range"]')]
    .map((range) => ({ range, number: $(range.id.slice(0, -'Range'.length)) }))
    .filter((pair) => pair.number);
}

function syncRanges() {
  for (const { range, number } of pairedRanges()) {
    const v = Number(number.value);
    if (!Number.isFinite(v)) continue;
    const min = Number(range.min);
    const max = Number(range.max);
    range.value = String(Math.min(max, Math.max(min, v)));
  }
}

function setupRangePairs() {
  for (const { range, number } of pairedRanges()) {
    range.addEventListener('input', () => {
      number.value = range.value;
    });
  }
}

// ---------------------------------------------------------------- 表示操作

function resetView() {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  layout();
}

function setupViewGestures() {
  const viewEl = $('view');

  viewEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = viewEl.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    // ポインタの下にある点を動かさないように、拡大前後で平行移動を調整する
    const px = e.clientX - rect.left - cx;
    const py = e.clientY - rect.top - cy;
    const ux = (px - view.panX) / view.zoom;
    const uy = (py - view.panY) / view.zoom;

    const next = Math.min(12, Math.max(0.2, view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    view.zoom = next;
    view.panX = px - ux * next;
    view.panY = py - uy * next;
    layout();
  }, { passive: false });

  let panning = null;
  viewEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.origin-handle')) return;
    panning = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
    viewEl.setPointerCapture(e.pointerId);
    viewEl.classList.add('is-panning');
  });
  viewEl.addEventListener('pointermove', (e) => {
    if (!panning) return;
    view.panX = panning.panX + (e.clientX - panning.x);
    view.panY = panning.panY + (e.clientY - panning.y);
    layout();
  });
  const endPan = () => {
    panning = null;
    viewEl.classList.remove('is-panning');
  };
  viewEl.addEventListener('pointerup', endPan);
  viewEl.addEventListener('pointercancel', endPan);
}

function setupOriginDrag() {
  const handle = $('originHandle');
  let drag = null;

  handle.addEventListener('pointerdown', (e) => {
    if (!latest || sources.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // フレームの中心を原点に合わせていると、動かすたびに枠まで動いて追いにくい。
    // 掴んだ瞬間のフレームを基準にして、ポインタの移動量だけを見る。
    frameAtDragStart = { ...latest.frame, rect: latest.svg.getBoundingClientRect() };
    drag = {
      x: e.clientX,
      y: e.clientY,
      originX: num('originX'),
      originY: num('originY'),
    };
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!drag || sources.length === 0) return;
    const f = frameAtDragStart;
    // 画面上の移動量 → ユーザー座標 → viewBox に対する割合
    const perPxX = f.w / f.rect.width;
    const perPxY = f.h / f.rect.height;
    const dx = (e.clientX - drag.x) * perPxX / sources[0].viewBox.w;
    const dy = (e.clientY - drag.y) * perPxY / sources[0].viewBox.h;

    $('originX').value = (drag.originX + dx).toFixed(3);
    $('originY').value = (drag.originY + dy).toFixed(3);
    markAnchorPreset();
    schedule();
  });

  const end = () => { drag = null; frameAtDragStart = null; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function markAnchorPreset() {
  const x = num('originX');
  const y = num('originY');
  for (const btn of document.querySelectorAll('[data-anchor]')) {
    const [ax, ay] = btn.dataset.anchor.split(',').map(Number);
    btn.classList.toggle('is-active', Math.abs(ax - x) < 0.001 && Math.abs(ay - y) < 0.001);
  }
}

// ---------------------------------------------------------------- 保存と復元

function saveSettings() {
  try {
    const s = readSettings();
    delete s.colorStops;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...s,
      stops,
      aspectPreset: $('aspectPreset').value,
      pngScale: num('pngScale'),
      aspectW: num('aspectW'),
      aspectH: num('aspectH'),
      // 読み込んだファイルは持ち越せないので、サンプルの選択だけを覚えておく
      samples: sources.map((src) => src.sampleName).filter(Boolean),
    }));
  } catch {
    // 保存できなくても動作に支障はないので黙って続ける
  }
}

function restoreSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved) return;

  const setValue = (id, value) => {
    if (value === undefined || value === null) return;
    const el = $(id);
    if (el) el.value = value;
  };
  const setChecked = (id, value) => {
    const el = $(id);
    if (el && typeof value === 'boolean') el.checked = value;
  };
  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };

  setValue('count', saved.count);
  setValue('pngScale', saved.pngScale);
  setValue('aspectW', saved.aspectW);
  setValue('aspectH', saved.aspectH);
  setValue('scaleStart', saved.scaleStart);
  setValue('scaleEnd', saved.scaleEnd);
  setValue('rotationStep', saved.rotationStep);
  setValue('angleMin', saved.angleMin);
  setValue('angleMax', saved.angleMax);
  setValue('angleSeed', saved.angleSeed);
  setValue('originX', saved.originX);
  setValue('originY', saved.originY);
  setValue('strokeWidth', saved.strokeWidth);
  setValue('colorMode', saved.colorMode);
  setValue('colorSpace', saved.colorSpace);
  setValue('opacityStart', saved.opacityStart);
  setValue('opacityEnd', saved.opacityEnd);
  setValue('padding', saved.padding);
  setValue('background', saved.background);
  setValue('aspectPreset', saved.aspectPreset);
  setValue('zoom', saved.zoom);
  setValue('outputWidth', saved.outputWidth);
  setChecked('constantStroke', saved.constantStroke);
  setChecked('normalizeSizes', saved.normalizeSizes);
  setChecked('randomizeAngle', saved.randomizeAngle);
  setChecked('clipToFrame', saved.clipToFrame);
  setChecked('transparentBackground', saved.transparentBackground);
  setRadio('distribution', saved.distribution);
  setRadio('paintMode', saved.paintMode);
  setRadio('order', saved.order);
  setRadio('frameCenter', saved.frameCenter);

  if (Array.isArray(saved.stops) && saved.stops.length > 0) stops = [...saved.stops];
}

// ---------------------------------------------------------------- 起動

function setupInputs() {
  const panel = $('panel');
  panel.addEventListener('input', (e) => {
    if (e.target.closest('.stop')) return; // 色の行は個別に処理済み
    schedule();
  });
  panel.addEventListener('change', (e) => {
    if (e.target.closest('.stop')) return;
    schedule();
  });

  for (const btn of document.querySelectorAll('[data-anchor]')) {
    btn.addEventListener('click', () => {
      const [x, y] = btn.dataset.anchor.split(',');
      $('originX').value = x;
      $('originY').value = y;
      markAnchorPreset();
      schedule();
    });
  }

  for (const btn of document.querySelectorAll('[data-sample]')) {
    btn.addEventListener('click', () => toggleSample(btn.dataset.sample));
  }

  $('reroll').addEventListener('click', () => {
    $('angleSeed').value = String(Math.floor(Math.random() * 1_000_000));
    schedule();
  });

  $('addStop').addEventListener('click', () => {
    stops.push(stops[stops.length - 1] ?? '#888888');
    renderStops();
    schedule();
  });

  $('file').addEventListener('change', (e) => {
    readFiles(e.target.files);
    e.target.value = ''; // 同じファイルをもう一度選べるようにする
  });

  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('file').click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    });
  }
  drop.addEventListener('drop', (e) => readFiles(e.dataTransfer?.files));

  $('fit').addEventListener('click', resetView);
  $('showOrigin').addEventListener('change', placeOriginHandle);

  $('exportSvg').addEventListener('click', async () => {
    if (!latest) return;
    const btn = $('exportSvg');
    btn.disabled = true;
    try {
      await exportSvg(latest.svg, safeName(exportBaseName(), 'svg'));
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('exportPng').addEventListener('click', async () => {
    if (!latest) return;
    const btn = $('exportPng');
    btn.disabled = true;
    try {
      await exportPng(latest.svg, safeName(exportBaseName(), 'png'), num('pngScale'));
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('reset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  window.addEventListener('resize', layout);
}

/** 起動時の図形。前回のサンプル選択があれば復元する。 */
async function initSources() {
  let wanted = ['burst'];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(saved?.samples) && saved.samples.length > 0) wanted = saved.samples;
  } catch {
    // 読めなければ既定のまま
  }

  const warnings = [];
  for (const name of wanted) {
    try {
      warnings.push(...addSource(await sampleText(name), sampleLabel(name), name));
    } catch (err) {
      setNotice(err.message, true);
    }
  }
  if (sources.length > 0) afterSourcesChanged({ warnings });
}

restoreSettings();
renderStops();
markAnchorPreset();
setupRangePairs();
setupInputs();
setupViewGestures();
setupOriginDrag();
initSources();
