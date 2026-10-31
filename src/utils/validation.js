/** Input validation helpers. Each returns an error message or null. */

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
export const isCurrency = (s) => {
  if (!/^[A-Z]{3}$/.test(s || '')) return false;
  if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('currency').includes(s);
  try { new Intl.NumberFormat('en', { style: 'currency', currency: s }); return true; } catch { return false; }
};

export class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors)[0] || 'Invalid input');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Validate `data` against rules: { field: [ruleFn, ...] }.
 * Throws ValidationError with a field->message map.
 */
export function validate(data, rules) {
  const errors = {};
  for (const [field, fns] of Object.entries(rules)) {
    for (const fn of fns) {
      const msg = fn(data[field], data);
      if (msg) { errors[field] = msg; break; }
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return true;
}

export const required = (label) => (v) => (v === null || v === undefined || String(v).trim() === '' ? `${label} is required` : null);
export const maxLen = (n, label) => (v) => (v && String(v).length > n ? `${label} must be at most ${n} characters` : null);
export const email = () => (v) => (v && !isEmail(v) ? 'Enter a valid email address' : null);
export const date = (label) => (v) => (v && !isIsoDate(v) ? `${label} must be a valid date` : null);
export const currency = () => (v) => (!isCurrency(v) ? 'Choose a valid ISO currency code' : null);
export const intRange = (min, max, label) => (v) =>
  (v !== null && v !== undefined && (!Number.isSafeInteger(v) || v < min || v > max) ? `${label} is out of range` : null);
export const phone = () => (v) => (v && !/^[+()\d\s.-]{5,32}$/.test(v) ? 'Enter a valid phone number' : null);
