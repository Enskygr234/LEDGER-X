import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLine, computeDocument, parseMoney, parseQuantity, parseRate, divRound, currencyDigits, derivePaymentStatus, toDecimalString,
} from '../src/utils/calculations.js';
import { formatMoney, toCSV } from '../src/utils/formatting.js';

test('half-away-from-zero rounding', () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(4n, 3n), 1n);
  assert.equal(divRound(149n, 100n), 1n);
  assert.equal(divRound(150n, 100n), 2n);
});

test('the classic 0.1 + 0.2 problem cannot occur', () => {
  const d = computeDocument([
    { quantity_milli: 1000, unit_price_minor: 10, tax_rate_bp: 0 },
    { quantity_milli: 1000, unit_price_minor: 20, tax_rate_bp: 0 },
  ]);
  assert.equal(d.total_minor, 30);
});

test('line with fractional quantity, percent discount and tax', () => {
  // 2.5 h × $80.00 = $200.00; 10% off = $20.00; 18% tax on $180.00 = $32.40
  const l = computeLine({ quantity_milli: 2500, unit_price_minor: 8000, discount_type: 'percent', discount_value: 1000, tax_rate_bp: 1800 });
  assert.deepEqual(l, { line_subtotal_minor: 20000, line_discount_minor: 2000, line_tax_minor: 3240, line_total_minor: 21240 });
});

test('fixed-amount discount is capped at the subtotal', () => {
  const l = computeLine({ quantity_milli: 1000, unit_price_minor: 500, discount_type: 'amount', discount_value: 900, tax_rate_bp: 2000 });
  assert.equal(l.line_discount_minor, 500);
  assert.equal(l.line_total_minor, 0);
});

test('tax rounding happens per line and breakdown groups by rate', () => {
  const d = computeDocument([
    { quantity_milli: 1000, unit_price_minor: 333, tax_rate_bp: 1800 }, // tax 59.94 -> 60
    { quantity_milli: 1000, unit_price_minor: 333, tax_rate_bp: 1800 },
    { quantity_milli: 3000, unit_price_minor: 199, tax_rate_bp: 800 }, // 597, tax 47.76 -> 48
    { quantity_milli: 1000, unit_price_minor: 1000, tax_rate_bp: 0 },
  ]);
  assert.equal(d.subtotal_minor, 333 + 333 + 597 + 1000);
  assert.equal(d.tax_minor, 60 + 60 + 48);
  assert.equal(d.total_minor, d.subtotal_minor + d.tax_minor);
  assert.deepEqual(d.tax_breakdown.map((b) => [b.rate_bp, b.base_minor, b.tax_minor]), [[0, 1000, 0], [800, 597, 48], [1800, 666, 120]]);
});

test('huge values stay exact (BigInt intermediates)', () => {
  // 999,999 units × 90,000,000.00 overflows float precision if done naively.
  const l = computeLine({ quantity_milli: 999_999_000, unit_price_minor: 9_000_000_000, tax_rate_bp: 0 });
  assert.equal(l.line_subtotal_minor, 8_999_991_000_000_000);
  const odd = computeLine({ quantity_milli: 333, unit_price_minor: 1_000_000_000_001, tax_rate_bp: 0 });
  assert.equal(odd.line_subtotal_minor, 333_000_000_000); // 333000000000.333 rounds down
  assert.throws(() => computeLine({ quantity_milli: 999_999_000, unit_price_minor: 9_000_000_000, tax_rate_bp: 2500 }), /too large/);
});

test('invalid inputs are rejected', () => {
  assert.throws(() => computeLine({ quantity_milli: 1.5, unit_price_minor: 1 }), RangeError);
  assert.throws(() => computeLine({ quantity_milli: 1, unit_price_minor: -1 }), RangeError);
});

test('parsing user input without floats', () => {
  assert.equal(parseMoney('1,234.56', 'USD'), 123456);
  assert.equal(parseMoney('1.234,56', 'EUR'), 123456);
  assert.equal(parseMoney('12,5', 'EUR'), 1250);
  assert.equal(parseMoney('0.1', 'USD'), 10);
  assert.equal(parseMoney('19.999', 'USD'), 2000);
  assert.equal(parseMoney('1500', 'JPY'), 1500);
  assert.equal(parseMoney('1.234', 'KWD'), 1234);
  assert.equal(parseMoney('abc', 'USD'), null);
  assert.equal(parseQuantity('2.5'), 2500);
  assert.equal(parseRate('18'), 1800);
  assert.equal(parseRate('7.25'), 725);
});

test('currency digits from ISO data, not hardcoded tables', () => {
  assert.equal(currencyDigits('USD'), 2);
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(currencyDigits('BHD'), 3);
  assert.equal(toDecimalString(5, 2), '0.05');
  assert.equal(toDecimalString(-12345, 2), '-123.45');
});

test('formatMoney is exact', () => {
  assert.equal(formatMoney(123456789, 'USD'), '$1,234,567.89');
  assert.equal(formatMoney(5, 'USD'), '$0.05');
  assert.equal(formatMoney(1500, 'JPY'), '¥1,500');
});

test('payment status derivation', () => {
  const t = '2026-05-10';
  assert.equal(derivePaymentStatus({ status: 'pending', total_minor: 100, paid_minor: 0, due_date: '2026-06-01' }, t), 'pending');
  assert.equal(derivePaymentStatus({ status: 'pending', total_minor: 100, paid_minor: 40, due_date: '2026-06-01' }, t), 'partially_paid');
  assert.equal(derivePaymentStatus({ status: 'pending', total_minor: 100, paid_minor: 100, due_date: '2026-01-01' }, t), 'paid');
  assert.equal(derivePaymentStatus({ status: 'pending', total_minor: 100, paid_minor: 0, due_date: '2026-05-01' }, t), 'overdue');
  assert.equal(derivePaymentStatus({ status: 'cancelled', total_minor: 100, paid_minor: 0 }, t), 'cancelled');
});

test('CSV quoting and formula-injection guard', () => {
  const csv = toCSV([{ a: 'x,y', b: '=HYPERLINK("evil")', c: -5, d: 'line\nbreak' }]);
  assert.equal(csv, 'a,b,c,d\r\n"x,y","\'=HYPERLINK(""evil"")",-5,"line\nbreak"');
});
