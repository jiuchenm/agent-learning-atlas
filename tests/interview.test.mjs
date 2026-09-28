import test from 'node:test';
import assert from 'node:assert/strict';
import {interviewPrompts} from '../src/interview.js';
test('extracts follow-up questions without leaking the answer or lesson prose',()=>{const md='<details><summary>面试怎么回答</summary>**追问一：温度低为什么还会错？** 因为最大概率也可能错。 **追问：消息是 token 吗？** 不是。</details>';assert.deepEqual(interviewPrompts(md),['温度低为什么还会错？','消息是 token 吗？']);});
test('unrecognized prose produces no fabricated questions',()=>{assert.deepEqual(interviewPrompts('# Knowledge point'),[]);});
