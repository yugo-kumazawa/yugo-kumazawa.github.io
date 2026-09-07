/**
 * 画面まわりの配線。設定の読み取り → 生成 → プレビュー反映。
 */

import { loadSvgSource } from './svg-source.js';
import { compose } from './compose.js';
import { exportSvg, exportPng, safeName } from './exporter.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'ripple.settings.v1';

const DEFAULT_STOPS = ['#e08a80', '#6b74d8', '#b6c0dc', '#dfa96a'];

/** プレビューの見え方。生成結果そのものとは別に持つ。 */
const view = { zoom: 1, panX: 0, panY: 0 };

let source = null;      // { group, viewBox }
let sourceName = 'ripple';
let stops = [...DEFAULT_STOPS];
let latest = null;      // 直近の compose 結果
let frameAtDragStart = null;

// ---------------------------------------------------------------- 設定

function currentAspect() {
  const preset = $('aspectPreset').value;
  if (preset === 'auto') return null;
  if (preset === 'custom') {
    const w = Math.max(1, Number($('aspectW').value) || 1);
    const h = Math.max(1, Number($('aspectH').value) || 1);
    return w / h;
  }
  return Number(preset);
}

function readSettings() {
  const aspect = currentAspect();
  return {
    count: Number($('count').value),
    scaleStart: Number($('scaleStart').value),
    scaleEnd: Number($('scaleEnd').value),
    distribution: radio('distribution'),
    rotationStep: Number($('rotationStep').value),

    originX: Number($('originX').value),
    originY: Number($('originY').value),

    paintMode: radio('paintMode'),
    strokeWidth: Number($('strokeWidth').value),
    constantStroke: $('constantStroke').checked,

    colorStops: stops,
    colorMode: $('colorMode').value,
    colorSpace: $('colorSpace').value,
    opacityStart: Number($('opacityStart').value),
    opacityEnd: Number($('opacityEnd').value),

    order: radio('order'),
    padding: Number($('padding').value),

    background: $('background').value,
    transparentBackground: $('transparentBackground').checked,

    frameMode: aspect === null ? 'auto' : 'fixed',
    aspect: aspect ?? 1,
    zoom: Number($('zoom').value),
    frameCenter: radio('frameCenter'),
    outputWidth: Number($('outputWidth').value),
  };
}

function radio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
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

    row.append(picker, text, remove);
    host.appendChild(row);
  });
}

// ---------------------------------------------------------------- 素の読み込み

async function useSvgText(text, name) {
  const notice = $('notice');
  try {
    const loaded = loadSvgSource(text);
    source = loaded;
    sourceName = name;
    $('sourceName').textContent = name;

    if (loaded.warnings.length > 0) {
      notice.textContent = loaded.warnings.join(' ');
      notice.hidden = false;
      notice.classList.remove('notice--error');
    } else {
      notice.hidden = true;
    }
    resetView();
    render();
  } catch (err) {
    notice.textContent = err.message;
    notice.hidden = false;
    notice.classList.add('notice--error');
  }
}

async function loadSample(name) {
  try {
    // 単一ファイル版ではサンプルが埋め込まれている。無ければ取りに行く。
    const inline = globalThis.RIPPLE_SAMPLES?.[name];
    let text = inline;
    if (text === undefined) {
      const res = await fetch(`samples/${name}.svg`);
      if (!res.ok) throw new Error(`サンプルを取得できませんでした（${res.status}）。`);
      text = await res.text();
    }
    await useSvgText(text, name);
  } catch (err) {
    const notice = $('notice');
    notice.textContent = `${err.message} ローカルで開いている場合は、簡易サーバー経由で表示してください。`;
    notice.hidden = false;
    notice.classList.add('notice--error');
  }
}

async function readFile(file) {
  if (!file) return;
  if (!/svg/i.test(file.type) && !/\.svg$/i.test(file.name)) {
    const notice = $('notice');
    notice.textContent = 'SVG ファイルを指定してください。';
    notice.hidden = false;
    notice.classList.add('notice--error');
    return;
  }
  await useSvgText(await file.text(), file.name);
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
  if (!source) return;

  syncOutputs();
  const settings = readSettings();
  latest = compose(source, settings);

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

  const mult = Number($('pngScale').value);
  $('pngSize').textContent = `書き出しサイズ ${Math.round(w * mult)} × ${Math.round(h * mult)} px`;
}

/** スライダーの数値表示と、状況に応じた項目の出し入れ。 */
function syncOutputs() {
  $('countOut').value = $('count').value;
  $('rotOut').value = $('rotationStep').value;
  $('strokeOut').value = $('strokeWidth').value;
  $('opStartOut').value = $('opacityStart').value;
  $('opEndOut').value = $('opacityEnd').value;
  $('padOut').value = $('padding').value;
  $('zoomOut').value = $('zoom').value;
  $('pngOut').value = $('pngScale').value;

  $('distHint').textContent = radio('distribution') === 'geometric'
    ? '段の比が一定。外へ行くほど間隔が広がる。'
    : '段の差が一定。等間隔の同心円になる。';

  const paint = radio('paintMode');
  $('strokeField').hidden = paint === 'fill' || paint === 'original';
  $('colorField').hidden = paint === 'original';
  $('colorModeField').hidden = paint === 'original';

  const isAuto = $('aspectPreset').value === 'auto';
  $('customAspectField').hidden = $('aspectPreset').value !== 'custom';
  $('zoomField').hidden = isAuto;
  $('frameCenterField').hidden = isAuto;
  $('outputWidth').disabled = isAuto;
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
    if (!latest || !source) return;
    e.preventDefault();
    e.stopPropagation();
    // フレームの中心を原点に合わせていると、動かすたびに枠まで動いて追いにくい。
    // 掴んだ瞬間のフレームを基準にして、ポインタの移動量だけを見る。
    frameAtDragStart = { ...latest.frame, rect: latest.svg.getBoundingClientRect() };
    drag = {
      x: e.clientX,
      y: e.clientY,
      originX: Number($('originX').value),
      originY: Number($('originY').value),
    };
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!drag || !source) return;
    const f = frameAtDragStart;
    // 画面上の移動量 → ユーザー座標 → viewBox に対する割合
    const perPxX = f.w / f.rect.width;
    const perPxY = f.h / f.rect.height;
    const dx = (e.clientX - drag.x) * perPxX / source.viewBox.w;
    const dy = (e.clientY - drag.y) * perPxY / source.viewBox.h;

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
  const x = Number($('originX').value);
  const y = Number($('originY').value);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, stops, aspectPreset: $('aspectPreset').value }));
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
  setValue('scaleStart', saved.scaleStart);
  setValue('scaleEnd', saved.scaleEnd);
  setValue('rotationStep', saved.rotationStep);
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
    btn.addEventListener('click', () => loadSample(btn.dataset.sample));
  }

  $('addStop').addEventListener('click', () => {
    stops.push(stops[stops.length - 1] ?? '#888888');
    renderStops();
    schedule();
  });

  $('file').addEventListener('change', (e) => readFile(e.target.files[0]));

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
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer?.files?.[0]));

  $('fit').addEventListener('click', resetView);
  $('showOrigin').addEventListener('change', placeOriginHandle);

  $('exportSvg').addEventListener('click', async () => {
    if (!latest) return;
    const btn = $('exportSvg');
    btn.disabled = true;
    try {
      await exportSvg(latest.svg, safeName(sourceName, 'svg'));
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
      await exportPng(latest.svg, safeName(sourceName, 'png'), Number($('pngScale').value));
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

restoreSettings();
renderStops();
markAnchorPreset();
setupInputs();
setupViewGestures();
setupOriginDrag();
loadSample('burst');
