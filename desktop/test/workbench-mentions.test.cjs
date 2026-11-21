const test = require('node:test');
const assert = require('node:assert/strict');
const { choices, resolve } = require('../workbench/mentions.js');
const roles = [{ id: 'code', name: 'Code Expert' }, { id: 'design', name: 'Designer' }, { id: 'review', name: 'Reviewer' }];

test('Mentions route to one participant, a deduplicated subset, or everyone', () => {
  assert.deepEqual(resolve('@Code Expert inspect the code', roles).roleIds, ['code']);
  assert.deepEqual(resolve('@Designer @Reviewer review this @Designer ', roles).roleIds, ['design', 'review']);
  assert.deepEqual(resolve('@所有角色 review', roles).roleIds, roles.map(role => role.id));
  assert.deepEqual(resolve('No explicit recipient', roles).roleIds, roles.map(role => role.id));
  assert.equal(resolve('@Code Expert ', roles).content, '');
});

test('All-participant expansion and first explicit mentions preserve the chosen speaking order', () => {
  assert.deepEqual(resolve('@所有角色 @Designer summarize last', roles).roleIds, ['code','review','design']);
  assert.deepEqual(resolve('@Reviewer @所有角色 discuss', roles).roleIds, ['review','code','design']);
  assert.deepEqual(resolve('Discuss in the default order', [...roles].reverse(), ['code','review']).roleIds, ['review','code']);
  assert.deepEqual(resolve('@Designer @所有角色 @Designer check again', roles).roleIds,['design','code','review']);
});

test('Repeating participants in prose does not reorder their first explicit mentions or actual discussion turns', async () => {
  const participants=[{id:'gpt',name:'gpt'},{id:'claude',name:'claude'}];
  const text='@claude I agree. Work with @gpt on this. @gpt any objections?\n\n@claude stop when a review is needed.';
  const selected=resolve(text,participants);assert.deepEqual(selected.roleIds,['claude','gpt']);assert.equal(selected.content.includes('@'),false);
  const turns=[];
  await require('../workbench/discussion.cjs').run({roleIds:selected.roleIds,rounds:1,autoStop:false,signal:new AbortController().signal,runTurn:async id=>{turns.push(id);return {status:'complete'};}});
  assert.deepEqual(turns,['claude','gpt']);
  assert.deepEqual(resolve('@gpt @claude @gpt @claude',participants).roleIds,['gpt','claude']);
});
test('Email addresses, code and partial names do not select a participant', () => {
  assert.equal(resolve('mail@Designer.example', roles).explicit, false);
  assert.equal(resolve('`@Designer` is an example', roles).explicit, false);
  assert.equal(resolve('```text\n@Reviewer\n```', roles).explicit, false);
  assert.equal(resolve('@DesignerSuffix', roles).explicit, false);
  assert.equal(resolve('@Code Ex', roles).explicit, false);
});
test('Duplicate display names and reserved all-participant names remain selectable', () => {
  const repeated = [{ id: 'one', name: 'Expert' }, { id: 'two', name: 'Expert' }, { id: 'three', name: '所有角色' }];
  const list = choices(repeated);
  assert.equal(new Set(list.map(item => item.label)).size, list.length);
  for (const entry of list.filter(item => item.id !== 'all')) assert.deepEqual(resolve('@' + entry.label + ' inspect', repeated).roleIds, [entry.id]);
});
