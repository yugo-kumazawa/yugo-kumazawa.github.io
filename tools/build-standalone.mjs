/**
 * ripple/ の中身を 1 枚の HTML にまとめる。
 *
 * ES モジュールをそのまま結合するので、import / export の行を落として
 * 素の並びに戻す。モジュールごとの局所名がぶつかると静かに壊れるため、
 * 重複した宣言は検出して、内容が完全に同じものだけを 1 つに畳む。
 *
 *   node tools/build-standalone.mjs
 *     dist/ripple.html          単体で開ける HTML
 *     dist/ripple-fragment.html 外側の枠を持たない断片（埋め込み用）
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

// 依存順。上のものから先に評価される。
const MODULES = ['color.js', 'series.js', 'svg-source.js', 'compose.js', 'exporter.js', 'main.js'];

const IMPORT_LINE = /^import\s[\s\S]*?;\s*$/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm;
const TOP_DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function bundleScripts() {
  const seen = new Map();   // 名前 -> { module, text }
  const parts = [];

  for (const name of MODULES) {
    let src = read('ripple', 'js', name);

    // どの名前が外に出るかを、import/export を外す前に拾っておく
    const declared = [...src.matchAll(TOP_DECL)].map((m) => m[1]);

    src = src.replace(IMPORT_LINE, '').replace(EXPORT_KEYWORD, '');

    for (const decl of declared) {
      const line = lineOf(src, decl);
      const prev = seen.get(decl);
      if (!prev) {
        seen.set(decl, { module: name, text: line });
        continue;
      }
      if (prev.text !== line) {
        throw new Error(
          `名前が衝突しています: ${decl}（${prev.module} と ${name}）。` +
          'どちらかを改名してください。'
        );
      }
      // 完全に同じ宣言なので、後から来たほうを落とす
      src = src.replace(line, `/* ${decl} は ${prev.module} で宣言済み */`);
    }
    parts.push(`// ==== ${name} ${'='.repeat(Math.max(0, 60 - name.length))}\n${src.trim()}`);
  }
  return parts.join('\n\n');
}

/** その名前を宣言している行を、丸ごと取り出す。 */
function lineOf(src, name) {
  const re = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b.*$`, 'm');
  return src.match(re)?.[0] ?? '';
}

function inlineSamples() {
  const dir = join(root, 'ripple', 'samples');
  const map = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
    map[basename(file, '.svg')] = readFileSync(join(dir, file), 'utf8');
  }
  return `globalThis.RIPPLE_SAMPLES = ${JSON.stringify(map, null, 2)};`;
}

const html = read('ripple', 'index.html');
// 埋め込み先では短い名前のほうが収まりがよいので、差し替えられるようにしておく
const titleFlag = process.argv.indexOf('--title');
const title = titleFlag !== -1
  ? process.argv[titleFlag + 1]
  : html.match(/<title>([\s\S]*?)<\/title>/)[1];
const body = html
  .slice(html.indexOf('<div class="app">'), html.lastIndexOf('</div>') + 6)
  .trim();

const css = [read('assets', 'css', 'base.css'), read('ripple', 'css', 'app.css')].join('\n\n');
const js = `${inlineSamples()}\n\n${bundleScripts()}`;

// script の閉じタグが文字列の中に現れると HTML が途中で切れる
const safeJs = js.replace(/<\/script>/gi, '<\\/script>');

const fragment = `<title>${title}</title>
<style>
${css}
</style>

${body}

<script type="module">
${safeJs}
</script>
`;

const standalone = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${fragment.slice(0, fragment.indexOf('</style>') + 8)}
</head>
<body>
${fragment.slice(fragment.indexOf('</style>') + 8).trim()}
</body>
</html>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'ripple.html'), standalone);
writeFileSync(join(root, 'dist', 'ripple-fragment.html'), fragment);

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
console.log(`dist/ripple.html          ${kb(standalone)}`);
console.log(`dist/ripple-fragment.html ${kb(fragment)}`);
