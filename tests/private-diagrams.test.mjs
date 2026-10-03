import test from 'node:test';
import assert from 'node:assert/strict';
import {isPrivateFlowchart} from '../src/private-diagrams.js';
test('private diagrams accept only plain flowchart nodes and edges',()=>{
 assert.equal(isPrivateFlowchart('flowchart TD\n A[输入] --> B[输出]\n B -.检查.-> A'),true);
 for(const text of ['flowchart TD\n A@{img: "https://example.test/track"}', '%%{init: {securityLevel: "loose"}}%%\nflowchart TD\n A-->B','flowchart TD\n click A "https://example.test"','flowchart TD\n A[<img src=x>]','flowchart TD\n A[https://example.test]','sequenceDiagram\n A->>B: hidden','---\nconfig:\n---\nflowchart TD\n A-->B'])assert.equal(isPrivateFlowchart(text),false);
});
