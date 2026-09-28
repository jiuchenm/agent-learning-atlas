export const VERSION = 1;
export const emptyState = () => ({version: VERSION, lessons: {}, lastLesson: null});
export function validateState(value, ids) {
  if (!value || value.version !== VERSION || !value.lessons || typeof value.lessons !== 'object' || Array.isArray(value.lessons)) throw new Error('请选择本网站导出的 v1 笔记 JSON。');
  const result = emptyState();
  for (const [id, entry] of Object.entries(value.lessons)) {
    if (!ids.includes(id)) continue;
    if (!entry || !['unread','review','understood'].includes(entry.status) || typeof entry.note !== 'string' || entry.note.length > 30000 || !Number.isFinite(entry.updated)) throw new Error('笔记数据格式不正确，未导入。');
    result.lessons[id] = {status: entry.status, note: entry.note, updated: entry.updated};
  }
  result.lastLesson = ids.includes(value.lastLesson) ? value.lastLesson : null;
  return result;
}
export function mergeState(current, incoming) {
  const result = structuredClone(current);
  for (const [id, entry] of Object.entries(incoming.lessons)) if (!result.lessons[id] || entry.updated > result.lessons[id].updated) result.lessons[id] = entry;
  return result;
}
export function kvBytes({batch,layers,tokens,heads,dim,bytes}) {
  return batch*layers*tokens*2*heads*dim*bytes;
}
export function advantages(rewards) {
  if (!rewards.length || rewards.some(r => !Number.isFinite(r))) throw new Error('请输入有效数字。');
  const mean = rewards.reduce((a,b)=>a+b,0)/rewards.length;
  const std = Math.sqrt(rewards.reduce((a,b)=>a+(b-mean)**2,0)/rewards.length);
  return {mean,std,values: rewards.map(r=> std < 1e-10 ? 0 : (r-mean)/(std+1e-8))};
}
