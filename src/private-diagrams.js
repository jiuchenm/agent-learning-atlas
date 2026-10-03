import DOMPurify from 'dompurify';

// Plain flowcharts only: no Mermaid configuration, URLs, HTML or image shapes.
export function isPrivateFlowchart(text){
 if(typeof text!=='string'||text.length>16000)return false;
 const lines=text.trim().split(/\r?\n/);
 if(!/^flowchart (TD|TB|LR|RL|BT)$/.test(lines.shift()?.trim()||''))return false;
 return lines.every(line=>{
  line=line.trim();if(!line)return true;
  if(!/^[\p{L}\p{N}\s_\[\]{}()\-\.>|：:，,、；;？?+]+$/u.test(line))return false;
  return !/https?:|url:|img:|image|click|style|classDef|linkStyle|subgraph|config|callback/i.test(line);
 });
}
export function createPrivateDiagramRenderer(){
 let disposed=false,seq=0;const temps=new Set();
 async function render(prose){
  for(const code of [...prose.querySelectorAll('pre code.language-mermaid')]){
   if(disposed||!prose.isConnected)return;
   const text=code.textContent;
   if(!isPrivateFlowchart(text)){code.parentElement.setAttribute('aria-label','流程图源码');continue;}
   const temp=prose.ownerDocument.createElement('div');
   temp.setAttribute('data-private-diagram-temp','');temp.style.cssText='position:absolute;left:-100000px;visibility:hidden';
   prose.append(temp);temps.add(temp);
   try{
    const {default:m}=await import('mermaid');if(disposed||!prose.isConnected)return;
    m.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,theme:'neutral',flowchart:{htmlLabels:false},fontFamily:'Segoe UI, Microsoft YaHei, sans-serif'});
    const {svg}=await m.render('private-diagram-'+Date.now()+'-'+seq++,text,temp);
    if(disposed||!prose.isConnected)return;
    const figure=prose.ownerDocument.createElement('figure');figure.className='diagram';figure.setAttribute('aria-label','文章流程图');
    figure.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['image','a','foreignObject','script'],FORBID_ATTR:['href','xlink:href']});
    code.parentElement.replaceWith(figure);
   }catch{if(!disposed&&code.isConnected)code.parentElement.setAttribute('aria-label','流程图源码');}
   finally{temp.remove();temps.delete(temp);}
  }
 }
 function dispose(){disposed=true;for(const temp of temps)temp.remove();temps.clear();}
 return {render,dispose};
}
