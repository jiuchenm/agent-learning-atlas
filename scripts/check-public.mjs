import {readFileSync, readdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const restricted = /sharepoint\.com|dev\.azure\.com|visualstudio\.com|M365-Incubation|ai-microsoft|substrate.office|sydney.bing|miaonathan|C:[\\/]Users[\\/]|C:[\\/]M365|confidential|WorkIQ|EntityServe|SkDS|3SQuery/i;
export function assertPublicText(text, label) {
  if (restricted.test(text)) throw new Error('Restricted reference in ' + label);
}
export function checkPublic(root, includeDist = false) {
  const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const catalog = read('content/catalog.json');
  const curriculum = read('content/curriculum.json');
  const sources = read('content/sources.json');
  const ids = new Set(read('content/public-lessons.json'));
  const sourceIds = new Set(sources.map(s => s.id));
  if (catalog.length !== ids.size || catalog.some(l => !ids.has(l.id) || l.internal)) throw new Error('Public lesson allowlist mismatch');
  if (read('content/archive-catalog.json').length) throw new Error('Archives require separate publication review');
  if (curriculum.lessons.length !== ids.size || curriculum.lessons.some(l => !ids.has(l.id))) throw new Error('Curriculum mismatch');
  for (const l of catalog) {
    if (l.prerequisites.some(id => !ids.has(id)) || l.sourceIds.some(id => !sourceIds.has(id))) throw new Error('Unresolved dependency: ' + l.id);
    const md = readFileSync(join(root, 'content/lessons', l.id + '.md'), 'utf8');
    assertPublicText(md, l.id);
    for (const m of md.matchAll(/#\/lesson\/([a-z0-9-]+)/g)) if (!ids.has(m[1])) throw new Error('Missing public article: ' + m[1]);
  }
  for (const name of readdirSync(join(root, 'content/lessons'))) if (!ids.has(name.replace(/\.md$/, ''))) throw new Error('Unlisted article: ' + name);
  for (const source of sources) {
    assertPublicText(JSON.stringify(source), source.id);
    if (new URL(source.url).protocol !== 'https:') throw new Error('Expected HTTPS source');
  }
  if (includeDist) {
    const walk = dir => { for (const item of readdirSync(dir, {withFileTypes:true})) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (/\.(js|json|html|css|md|map|txt)$/.test(path)) assertPublicText(readFileSync(path, 'utf8'), path);
    }};
    walk(join(root, 'dist'));
  }
  console.log(`Public content OK: ${ids.size} lessons, ${curriculum.stages.length} stages${includeDist ? ', bundle checked' : ''}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkPublic(process.cwd(), process.argv.includes('--dist'));
