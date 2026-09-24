// Fails the build if the shipped bundle contains dynamic-code or HTML-injection sinks (CLAUDE.md rules 2-3,
// SECURITY T8), inline scripts/styles in HTML, or runtime references to third-party origins (T20).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const JS_SINKS = [
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function('],
  [/\.innerHTML\s*=/, 'innerHTML ='],
  [/\.outerHTML\s*=/, 'outerHTML ='],
  [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML('],
  [/document\.write(ln)?\s*\(/, 'document.write('],
  [/setTimeout\s*\(\s*['"`]/, 'setTimeout(string)'],
  [/setInterval\s*\(\s*['"`]/, 'setInterval(string)'],
];
const HTML_RULES = [
  [/<script(?![^>]*\bsrc=)[^>]*>/i, 'inline <script>'],
  [/<style\b/i, 'inline <style>'],
  [/\sstyle\s*=/i, 'style= attribute'],
  [/\son[a-z]+\s*=/i, 'inline event handler'],
  [/(src|href)\s*=\s*["']?(https?:)?\/\//i, 'third-party src/href'],
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems = [];
for (const file of walk(DIST)) {
  const text = readFileSync(file, 'utf8');
  const rules = file.endsWith('.js') ? JS_SINKS : file.endsWith('.html') ? HTML_RULES : [];
  for (const [re, label] of rules) {
    if (re.test(text)) problems.push(`${file}: ${label}`);
  }
}

if (problems.length) {
  console.error('check-bundle: forbidden patterns found\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('check-bundle: ok');
