// The card's "what is happening now" line, as the bridge builds it.
//
// The agent's own sentence is what a person wants to read. The bridge has to
// pull it out of a streaming record without showing private reasoning, without
// flooding the pipe, and without cutting the sentence in a place that hides the
// point.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import bridge from '../bridge.mjs';

const { attemptText, lastSentence } = bridge;

const stream = (...records) => records;

test('only what the agent said is read, never what it thought', () => {
  const text = attemptText(
    stream(
      { type: 'reasoning-chunks', texts: ['секретная мысль'] },
      { type: 'text-chunks', texts: ['Добавлю ', 'тест.'] },
    ),
  );
  assert.equal(text, 'Добавлю тест.', 'the reasoning is not the island\'s business');
});

test('the last sentence is what "now" means', () => {
  assert.equal(
    lastSentence('Сначала проверю сборку. Теперь добавлю тест на утечку — иначе она вернётся.'),
    'Теперь добавлю тест на утечку — иначе она вернётся.',
  );
});

test('a sentence still being written is shown as it is', () => {
  // No full stop yet: the agent is mid-sentence, and that is exactly the state
  // the card is describing.
  assert.equal(lastSentence('Сейчас проверю, что'), 'Сейчас проверю, что');
});

test('a very short tail keeps the sentence before it', () => {
  // "Ок." on its own says nothing about the work.
  assert.equal(lastSentence('Проверю сборку. Ок.'), 'Проверю сборку. Ок.');
});

test('a long line is cut at the start, where the point is not', () => {
  const long = 'Слово '.repeat(60).trim();
  const line = lastSentence(long, 80);
  assert.ok(line.length <= 81, `too long: ${line.length}`);
  assert.ok(line.startsWith('…'), 'the cut is marked');
  assert.ok(line.endsWith('Слово'), 'the end of the sentence survives');
});

test('nothing said is an empty line, not a stray space', () => {
  assert.equal(lastSentence(''), '');
  assert.equal(lastSentence('   \n  '), '');
  assert.equal(attemptText(undefined), '');
  assert.equal(attemptText([]), '');
});
