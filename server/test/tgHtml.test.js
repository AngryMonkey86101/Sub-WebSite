import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, b, i, code, quote, toPlain } from '../src/tgHtml.js';
import { validHtml } from './plain.js';

test('разметка Telegram: экранирование и текст без разметки', () => {
  assert.equal(esc('<b>Tom & "Jerry"</b>'), '&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(12), '12');
  assert.equal(b('1 < 2'), '<b>1 &lt; 2</b>');
  assert.equal(i('a & b'), '<i>a &amp; b</i>');
  assert.equal(code('K7M2'), '<code>K7M2</code>');
  assert.equal(quote(b('x')), '<blockquote><b>x</b></blockquote>');
  assert.equal(quote('x', { expandable: true }), '<blockquote expandable>x</blockquote>');

  const tricky = 'СБП <script> & &lt; "кавычки"';
  const html = `${b('Как оплатить:')}\n${quote(esc(tricky))}`;
  assert.ok(validHtml(html));
  assert.equal(toPlain(html), `Как оплатить:\n${tricky}`, 'обратно — ровно исходный текст, и «&lt;» не раскрывается дважды');

  assert.ok(!validHtml('<b>не закрыт'));
  assert.ok(!validHtml('<b><i>криво</b></i>'));
  assert.ok(!validHtml('<script>x</script>'));
  assert.ok(!validHtml('1 < 2'));
  assert.ok(!validHtml('Tom & Jerry'));
});
