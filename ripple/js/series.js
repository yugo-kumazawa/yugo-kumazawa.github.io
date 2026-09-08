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

/**
 * 種から決まる疑似乱数。Mulberry32。
 *
 * Math.random では、他の項目をいじるたびに角度が振り直されてしまい、
 * 気に入った崩れ方を保ったまま段数や色を詰める、という作業ができない。
 * 種を明示的に持たせて、同じ種なら同じ結果になるようにしている。
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 段ごとの角度。基準は「1 段ごとに step を足す」で、
 * ランダムを入れた場合はその上に min〜max の範囲の角度を重ねる。
 *
 * @param {{count:number, step:number, randomize:boolean,
 *          min:number, max:number, seed:number}} opts
 * @returns {number[]}
 */
export function angleSeries({ count, step, randomize, min, max, seed }) {
  const n = Math.max(1, Math.floor(count));
  const rand = randomize ? mulberry32(seed) : null;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    // 乱数は必ず段の順に引く。順序が変わると同じ種でも結果が変わってしまう。
    out[i] = i * step + (rand ? lo + rand() * (hi - lo) : 0);
  }
  return out;
}

/** 段ごとの不透明度。両端を指定して線形に配る。 */
export function opacitySeries({ count, start, end }) {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [start];
  return Array.from({ length: n }, (_, i) => start + (end - start) * (i / (n - 1)));
}
