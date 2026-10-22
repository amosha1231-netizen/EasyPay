import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatMoney, allocate, computeSplit, encodeBill, decodeBill } from '../split.js';

test('parseMoney accepts common formats', () => {
  assert.equal(parseMoney('42'), 4200);
  assert.equal(parseMoney('42.5'), 4250);
  assert.equal(parseMoney('42,50'), 4250);
  assert.equal(parseMoney('₪ 1,200.90'), 120090);
  assert.equal(parseMoney('1,200'), 120000);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney('1.234'), null);
});

test('formatMoney', () => {
  assert.equal(formatMoney(4200), '₪42');
  assert.equal(formatMoney(4205), '₪42.05');
  assert.equal(formatMoney(123456), '₪1,234.56');
});

test('allocate always sums to the total', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.deepEqual(allocate(10, [0, 0]), [5, 5]);
  for (let t = 0; t < 500; t += 7) {
    const parts = allocate(t, [3, 1, 2, 5]);
    assert.equal(parts.reduce((a, b) => a + b, 0), t);
  }
});

const people = [
  { id: 'a', name: 'דנה' },
  { id: 'b', name: 'יואב' },
  { id: 'c', name: 'נועה' },
];

test('items are split among the people who shared them', () => {
  const r = computeSplit({
    people,
    payerId: 'a',
    tipPercent: 0,
    items: [
      { id: '1', name: 'פיצה', price: 6000, qty: 1, sharedBy: ['a', 'b'] },
      { id: '2', name: 'בירה', price: 3000, qty: 2, sharedBy: ['c'] },
      { id: '3', name: 'צ׳יפס', price: 2000, qty: 1, sharedBy: ['a', 'b', 'c'] },
    ],
  });
  assert.equal(r.subtotal, 14000);
  assert.deepEqual(r.shares.map((s) => s.total), [3000 + 667, 3000 + 667, 6000 + 666]);
  assert.equal(r.shares.reduce((a, s) => a + s.total, 0), r.total);
  assert.deepEqual(r.debts.map((d) => [d.from, d.to]), [['b', 'a'], ['c', 'a']]);
});

test('tip is proportional and totals match exactly', () => {
  const r = computeSplit({
    people,
    payerId: 'b',
    tipPercent: 12,
    items: [
      { id: '1', name: 'x', price: 3333, sharedBy: ['a'] },
      { id: '2', name: 'y', price: 1111, sharedBy: ['b', 'c'] },
    ],
  });
  assert.equal(r.tip, Math.round(4444 * 0.12));
  assert.equal(r.shares.reduce((a, s) => a + s.total, 0), r.total);
  assert.ok(r.shares[0].tip > r.shares[1].tip);
});

test('unassigned items fall back to everyone and are reported', () => {
  const r = computeSplit({ people, payerId: null, items: [{ id: '1', name: 'סה״כ', price: 30000, sharedBy: [] }] });
  assert.equal(r.unassigned.length, 1);
  assert.deepEqual(r.shares.map((s) => s.total), [10000, 10000, 10000]);
  assert.deepEqual(r.debts, []);
});

test('share link round-trips Hebrew text and drops unsafe fields', () => {
  const bill = {
    title: 'ארוחה ב<script>',
    date: '2026-10-17',
    people,
    payerId: 'c',
    items: [{ id: 'z', name: 'שקשוקה', price: 4200, qty: 1, sharedBy: ['a', 'c'] }],
    tipPercent: 10,
    payerPhone: '050-1234567',
    payboxLink: 'javascript:alert(1)',
  };
  const back = decodeBill(encodeBill(bill));
  assert.equal(back.title, 'ארוחה ב<script>');
  assert.deepEqual(back.people.map((p) => p.name), ['דנה', 'יואב', 'נועה']);
  assert.equal(back.payerId, 'p2');
  assert.deepEqual(back.items[0].sharedBy, ['p0', 'p2']);
  assert.equal(back.payboxLink, '');
  assert.equal(back.payerPhone, '050-1234567');
  assert.equal(computeSplit(back).total, computeSplit(bill).total);
});

test('decodeBill rejects garbage', () => {
  assert.throws(() => decodeBill('not-valid'));
  assert.throws(() => decodeBill(Buffer.from('{"v":2}').toString('base64url')));
});
