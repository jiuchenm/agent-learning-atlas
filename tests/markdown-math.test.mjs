import test from 'node:test';
import assert from 'node:assert/strict';
import {marked} from 'marked';
import katex from 'katex';
import {protectMath} from '../src/markdown-math.js';
test('shell variables inside Markdown code stay literal while prose math renders',()=>{
  const markdown='`$DSH_HOME` 与 `$env:DSH_HOME`，公式 $x_0$。\n\n```powershell\n$env:DSH_HOME = "$HOME/.dsh"\n```\n';
  const {protectedText,equations}=protectMath(markdown);
  assert.deepEqual(equations,[{tex:'x_0',display:false}]);
  const html=marked.parse(protectedText);
  assert.ok(html.includes('<code>$DSH_HOME</code>'));
  assert.ok(html.includes('$env:DSH_HOME'));
  assert.ok(html.includes('$HOME/.dsh'));
});
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
test('backticks, indentation and list code retain literal dollars',()=>{
 const markdown='``echo `$x` and $y`` then $z$.\n\n    $env:A = "$B"\n\n- code:\n\n  ```sh\n  echo "$a $b"\n  ```\n';
 const result=protectMath(markdown);
 assert.deepEqual(result.equations,[{tex:'z',display:false}]);
 assert.ok(result.protectedText.includes('$env:A'));
 assert.ok(result.protectedText.includes('echo "$a $b"'));
});
test('nested inline and list code is preserved',()=>{
 for(const markdown of ['**`$DSH_HOME` 与 `$env:DSH_HOME`**，公式 $x$.','[`$a` 和 `$b`](https://example.com) then $x$.','- code:\n\n  ~~~powershell\n  $env:A = "$B"\n  ~~~\n\n$x$','- code:\n\n      $env:A = "$B"\n\n$x$','- ~~~powershell\n  $env:A = "$B"\n  ~~~\n\n$x$']){
  assert.deepEqual(protectMath(markdown).equations,[{tex:'x',display:false}]);
 }
});
test('code-looking content inside math retains the exact original TeX',()=>{
 for(const tex of ['\\text{`x`}', '\\begin{aligned}\nx &= 1 \\\\\n\n    y &= 2\n\\end{aligned}']){
  const result=protectMath('$$'+tex+'$$');
  assert.deepEqual(result.equations,[{tex,display:true}]);
 }
});
