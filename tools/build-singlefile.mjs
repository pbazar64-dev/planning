// Сборка единого самодостаточного index.html без сборщика и зависимостей.
// Инлайнит все ES-модули (убирая import/export) в один <script> и CSS в <style>.
// Запуск: node tools/build-singlefile.mjs  ->  dist/index.html

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(resolve(root, p), 'utf8');

// Порядок важен из-за вычислений на верхнем уровне модулей
// (например, calendar.js использует GRID, state.js — startOfWeek).
const MODULE_ORDER = [
  'js/config.js',
  'js/dates.js',
  'js/state.js',
  'js/bus.js',
  'js/b24.js',
  'js/data.js',
  'js/ui/toast.js',
  'js/ui/tooltip.js',
  'js/ui/modals.js',
  'js/ui/calendar.js',
  'js/ui/employees.js',
  'js/app.js',
];

// Убирает import-инструкции (в т.ч. многострочные) и ключевое слово export.
function stripModuleSyntax(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Пропускаем import-инструкцию целиком (до строки с ';').
    if (trimmed.startsWith('import ') || trimmed === 'import {') {
      while (i < lines.length && !lines[i].includes(';')) i++;
      continue;
    }
    // Реэкспорт вида `export { ... };` — выкидываем целиком.
    if (trimmed.startsWith('export {')) {
      while (i < lines.length && !lines[i].includes(';')) i++;
      continue;
    }
    // `export const/function/class/...` -> снимаем префикс export.
    out.push(lines[i].replace(/^(\s*)export\s+/, '$1'));
  }
  return out.join('\n');
}

const banner = '/* Сгенерировано tools/build-singlefile.mjs — правьте исходники в js/, не этот файл. */';
const jsParts = MODULE_ORDER.map((p) => `\n// ===== ${p} =====\n` + stripModuleSyntax(r(p)));
const bundle =
  '(function () {\n' + banner + '\n' + jsParts.join('\n') + '\n})();';

const css = r('css/styles.css');

let html = r('index.html');
// Инлайним CSS вместо <link>.
html = html.replace(
  /<link rel="stylesheet" href="css\/styles\.css">/,
  `<style>\n${css}\n</style>`
);
// Заменяем модульный <script src> на инлайн-бандл.
html = html.replace(
  /<script type="module" src="js\/app\.js"><\/script>/,
  `<script>\n${bundle}\n</script>`
);

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), html);
console.log('OK -> dist/index.html (' + html.length + ' байт)');
