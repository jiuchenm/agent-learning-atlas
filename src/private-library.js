import {marked} from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import {protectMath} from './markdown-math.js';
import {decryptPrivatePayload,PRIVATE_MAX_BYTES,PRIVATE_UNLOCK_ERROR} from './private-crypto.js';
import {createPrivateDiagramRenderer} from './private-diagrams.js';

// Keep this library separate from the public catalog, notes and article cache.
const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function erase(payload) {
  if (!payload) return;
  for (const lesson of payload.lessons) for (const key of Object.keys(lesson)) lesson[key]=null;
  for (const source of payload.sources) for (const key of Object.keys(source)) source[key]=null;
  payload.lessons.length=0; payload.sources.length=0;
}
async function readEnvelope(response,signal) {
  if (!response.ok || Number(response.headers.get('content-length')) > PRIVATE_MAX_BYTES) throw new Error(PRIVATE_UNLOCK_ERROR);
  if (!response.body?.getReader) {
    const text=await response.text();
    if (new TextEncoder().encode(text).length>PRIVATE_MAX_BYTES||signal.aborted) throw new Error(PRIVATE_UNLOCK_ERROR);
    return JSON.parse(text);
  }
  const reader=response.body.getReader(), chunks=[];
  let size=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (signal.aborted) throw new Error(PRIVATE_UNLOCK_ERROR);
      if (done) break;
      size+=value.byteLength;
      if(size>PRIVATE_MAX_BYTES)throw new Error(PRIVATE_UNLOCK_ERROR);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function mountPrivateLibrary(container,{payloadUrl,renderDiagrams,fetcher=globalThis.fetch}={}) {
  const doc=container.ownerDocument, view=doc.defaultView;
  const base = new URL(import.meta.env?.BASE_URL || './',doc.baseURI);
  const url = new URL(payloadUrl || 'private-library.json',base);
  if (url.origin !== new URL(doc.baseURI).origin || !['http:','https:'].includes(url.protocol)) throw new Error('Encrypted content must use the same site origin');
  let payload=null, request=null, epoch=0, disposed=false, diagrams=null;
  function clear() {
    epoch++;request?.abort();request=null;diagrams?.dispose();diagrams=null;erase(payload);payload=null;
    container.replaceChildren();
  }
  function locked(message='') {
    if(disposed)return;
    container.innerHTML='<div class="page-head"><span class="eyebrow">PRIVATE LIBRARY</span><h1>加密资料</h1><p>输入访问密码后，在当前页面中阅读。关闭或刷新页面后需要重新解锁。</p></div><form class="lab-panel" data-private-form autocomplete="off"><label for="private-access-password">访问密码</label><input id="private-access-password" data-private-password type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="1024" required><div class="notes-tools"><button class="button primary" type="submit">解锁</button><button class="button light" type="button" data-private-lock>清除</button></div><p role="status" aria-live="polite" data-private-status>'+esc(message)+'</p></form>';
    const form=container.querySelector('[data-private-form]');
    form.addEventListener('submit',unlock);
    container.querySelector('[data-private-lock]').addEventListener('click',lock);
  }
  function lock() {clear();locked();}
  async function unlock(event) {
    event.preventDefault();
    if(request||disposed)return;
    const input=container.querySelector('[data-private-password]');
    let password=input.value;input.value='';
    if(!password)return;
    const current=++epoch;
    const controller=new AbortController();request=controller;
    const status=container.querySelector('[data-private-status]');status.textContent='正在解锁…';
    container.querySelector('button[type="submit"]').disabled=true;
    let opened=null;
    try {
      const response=await fetcher(url.href,{signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      const envelope=await readEnvelope(response,controller.signal);
      if(current!==epoch||disposed||controller.signal.aborted)return;
      opened=await decryptPrivatePayload(envelope,password);
      password=null;
      if(current!==epoch||disposed||controller.signal.aborted){erase(opened);opened=null;return;}
      payload=opened;opened=null;request=null;
      show(payload.lessons[0].id);
    } catch {
      erase(opened);
      if(current===epoch&&!disposed){request=null;erase(payload);payload=null;locked(PRIVATE_UNLOCK_ERROR);}
    } finally { password=null; }
  }
  function secureLinks(prose) {
    for(const link of prose.querySelectorAll('a')) {
      const href=link.getAttribute('href')||'';
      const article=/^#\/lesson\/([a-z0-9-]+)$/.exec(href);
      if(article&&payload.lessons.some(l=>l.id===article[1])) {
        link.setAttribute('href','#/private');
        link.addEventListener('click',event=>{event.preventDefault();show(article[1]);});
      } else if(/^#(?:\/lesson\/[a-z0-9-]+|[a-zA-Z0-9_-]+)$/.test(href)) {
        link.removeAttribute('target');link.removeAttribute('ping');
      } else {
        let parsed;try{parsed=new URL(href);}catch{}
        if(!parsed||parsed.protocol!=='https:'||parsed.username||parsed.password){link.removeAttribute('href');continue;}
        link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');link.removeAttribute('ping');
      }
    }
  }
  function show(id) {
    if(disposed||!payload)return;
    const lesson=payload.lessons.find(l=>l.id===id);if(!lesson)return;
    diagrams?.dispose();diagrams=createPrivateDiagramRenderer();
    container.innerHTML='<div class="article-top"><span>已解锁 · 仅当前页面</span><button class="button light" data-private-lock>锁定资料</button></div><nav class="notes-tools" aria-label="加密资料课程">'+payload.lessons.map(l=>'<button class="button '+(l.id===id?'primary':'light')+'" data-private-lesson="'+esc(l.id)+'" aria-current="'+(l.id===id?'page':'false')+'">'+esc(l.title)+'</button>').join('')+'</nav><div class="article-heading"><h1>'+esc(lesson.title)+'</h1><p>'+esc(lesson.summary)+'</p></div><article class="prose" data-private-prose></article><details class="lab-panel"><summary>本篇来源</summary><ul>'+lesson.sourceIds.map(sourceId=>{
      const source=payload.sources.find(s=>s.id===sourceId);
      return '<li><a href="'+esc(source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(source.title)+'</a>'+(source.limit?'<p>'+esc(source.limit)+'</p>':'')+'</li>';
    }).join('')+'</ul></details>';
    container.querySelector('[data-private-lock]').addEventListener('click',lock);
    for(const button of container.querySelectorAll('[data-private-lesson]'))button.addEventListener('click',()=>show(button.dataset.privateLesson));
    const prose=container.querySelector('[data-private-prose]');
    const {protectedText,equations}=protectMath(lesson.markdown.replace(/^\s*# [^\n]*(?:\r?\n|$)/,''));
    prose.innerHTML=DOMPurify.sanitize(marked.parse(protectedText),{FORBID_TAGS:['style','form','input','textarea','iframe','object','embed','img','svg','math'],FORBID_ATTR:['style','src','srcset','ping']});
    for(const span of prose.querySelectorAll('[data-atlas-math]')) {
      const equation=equations[Number(span.dataset.atlasMath)];
      if(equation)katex.render(equation.tex,span,{displayMode:equation.display,throwOnError:false,trust:false,strict:'warn'});
    }
    secureLinks(prose);
    for(const table of prose.querySelectorAll('table')){const wrap=doc.createElement('div');wrap.className='table-scroll';table.replaceWith(wrap);wrap.append(table);}
    // Private diagrams use restricted syntax and owned temporary DOM nodes.
    diagrams.render(prose).catch(()=>{});
    view?.scrollTo(0,0);
  }
  function dispose(){if(disposed)return;disposed=true;clear();view?.removeEventListener('pagehide',lock);view?.removeEventListener('pageshow',onPageShow);}
  function onPageShow(event){if(event.persisted)lock();}
  view?.addEventListener('pagehide',lock);view?.addEventListener('pageshow',onPageShow);
  locked();
  // Callable cleanup fits the host router; named operations remain available.
  return Object.assign(dispose,{lock,dispose});
}
