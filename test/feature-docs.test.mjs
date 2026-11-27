import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildOutputs, validateCatalog } from '../scripts/render-feature-docs.mjs';
const catalogue = JSON.parse(fs.readFileSync(new URL('../docs/feature-catalog.json', import.meta.url)));
const copy = () => structuredClone(catalogue);
test('catalogue rejects lost release gates, duplicate IDs, unsafe assets and placeholder tutorials', () => {
  for (const mutate of [c=>c.release.manualStability='complete', c=>c.features[1].id=c.features[0].id, c=>c.features[0].visual='../private.png', c=>c.features[0].video=c.youtube]) {
    const invalid=copy();mutate(invalid);assert.throws(()=>validateCatalog(invalid,{files:false}));
  }
});
test('one catalogue generates byte-stable Markdown and help without premature tutorial links', () => {
  validateCatalog(catalogue);const first=buildOutputs(catalogue),second=buildOutputs(copy());
  assert.deepEqual([...first],[...second]);
  for (const [name,content] of first) {
    assert.equal(content.trimEnd()+'\n',fs.readFileSync(new URL('../'+name,import.meta.url),'utf8'),name+' is fresh');
    if (!name.endsWith('.js')) assert.doesNotMatch(content,/Watch tutorial|video coming soon/i,name+' omits absent videos');
  }
});
test('existing app help exposes canonical instructions and retains no-link tutorial defaults', () => {
  const window={addEventListener(){}};vm.runInNewContext(buildOutputs(catalogue).get('public/feature-guides.js'),{window});
  for(const f of catalogue.features){const actual=window.PocketGuides.definitions[f.helpKey];assert.ok(actual,f.id);assert.deepEqual(Array.from(actual.steps),f.instructions,f.id);assert.equal(actual.video,null);}
});
