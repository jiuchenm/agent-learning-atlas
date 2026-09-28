import test from 'node:test';
import assert from 'node:assert/strict';
import {marked} from 'marked';
import katex from 'katex';
import {protectMath} from '../src/markdown-math.js';
test('LaTeX norm and row separators survive Markdown',()=>{
  const tex = String.raw`\|x\|^2 + \begin{bmatrix}1&0\\0&1\end{bmatrix}`;
  const {protectedText,equations}=protectMath('Before $$'+tex+'$$ after $x_0$.');
  const html=marked.parse(protectedText);
  assert.equal(equations[0].tex,tex);
  assert.equal(equations[0].display,true);
  assert.equal(equations[1].tex,'x_0');
  assert.equal(equations[1].display,false);
  assert.ok(html.includes('data-atlas-math="0"'));
  assert.doesNotThrow(()=>katex.renderToString(equations[0].tex,{throwOnError:true}));
});
