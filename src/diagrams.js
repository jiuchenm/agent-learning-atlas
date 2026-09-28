let renderer;
export async function renderDiagrams(prose){
 const blocks=[...prose.querySelectorAll('pre code.language-mermaid')];
 if(!blocks.length)return;
 renderer||=import('mermaid').then(({default:m})=>{m.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral',fontFamily:'Segoe UI, Microsoft YaHei, sans-serif'});return m;});
 const m=await renderer;
 for(const [i,code] of blocks.entries()){
  if(!prose.isConnected)return;
  try{
   const {svg}=await m.render('diagram-'+Date.now()+'-'+i,code.textContent);
   if(!prose.isConnected)return;
   const figure=document.createElement('figure');figure.className='diagram';figure.setAttribute('aria-label','文章流程图');figure.innerHTML=svg;code.parentElement.replaceWith(figure);
  }catch{code.parentElement.setAttribute('aria-label','流程图源码');}
 }
}
