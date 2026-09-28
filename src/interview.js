export function interviewPrompts(markdown){
 const questions=[];
 for(const chunk of markdown.split('**')){
  const s=chunk.trim();if(!s.startsWith('追问'))continue;
  const colon=s.indexOf('：'),end=s.indexOf('？');
  if(colon>=0&&end>colon)questions.push(s.slice(colon+1,end+1));
 }
 return questions;
}
