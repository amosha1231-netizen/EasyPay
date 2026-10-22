// Bill-splitting logic. All money is integer agorot (1 ₪ = 100 agorot) so totals
// always add up exactly; no floating-point drift.

/** Parses user input like "42", "42.5", "42,50", "₪ 1,200.90" into agorot. Returns null if invalid. */
export function parseMoney(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  let s = String(input ?? '').replace(/[₪\s]/g, '');
  if (!s) return null;
  // "1,200.90" -> thousands separator; "42,50" -> decimal comma
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Formats agorot as "₪42.50" (or "₪42" for whole shekels). */
export function formatMoney(agorot) {
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(agorot);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = abs % 100;
  return `${sign}₪${whole}${frac ? '.' + String(frac).padStart(2, '0') : ''}`;
}

/**
 * Splits `total` agorot across `weights` so the parts sum exactly to `total`
 * (largest-remainder method; ties go to the earlier entry).
 */
export function allocate(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) weights = weights.map(() => 1);
  const wsum = sum <= 0 ? n : sum;
  const exact = weights.map((w) => (total * w) / wsum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) parts[order[k].i]++;
  return parts;
}

export function lineTotal(item) {
  return Math.max(0, Math.round(item.price || 0)) * Math.max(1, Math.round(item.qty || 1));
}

/**
 * Computes each person's share.
 * bill: { people: [{id, name}], payerId, items: [{id, name, price, qty, sharedBy: [personId]}], tipPercent }
 * Items with nobody selected are split between everyone (and reported in `unassigned`).
 */
export function computeSplit(bill) {
  const people = bill.people || [];
  const ids = people.map((p) => p.id);
  const byId = Object.fromEntries(people.map((p) => [p.id, { id: p.id, name: p.name, lines: [], subtotal: 0, tip: 0, total: 0 }]));
  const unassigned = [];
  let subtotal = 0;

  for (const item of bill.items || []) {
    const amount = lineTotal(item);
    subtotal += amount;
    let sharers = (item.sharedBy || []).filter((id) => byId[id]);
    if (sharers.length === 0) {
      unassigned.push(item);
      sharers = ids;
    }
    if (sharers.length === 0) continue;
    // Keep people order stable so remainders land predictably.
    sharers = ids.filter((id) => sharers.includes(id));
    allocate(amount, sharers.map(() => 1)).forEach((share, k) => {
      const p = byId[sharers[k]];
      p.subtotal += share;
      p.lines.push({ itemId: item.id, name: item.name, share, of: sharers.length, amount });
    });
  }

  const tipPercent = Math.max(0, Number(bill.tipPercent) || 0);
  const tip = Math.round((subtotal * tipPercent) / 100);
  const tips = allocate(tip, ids.map((id) => byId[id].subtotal));
  ids.forEach((id, k) => {
    byId[id].tip = tips[k];
    byId[id].total = byId[id].subtotal + tips[k];
  });

  const shares = ids.map((id) => byId[id]);
  const payer = byId[bill.payerId] ? bill.payerId : null;
  const debts = payer ? shares.filter((s) => s.id !== payer && s.total > 0).map((s) => ({ from: s.id, to: payer, amount: s.total })) : [];

  return { subtotal, tip, total: subtotal + tip, shares, unassigned, debts };
}

// --- Share links: the whole bill lives in the URL, so no server is needed. ---

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Compact, versioned encoding of a bill (ids are re-derived from positions). */
export function encodeBill(bill) {
  const idx = Object.fromEntries(bill.people.map((p, i) => [p.id, i]));
  const data = {
    v: 1,
    t: bill.title || '',
    d: bill.date || '',
    p: bill.people.map((p) => p.name),
    y: bill.payerId in idx ? idx[bill.payerId] : -1,
    i: bill.items.map((it) => [it.name, it.price, it.qty || 1, (it.sharedBy || []).filter((id) => id in idx).map((id) => idx[id])]),
    x: bill.tipPercent || 0,
    ph: bill.payerPhone || '',
    pb: bill.payboxLink || '',
  };
  return toBase64Url(JSON.stringify(data));
}

/** Decodes a share link payload. Throws on malformed input. All fields are sanitized. */
export function decodeBill(payload) {
  const d = JSON.parse(fromBase64Url(payload));
  if (!d || d.v !== 1 || !Array.isArray(d.p) || !Array.isArray(d.i)) throw new Error('bad payload');
  const str = (v, max) => String(v ?? '').slice(0, max);
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const people = d.p.slice(0, 50).map((name, i) => ({ id: 'p' + i, name: str(name, 40) }));
  const items = d.i.slice(0, 200).map((it, k) => ({
    id: 'i' + k,
    name: str(it[0], 60),
    price: num(it[1]),
    qty: Math.max(1, num(it[2])),
    sharedBy: (Array.isArray(it[3]) ? it[3] : []).filter((n) => people[n]).map((n) => 'p' + n),
  }));
  const pb = str(d.pb, 200);
  return {
    title: str(d.t, 60),
    date: str(d.d, 30),
    people,
    payerId: people[d.y] ? 'p' + d.y : null,
    items,
    tipPercent: Number.isFinite(d.x) ? Math.min(100, Math.max(0, d.x)) : 0,
    payerPhone: str(d.ph, 20).replace(/[^\d+\-]/g, ''),
    payboxLink: /^https:\/\//.test(pb) ? pb : '',
  };
}
