export function selectLessons(lessons, stage='all', query='') {
  const q=query.trim().toLocaleLowerCase();
  return lessons.filter(l=>(stage==='all'||l.stage===stage||(stage==='internal'&&l.internal)||(stage==='agent'&&!l.internal&&!['model','research'].includes(l.stage)))&&[l.title,l.summary,l.scope,l.anchor,l.topic].join(' ').toLocaleLowerCase().includes(q)).sort((a,b)=>a.order-b.order);
}
export function neighbors(lessons,id){
  const lesson=lessons.find(l=>l.id===id);
  if(!lesson)return {};
  const list=selectLessons(lessons,lesson.stage),i=list.findIndex(l=>l.id===id);
  return {previous:list[i-1],next:list[i+1]};
}
export const noteIds=(current,archive)=>[...new Set([...current,...archive].map(l=>l.id))];
