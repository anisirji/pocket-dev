import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpInputPlan, mcpInputContent, requestMcpInput } from '../src/chat/mcp-input.js';
const params = { mode: 'form', message: 'Choose the test settings', requestedSchema: { type: 'object', properties: {
  count: { type: 'integer', minimum: 1, maximum: 5 }, approved: { type: 'boolean' }, browser: { type: 'string', enum: ['Chrome', 'Edge'] }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 1 },
}, required: ['count', 'approved'] } };
test('MCP forms map the existing question answers to typed, validated content', () => {
  const plan = mcpInputPlan(params);
  assert.equal(plan.questions[3].multiSelect, true);
  assert.deepEqual(mcpInputContent(plan, { count: ['3'], approved: ['No'], browser: ['Chrome'], tags: ['a'] }), { count: 3, approved: false, browser: 'Chrome', tags: ['a'] });
  for (const answers of [{ approved: ['Yes'] }, { count: ['99'], approved: ['Yes'] }, { count: ['NaN'], approved: ['No'] }, { count: ['2.5'], approved: ['Yes'] }, { count: ['1'], approved: ['Yes'], tags: ['a', 'b'] }, { count: ['1'], approved: ['unlisted'] }]) assert.throws(() => mcpInputContent(plan, answers));
});
test('unknown, complex and credential forms fail closed; authorization links require HTTP(S)', async () => {
  for (const properties of [{ password: { type: 'string' } }, { x: { type: 'object' } }, { x: { type: 'string', pattern: '(a+)+' } }, { x: { type: 'string', enum: [] } }, { x: { type: 'string', $ref: '#/secret' } }]) assert.throws(() => mcpInputPlan({ requestedSchema: { type: 'object', properties } }));
  for (const url of ['javascript:alert(1)', 'file:///private/key', 'https://user:password@example.test']) assert.throws(() => mcpInputPlan({ mode: 'url', url }));
  let asked = false;
  const reply = await requestMcpInput({ emit() {}, ask() { asked = true; } }, { mode: 'openai/userVerification' });
  assert.deepEqual(reply, { action: 'cancel', content: null }); assert.equal(asked, false);
});
test('MCP input cancellation is preserved and invalid answers are corrected without auto-approval', async () => {
  const events = [], answers = [{ answers: { count: ['0'], approved: ['Yes'] } }, { answers: { count: ['2'], approved: ['Yes'] } }];
  const reply = await requestMcpInput({ emit() {}, ask(event) { events.push(event); return Promise.resolve(answers.shift()); } }, params);
  assert.deepEqual(reply, { action: 'accept', content: { count: 2, approved: true } }); assert.match(events[1].questions[0].question, /outside the allowed range/);
  assert.deepEqual(await requestMcpInput({ emit() {}, ask: async () => ({ cancelled: true }) }, params), { action: 'cancel', content: null });
  assert.deepEqual(await requestMcpInput({ emit() {}, ask: async () => ({ decision: 'deny' }) }, { mode: 'url', url: 'https://example.test/login' }), { action: 'decline', content: null });
});
