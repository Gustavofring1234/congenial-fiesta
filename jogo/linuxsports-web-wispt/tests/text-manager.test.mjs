import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TextManager } from '../viewer/src/ui/TextManager.js';

const ROOT = new URL('../', import.meta.url);
const fetchJson = async (p) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));

test('carrega os dois .bmg extraídos e busca por id, índice e texto', async () => {
  const tm = await TextManager.load({ fetchJson });
  assert.equal(tm.files.get('common_message').messages.length, 133);
  assert.equal(tm.files.get('sports_message').messages.length, 1200);
  assert.equal(tm.get('common_message', 0).text, 'Yes');
  assert.equal(tm.get('common_message', '0x100').text, 'No');
  assert.equal(tm.byIndex('common_message', 2).text, 'Back');
  const debut = tm.byIndex('sports_message', 67);
  assert.deepEqual(debut.args, ['name', 'value', 'value']);
  assert.equal(tm.format('sports_message', debut.id, 'Ana', '18/11', '10:00'), 'Ana\ndebuted in Wii Sports on\n18/11 at 10:00.');
  assert.equal(tm.format('sports_message', 0xdeadbeef), '[sports_message#0xdeadbeef]');
  assert.ok(tm.search('score').length > 0);
  assert.equal(tm.search(String(debut.id), { file: 'sports_message' })[0].index, 67);
});
