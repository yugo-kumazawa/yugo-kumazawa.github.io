/**
 * 複製の倍率系列。
 *
 * 「1 段目の倍率」「最終段の倍率」「段数」で系列を定義する。
 * 開始値と刻み幅で定義するやり方もあるが、それだと等差と等比で
 * 到達点がずれてしまい、この 2 つを見比べるという本来の目的に合わない。
 * 両端を固定して間の配り方だけを変えるので、差がそのまま分布の差になる。
 */

export const DISTRIBUTIONS = {
  arithmetic: '等差',
  geometric: '等比',
};

/** 等比では 0 や負の倍率を扱えないため、下限を設ける。 */
export const MIN_SCALE = 0.001;

/**
 * 倍率の配列を返す。要素 i は内側から i 番目の複製の倍率。
 * @param {{count:number, start:number, end:number, distribution:'arithmetic'|'geometric'}} opts
 * @returns {number[]}
 */
export function scaleSeries({ count, start, end, distribution }) {
  const n = Math.max(1, Math.floor(count));
  const s = Math.max(MIN_SCALE, start);
  const e = Math.max(MIN_SCALE, end);

  if (n === 1) return [s];

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = distribution === 'geometric'
      ? s * Math.pow(e / s, t)   // 比が一定 … 外へ行くほど間隔が広がる
      : s + (e - s) * t;         // 差が一定 … 等間隔の同心円になる
  }
  return out;
}

/** 段ごとの不透明度。両端を指定して線形に配る。 */
export function opacitySeries({ count, start, end }) {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [start];
  return Array.from({ length: n }, (_, i) => start + (end - start) * (i / (n - 1)));
}
