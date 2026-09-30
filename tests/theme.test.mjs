import test from 'node:test';
import assert from 'node:assert/strict';
import {THEME_KEY,resolveTheme,oppositeTheme} from '../src/theme.js';

test('explicit reading mode overrides the system preference',()=>{
  assert.equal(resolveTheme('light',true),'light');
  assert.equal(resolveTheme('dark',false),'dark');
  assert.equal(THEME_KEY,'agent-learning-atlas.theme');
});

test('first visit follows the operating system and the toggle is reversible',()=>{
  assert.equal(resolveTheme(null,true),'dark');
  assert.equal(resolveTheme(null,false),'light');
  assert.equal(oppositeTheme(oppositeTheme('light')),'light');
});
