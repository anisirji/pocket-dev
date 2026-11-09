import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTasks, taskChanges, taskProblem, assigneeText, creatorText, describeEvent, agoText, chatTitle, sizeText, originLabel } from '../public/room-pages.js';

const members = [{ deviceId: 'a', name: 'Laptop' }, { deviceId: 'b', name: 'Desktop' }];
const t = (id, status, assignee, updatedAt) => ({ id, status, assignee, updatedAt, title: id });

test('tasks group by status, newest edit first, and "mine" keeps only this device', () => {
  const tasks = [t('L-1', 'todo', 'a', 1), t('L-2', 'todo', 'b', 5), t('L-3', 'done', 'a', 2), t('L-4', 'weird', null, 3)];
  const all = groupTasks(tasks);
  assert.deepEqual(all.todo.map((x) => x.id), ['L-2', 'L-4', 'L-1']);
  assert.deepEqual(all.done.map((x) => x.id), ['L-3']);
  assert.deepEqual(groupTasks(tasks, { filter: 'mine', selfId: 'a' }).todo.map((x) => x.id), ['L-1']);
});

test('names for assignee and creator', () => {
  assert.equal(assigneeText({ assignee: null }, members, 'a'), 'Unassigned');
  assert.equal(assigneeText({ assignee: 'a' }, members, 'a'), 'You');
  assert.equal(assigneeText({ assignee: 'b' }, members, 'a'), 'Desktop');
  assert.equal(assigneeText({ assignee: 'gone' }, members, 'a'), 'Left the room');
  assert.equal(creatorText({ createdBy: 'gone', createdByName: 'Old' }, members, 'a'), 'Old');
  assert.equal(creatorText({ createdBy: 'a' }, members, 'a'), 'you');
});

test('an edit sends only what changed; a form needs a title', () => {
  const task = { title: 'x', description: '', status: 'todo', assignee: null };
  assert.deepEqual(taskChanges(task, { ...task }), {});
  assert.deepEqual(taskChanges(task, { ...task, status: 'done', assignee: 'b' }), { status: 'done', assignee: 'b' });
  assert.match(taskProblem({ title: '  ' }), /title/);
  assert.equal(taskProblem({ title: 'ok', description: '' }), '');
  assert.match(taskProblem({ title: 'x'.repeat(201) }), /too long/);
});

test('mirrored events become plain descriptions; images carry their state', () => {
  assert.deepEqual(describeEvent({ type: 'user-text', text: 'hi' }), { kind: 'user', text: 'hi', files: [] });
  assert.equal(describeEvent({ type: 'thinking', text: 'hmm' }), null);
  assert.equal(describeEvent({ type: 'assistant-text', text: '' }), null);
  const tool = describeEvent({ type: 'tool-run', name: 'Read', summary: 'a.png', images: ['x.png', 'y.png', 'z.png'],
    blobs: { 'img:x.png': { size: 10, sha256: 'h' }, 'img:y.png': { tooLarge: true, size: 99999999 } } });
  assert.deepEqual(tool.images.map((i) => [i.blobId, i.state]), [['img:x.png', 'ready'], ['img:y.png', 'large'], ['img:z.png', 'missing']]);
  assert.deepEqual(describeEvent({ type: 'file-edit', path: '/a', diff: '+x' }), { kind: 'edit', path: '/a', diff: '+x', truncated: false });
  assert.equal(describeEvent({ type: 'result' }).kind, 'status');
  assert.equal(describeEvent({ type: 'mystery' }), null);
});

test('small text helpers', () => {
  assert.equal(agoText(0), 'no activity');
  assert.equal(agoText(1000, 1000 + 5 * 60000), '5 min ago');
  assert.equal(chatTitle({ title: ' ' }), 'Untitled chat');
  assert.equal(sizeText(2048), '2 KB');
  assert.equal(originLabel({ origin: { deviceName: 'Laptop' } }), 'Laptop');
  assert.equal(originLabel({}), '');
});
