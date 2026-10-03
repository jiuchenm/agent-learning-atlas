import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkPublic} from '../scripts/check-public.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('private UI never joins public notes or stores passwords and host disposes on navigation',()=>{
 const ui=read('src/private-library.js'),main=read('src/main.js');
 assert.doesNotMatch(ui,/localStorage|sessionStorage|sendBeacon/);
 assert.match(main,/privateViewCleanup\?\.dispose\(\)/);
 assert.match(main,/mountPrivateLibrary\(document\.querySelector\('#main'\)/);
 assert.match(ui,/input\.value=''/);
});
test('public checker refuses a fake encrypted container even with no public lessons',()=>{
 const root=mkdtempSync(join(tmpdir(),'atlas-encrypted-boundary-'));mkdirSync(join(root,'content/lessons'),{recursive:true});mkdirSync(join(root,'public'));
 for(const [path,value]of [['catalog.json',[]],['curriculum.json',{lessons:[],stages:[]}],['sources.json',[]],['public-lessons.json',[]],['archive-catalog.json',[]]])writeFileSync(join(root,'content',path),JSON.stringify(value));
 writeFileSync(join(root,'public/private-library.json'),JSON.stringify({version:1,plaintext:'must never be accepted'}));
 assert.throws(()=>checkPublic(root),/无法解锁/);
});
