/**
 * Cross-language QC hash contract (v1).
 *
 * Objects are recursively key-sorted. JSON.stringify-compatible escaping is
 * used for strings, and finite numbers use ECMAScript-style decimal notation.
 * Keep this serializer in sync with aind_qc_portal.qc_edit.canonical_qc_json.
 */

function canonicalNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError('QC hash cannot encode non-finite numbers');
  if (Object.is(value, -0)) return '0';
  let text = String(value).toLowerCase();
  if (!text.includes('e')) return text;

  let [mantissa, exponentText] = text.split('e');
  const exponent = Number(exponentText);
  let sign = '';
  if (mantissa.startsWith('-')) {
    sign = '-';
    mantissa = mantissa.slice(1);
  }
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  const decimalExponent = exponent + whole.replace(/^0+/, '').length - 1;
  if (digits === '0') return '0';

  if (decimalExponent >= -6 && decimalExponent < 21) {
    const position = decimalExponent + 1;
    if (position <= 0) return `${sign}0.${'0'.repeat(-position)}${digits}`;
    if (position >= digits.length) return `${sign}${digits}${'0'.repeat(position - digits.length)}`;
    return `${sign}${digits.slice(0, position)}.${digits.slice(position)}`;
  }

  const coefficient = `${digits[0]}${digits.slice(1).replace(/0+$/, '') ? `.${digits.slice(1).replace(/0+$/, '')}` : ''}`;
  const exponentSign = decimalExponent >= 0 ? '+' : '-';
  return `${sign}${coefficient}e${exponentSign}${Math.abs(decimalExponent)}`;
}

export function canonicalQcJson(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalQcJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalQcJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported value in QC hash: ${typeof value}`);
}

export async function hashQc(qualityControl) {
  const bytes = new TextEncoder().encode(canonicalQcJson(qualityControl));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

