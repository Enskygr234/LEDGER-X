/** Form controls with labels, hints and inline validation errors. */
import { h } from './ui.js';
import { currencyDigits, parseMoney, toDecimalString, parseQuantity, parseRate } from '../utils/calculations.js';

export function field(label, control, { hint, name, span } = {}) {
  const err = h('div', { class: 'error', 'data-error-for': name || '' });
  const id = control.id || `f_${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: ['field', span && 'span-2'] }, label ? h('label', { for: id }, label) : null, control, hint ? h('div', { class: 'hint' }, hint) : null, err);
}

export function textInput({ name, value = '', placeholder = '', type = 'text', inputmode, autocomplete = 'off', maxlength, required } = {}) {
  return h('input', { class: 'input', name, value: value ?? '', placeholder, type, inputmode, autocomplete, maxlength, required, 'data-name': name });
}

export function textArea({ name, value = '', placeholder = '', rows = 3 } = {}) {
  const t = h('textarea', { class: 'textarea', name, placeholder, rows, 'data-name': name });
  t.value = value ?? '';
  return t;
}

export function selectInput({ name, value, options }) {
  const s = h('select', { class: 'select', name, 'data-name': name },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
  return s;
}

export function dateInput({ name, value = '' }) {
  return h('input', { class: 'input', type: 'date', name, value: value || '', 'data-name': name });
}

/** Money input: shows decimal text, `.minor` getter returns integer minor units (or null). */
export function moneyInput({ name, valueMinor = null, currency = 'USD', placeholder = '0.00' }) {
  const digits = currencyDigits(currency);
  const input = h('input', { class: 'input num', name, inputmode: 'decimal', placeholder, autocomplete: 'off', 'data-name': name,
    value: valueMinor === null || valueMinor === undefined ? '' : toDecimalString(valueMinor, digits) });
  Object.defineProperty(input, 'minor', { get: () => parseMoney(input.value, currency) });
  input.setCurrency = (c) => { currency = c; };
  return input;
}

export function quantityInput({ name, valueMilli = 1000 }) {
  const input = h('input', { class: 'input num', name, inputmode: 'decimal', autocomplete: 'off', value: toDecimalString(valueMilli, 3).replace(/\.?0+$/, ''), 'data-name': name });
  Object.defineProperty(input, 'milli', { get: () => parseQuantity(input.value) });
  return input;
}

export function rateInput({ name, valueBp = 0 }) {
  const input = h('input', { class: 'input num', name, inputmode: 'decimal', autocomplete: 'off', value: toDecimalString(valueBp, 2).replace(/\.?0+$/, ''), 'data-name': name });
  Object.defineProperty(input, 'bp', { get: () => parseRate(input.value) });
  return input;
}

export function withAddon(input, { before, after }) {
  return h('div', { class: 'input-group' }, before ? h('span', { class: 'addon' }, before) : null, input, after ? h('span', { class: 'addon' }, after) : null);
}

export function toggle({ name, checked, label, hint, onChange }) {
  const input = h('input', { type: 'checkbox', name, checked, 'data-name': name, onchange: (e) => onChange?.(e.target.checked) });
  return h('label', { class: 'check' }, h('span', { class: 'switch' }, input, h('span')),
    h('span', { class: 'grow' }, h('div', label), hint ? h('div', { class: 'hint faint', style: { fontSize: '12px' } }, hint) : null));
}

/** Show validation errors (field -> message) next to controls inside `root`. */
export function showErrors(root, errors = {}) {
  for (const el of root.querySelectorAll('.invalid')) el.classList.remove('invalid');
  for (const el of root.querySelectorAll('.error[data-error-for]')) el.textContent = '';
  let first = null;
  for (const [name, msg] of Object.entries(errors)) {
    const ctl = root.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const slot = root.querySelector(`.error[data-error-for="${CSS.escape(name)}"]`);
    if (ctl) { ctl.classList.add('invalid'); first = first || ctl; }
    if (slot) slot.textContent = msg;
  }
  first?.focus?.();
  return !!first;
}

export const currencyOptions = () => {
  const common = ['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'CHF', 'CAD', 'AUD', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'SGD', 'HKD', 'NZD', 'KWD', 'BHD'];
  let all = common;
  try { all = [...new Set([...common, ...Intl.supportedValuesOf('currency')])]; } catch { /* older engines */ }
  let names;
  try { names = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { names = null; }
  return all.map((c) => [c, names ? `${c} — ${names.of(c)}` : c]);
};
