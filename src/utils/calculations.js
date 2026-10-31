/**
 * Decimal-safe monetary arithmetic.
 *
 * Representation:
 *  - Money:     integer minor units (cents, kuruş, fils…) — `*_minor`
 *  - Quantity:  integer thousandths (1.5 h => 1500)      — `quantity_milli`
 *  - Rates:     integer basis points (18% => 1800)        — `*_bp`
 *
 * Intermediate products use BigInt, so no floating-point value ever touches a
 * monetary amount. Rounding is half-away-from-zero ("commercial rounding").
 */

const B = BigInt;

/** Divide BigInt n by d (d > 0) rounding half away from zero. */
export function divRound(n, d) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / d;
  const r = a % d;
  const res = r * 2n >= d ? q + 1n : q;
  return neg ? -res : res;
}

/** Number of minor-unit digits for a currency (USD 2, JPY 0, KWD 3). */
export function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/**
 * Parse a user-entered decimal string into an integer scaled by 10^digits,
 * without using floating point. Accepts "1234.5", "1,234.50", "1 234,50".
 * Returns null for invalid input.
 */
export function parseDecimal(input, digits) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[\s ']/g, '');
  if (s === '') return null;
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decSep = null;
  if (lastDot >= 0 && lastComma >= 0) decSep = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0) decSep = (s.match(/\./g).length === 1) ? '.' : null;
  else if (lastComma >= 0) {
    // "12,5" / "12,50" => decimal comma; "1,234" / "1,234,567" => thousands separators.
    const parts = s.split(',');
    decSep = parts.length === 2 && parts[1].length !== 3 ? ',' : null;
  }
  let intPart = s;
  let fracPart = '';
  if (decSep) {
    const i = s.lastIndexOf(decSep);
    intPart = s.slice(0, i);
    fracPart = s.slice(i + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || (intPart === '' && fracPart === '')) return null;
  if (fracPart.length > digits) {
    // round half-up on the dropped digits
    const keep = fracPart.slice(0, digits);
    const next = Number(fracPart[digits]);
    let scaled = B((intPart || '0') + keep.padEnd(digits, '0'));
    if (next >= 5) scaled += 1n;
    const v = Number(scaled);
    return neg ? -v : v;
  }
  const scaled = Number(B((intPart || '0') + fracPart.padEnd(digits, '0')));
  return neg ? -scaled : scaled;
}

export const parseMoney = (input, currency) => parseDecimal(input, currencyDigits(currency));
export const parseQuantity = (input) => parseDecimal(input, 3);
/** "18" or "18.5" (%) -> basis points */
export const parseRate = (input) => parseDecimal(input, 2);

/** Integer scaled value -> plain decimal string ("1234.50"). */
export function toDecimalString(scaled, digits) {
  const neg = scaled < 0;
  const s = String(Math.abs(scaled)).padStart(digits + 1, '0');
  const out = digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
  return neg ? `-${out}` : out;
}

/**
 * Compute a single line. Inputs are integers in the representations above.
 * Discount: 'percent' => discount_value in bp of the line subtotal;
 *           'amount'  => discount_value in minor units (capped at subtotal).
 * Tax applies to the discounted amount.
 */
export function computeLine({ quantity_milli, unit_price_minor, discount_type = 'none', discount_value = 0, tax_rate_bp = 0 }) {
  for (const [k, v] of Object.entries({ quantity_milli, unit_price_minor, discount_value, tax_rate_bp })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${k} must be a non-negative integer`);
  }
  const subtotal = divRound(B(quantity_milli) * B(unit_price_minor), 1000n);
  let discount = 0n;
  if (discount_type === 'percent') discount = divRound(subtotal * B(Math.min(discount_value, 10000)), 10000n);
  else if (discount_type === 'amount') discount = B(discount_value) > subtotal ? subtotal : B(discount_value);
  const net = subtotal - discount;
  const tax = divRound(net * B(tax_rate_bp), 10000n);
  if (net + tax > B(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount is too large');
  return {
    line_subtotal_minor: Number(subtotal),
    line_discount_minor: Number(discount),
    line_tax_minor: Number(tax),
    line_total_minor: Number(net + tax),
  };
}

/** Compute document totals and a per-rate tax breakdown. */
export function computeDocument(items) {
  let subtotal = 0n, discount = 0n, tax = 0n, total = 0n;
  const byRate = new Map();
  const lines = items.map((it) => {
    const l = computeLine(it);
    subtotal += B(l.line_subtotal_minor);
    discount += B(l.line_discount_minor);
    tax += B(l.line_tax_minor);
    total += B(l.line_total_minor);
    const rate = it.tax_rate_bp || 0;
    const prev = byRate.get(rate) || { rate_bp: rate, base_minor: 0, tax_minor: 0 };
    prev.base_minor += l.line_subtotal_minor - l.line_discount_minor;
    prev.tax_minor += l.line_tax_minor;
    byRate.set(rate, prev);
    return { ...it, ...l };
  });
  return {
    lines,
    subtotal_minor: Number(subtotal),
    discount_minor: Number(discount),
    tax_minor: Number(tax),
    total_minor: Number(total),
    tax_breakdown: [...byRate.values()].sort((a, b) => a.rate_bp - b.rate_bp),
  };
}

/** Derive an invoice's payment status from amounts and dates. */
export function derivePaymentStatus({ status, total_minor, paid_minor, due_date }, today = new Date().toISOString().slice(0, 10)) {
  if (status === 'cancelled' || status === 'draft') return status;
  if (total_minor > 0 && paid_minor >= total_minor) return 'paid';
  if (paid_minor > 0) return due_date && due_date < today ? 'overdue' : 'partially_paid';
  if (due_date && due_date < today) return 'overdue';
  return 'pending';
}
