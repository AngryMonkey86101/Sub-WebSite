import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTariff } from '../src/tariffPick.js';

// Тариф перед заказом при переезде: выбранный нельзя — следующий по цене в том же дата-центре.

const T = (pricelist, perDay, datacenter = '17') => ({ provider: 'zomro', datacenter, datacenterName: datacenter === '17' ? 'Netherlands-3' : 'Germany-1', pricelist, name: `T${pricelist}`, price: `${perDay} EUR за день`, perDay });
const LIST = [T('7920', 0.31), T('7864', 0.36), T('7999', 0.45), T('8100', 0.4), T('7000', 0.2), T('8235', 0.29, '19')];
const settings = { pricelist: '7864', datacenter: '17', os: 'os-uuid' };

function cloudWith(cannot, { noImage = [], fail = false } = {}) {
  const checked = [];
  return {
    checked,
    tariffs: async () => {
      if (fail) throw new Error('Zomro недоступна (ETIMEDOUT)');
      return LIST;
    },
    check: async ({ list }) => list.map((t) => {
      checked.push(t.pricelist);
      if (noImage.includes(t.pricelist)) return { ...t, can: false, noImage: true, reason: 'форма открыта, номер образа ОС неизвестен' };
      return cannot.includes(t.pricelist) ? { ...t, can: false, reason: 'Zomro: нет свободных мест' } : { ...t, can: true, os: { id: `os-${t.pricelist}`, name: 'Ubuntu 24.04' } };
    })
  };
}

test('тариф: выбранный можно заказать — он, без лишних проверок и без смены образа', async () => {
  const cloud = cloudWith([]);
  const r = await chooseTariff({ provider: 'zomro', cloud, settings });
  assert.equal(r.changed, false);
  assert.equal(r.tariff.pricelist, '7864');
  assert.equal(r.os, null, 'образ — из настроек, как раньше');
  assert.deepEqual(cloud.checked, ['7864']);
});

test('тариф: выбранный распродан — ближайший дороже в том же дата-центре, потом дешевле', async () => {
  let cloud = cloudWith(['7864']);
  let r = await chooseTariff({ provider: 'zomro', cloud, settings });
  assert.equal(r.changed, true);
  assert.equal(r.tariff.pricelist, '8100', '0.40 — ближайший дороже 0.36');
  assert.equal(r.os, 'os-8100');
  assert.match(r.skipped[0], /T7864 \(0\.36 EUR за день\) — Zomro: нет свободных мест/);

  cloud = cloudWith(['7864', '8100', '7999']);
  r = await chooseTariff({ provider: 'zomro', cloud, settings });
  assert.equal(r.tariff.pricelist, '7920', 'дороже нет — ближайший дешевле');
  assert.deepEqual(cloud.checked, ['7864', '8100', '7999', '7920']);
  assert.ok(!cloud.checked.includes('8235'), 'другой дата-центр не трогаем');
});

test('тариф: в дата-центре ничего нельзя — ошибка (переезд пойдёт к следующему хостеру)', async () => {
  const cloud = cloudWith(['7864', '8100', '7999', '7920', '7000']);
  await assert.rejects(chooseTariff({ provider: 'zomro', cloud, settings }), /в дата-центре Netherlands-3 сейчас нельзя заказать ни один тариф: T7864[\s\S]* и ещё 1/);
});

test('тариф: образ ОС в форме неизвестен — годится с образом из настроек; проверка не удалась — заказ как раньше', async () => {
  let r = await chooseTariff({ provider: 'zomro', cloud: cloudWith([], { noImage: ['7864'] }), settings });
  assert.equal(r.changed, false);
  r = await chooseTariff({ provider: 'zomro', cloud: cloudWith(['7864'], { noImage: ['8100'] }), settings });
  assert.equal(r.tariff.pricelist, '8100');
  assert.equal(r.os, 'os-uuid');

  r = await chooseTariff({ provider: 'zomro', cloud: cloudWith([], { fail: true }), settings });
  assert.equal(r.changed, false);
  assert.match(r.warning, /тарифы не проверены \(Zomro недоступна \(ETIMEDOUT\)\) — заказываю выбранный/);
});

test('тариф Aeza: выбранный продукт распродан — следующий в той же локации', async () => {
  const list = [
    { provider: 'aeza', datacenter: '5', datacenterName: 'Нидерланды', pricelist: '41', name: 'NLs-1', price: '0.01 EUR за час', perDay: 0.24 },
    { provider: 'aeza', datacenter: '5', datacenterName: 'Нидерланды', pricelist: '42', name: 'NLs-2', price: '0.02 EUR за час', perDay: 0.48 },
    { provider: 'aeza', datacenter: '6', datacenterName: 'Германия', pricelist: '51', name: 'DEs-1', price: '0.01 EUR за час', perDay: 0.24 }
  ];
  const cloud = {
    tariffs: async () => list,
    check: async ({ list: l }) => l.map((t) => (t.pricelist === '41' ? { ...t, can: false, reason: 'распродан' } : { ...t, can: true, os: { id: '940' } }))
  };
  const r = await chooseTariff({ provider: 'aeza', cloud, settings: { product: '41', os: '' } });
  assert.equal(r.tariff.pricelist, '42');
  assert.equal(r.os, '940');
});
