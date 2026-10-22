import { parseMoney, formatMoney, lineTotal, computeSplit, encodeBill, decodeBill } from './split.js';

// ---------- Storage (everything stays on this phone) ----------

const BILLS_KEY = 'easypay.bills.v1';
const PROFILE_KEY = 'easypay.profile.v1';

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota: app still works for this session */
  }
}

let bills = load(BILLS_KEY, []);
let profile = load(PROFILE_KEY, { name: '', phone: '', paybox: '' });

const saveBills = () => save(BILLS_KEY, bills);
const saveProfile = () => save(PROFILE_KEY, profile);
const uid = () => Math.random().toString(36).slice(2, 9);
const findBill = (id) => bills.find((b) => b.id === id);
const today = () => new Date().toISOString().slice(0, 10);

function newBill() {
  const me = { id: uid(), name: profile.name || 'אני' };
  const bill = {
    id: uid(),
    title: '',
    date: today(),
    people: [me],
    payerId: me.id,
    items: [],
    tipPercent: 0,
    payerPhone: profile.phone || '',
    payboxLink: profile.paybox || '',
    updatedAt: Date.now(),
  };
  bills.unshift(bill);
  saveBills();
  return bill;
}

function touch(bill) {
  bill.updatedAt = Date.now();
  saveBills();
}

// ---------- Tiny DOM helper (text is always set via textContent, never innerHTML) ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const app = document.getElementById('app');
const mount = (...nodes) => app.append(...nodes.filter((n) => n instanceof Node));
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

async function copy(text, okMsg = 'הועתק') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    window.prompt('העתיקו מכאן:', text);
  }
}

function moneyValue(agorot) {
  return agorot ? (agorot / 100).toString() : '';
}

const billTitle = (b) => b.title.trim() || 'חשבון בלי שם';

/** People who still owe the payer, and how many of them already paid back. */
function collectStatus(bill, r = computeSplit(bill)) {
  const owing = r.debts;
  const paid = owing.filter((d) => bill.paid?.[d.from]);
  const left = owing.filter((d) => !bill.paid?.[d.from]).reduce((a, d) => a + d.amount, 0);
  return { owing: owing.length, paid: paid.length, left };
}

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* ignore */ }
}
const nameOf = (b, id) => b.people.find((p) => p.id === id)?.name || '';

// ---------- Routing ----------

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  const hash = location.hash.slice(1);
  const [, route, arg, sub] = hash.split('/');
  window.scrollTo(0, 0);
  app.replaceChildren();
  if (route === 's' && arg) return renderShared(arg);
  const bill = route === 'bill' ? findBill(arg) : null;
  if (bill && sub === 'summary') return renderSummary(bill);
  if (bill) return renderEdit(bill);
  renderHome();
}

window.addEventListener('hashchange', render);

// ---------- Home ----------

function renderHome() {
  const list = bills.length
    ? h(
        'ul',
        { class: 'bill-list' },
        bills.map((b) => {
          const r = computeSplit(b);
          const st = collectStatus(b, r);
          const status = !st.owing ? '' : st.paid === st.owing ? ' · ✓ כולם העבירו' : ` · ${st.paid}/${st.owing} העבירו`;
          return h(
            'li',
            {},
            h(
              'a',
              { class: 'bill-row', href: `#/bill/${b.id}` },
              h('span', { class: 'bill-row-main' }, h('strong', {}, billTitle(b)), h('small', {}, `${formatDate(b.date)} · ${b.people.length} אנשים${status}`)),
              h('span', { class: 'amount' }, formatMoney(r.total))
            ),
            h('button', {
              class: 'icon-btn',
              'aria-label': `מחיקת ${billTitle(b)}`,
              title: 'מחיקה',
              onclick: () => {
                if (!confirm(`למחוק את "${billTitle(b)}"?`)) return;
                bills = bills.filter((x) => x.id !== b.id);
                saveBills();
                render();
              },
            }, '✕')
          );
        })
      )
    : h('p', { class: 'empty' }, 'עוד אין חשבונות. בפעם הבאה שמישהו משלם על כולם, פותחים כאן חשבון.');

  mount(
    h('header', { class: 'hero' },
      h('div', { class: 'logo' }, 'EasyPay'),
      h('h1', {}, 'מי אכל מה, ומי חייב כמה'),
      h('p', {}, 'מקלידים את החשבונית, מסמנים מי חלק כל מנה, ושולחים לקבוצה כמה כל אחד מעביר.'),
      !profile.name && h('label', { class: 'field' }, h('span', {}, 'איך קוראים לך? (כדי שהחברים ידעו למי להעביר)'),
        h('input', { id: 'my-name', maxlength: 40, autocomplete: 'given-name', placeholder: 'השם שלך' })),
      h('button', {
        class: 'btn primary big',
        onclick: () => {
          const name = document.getElementById('my-name')?.value.trim();
          if (name) { profile.name = name; saveProfile(); }
          go(`#/bill/${newBill().id}`);
        },
      }, '+ חשבון חדש')
    ),
    h('section', { class: 'card' }, h('h2', {}, 'חשבונות קודמים'), list),
    renderProfileCard()
  );
}

function renderProfileCard() {
  const field = (label, key, attrs) =>
    h('label', { class: 'field' }, h('span', {}, label),
      h('input', { ...attrs, value: profile[key], oninput: (e) => { profile[key] = e.target.value.trim(); saveProfile(); } }));
  return h('details', { class: 'card profile' },
    h('summary', {}, 'הפרטים שלי'),
    h('p', { class: 'hint' }, 'נשמר רק בטלפון הזה, וממולא אוטומטית כשאתם אלה ששילמו.'),
    field('השם שלי', 'name', { placeholder: 'למשל: עמוס', maxlength: 40, autocomplete: 'given-name' }),
    field('טלפון ל-Bit / PayBox', 'phone', { type: 'tel', placeholder: '050-0000000', inputmode: 'tel', autocomplete: 'tel' }),
    field('קישור PayBox (לא חובה)', 'paybox', { type: 'url', placeholder: 'https://payboxapp.page.link/...', inputmode: 'url' })
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(d)}.${Number(m)}.${y.slice(2)}`;
}

// ---------- Edit bill ----------

function renderEdit(bill) {
  const footerTotal = h('strong', { class: 'amount' });
  const footerNote = h('small');
  const updateFooter = () => {
    const r = computeSplit(bill);
    footerTotal.textContent = formatMoney(r.total);
    footerNote.textContent = r.tip ? `כולל טיפ ${formatMoney(r.tip)}` : `${bill.items.length} פריטים`;
  };
  const changed = (rerender = false) => {
    touch(bill);
    if (rerender) {
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    } else updateFooter();
  };

  // People
  const personInput = h('input', { placeholder: 'שם של מי שהיה', maxlength: 40, 'aria-label': 'שם חדש', enterkeyhint: 'done' });
  const addPerson = () => {
    const names = personInput.value.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return personInput.focus();
    for (const name of names) bill.people.push({ id: uid(), name });
    changed(true);
    document.querySelector('#person-input')?.focus();
  };
  personInput.id = 'person-input';
  personInput.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), addPerson()));

  const people = h('section', { class: 'card' },
    h('h2', {}, 'מי היה?'),
    h('div', { class: 'chips' },
      bill.people.map((p) =>
        h('span', { class: 'chip person' },
          h('input', {
            class: 'chip-name', value: p.name, maxlength: 40, 'aria-label': 'שם',
            size: Math.max(2, p.name.length),
            oninput: (e) => { p.name = e.target.value; e.target.size = Math.max(2, p.name.length); changed(); },
            onchange: () => {
              if (!p.name.trim()) p.name = 'בלי שם';
              // First person is "me": remember the name for next bills.
              if (p === bill.people[0] && !profile.name && p.name !== 'אני') { profile.name = p.name.trim(); saveProfile(); }
              changed(true);
            },
          }),
          bill.people.length > 1 && h('button', {
            class: 'chip-x', 'aria-label': `הסרת ${p.name}`,
            onclick: () => {
              bill.people = bill.people.filter((x) => x.id !== p.id);
              bill.items.forEach((it) => (it.sharedBy = it.sharedBy.filter((id) => id !== p.id)));
              if (bill.payerId === p.id) bill.payerId = bill.people[0]?.id || null;
              changed(true);
            },
          }, '✕')
        )
      )
    ),
    h('div', { class: 'row' }, personInput, h('button', { class: 'btn', onclick: addPerson }, 'הוספה')),
    h('p', { class: 'hint' }, 'אפשר להדביק כמה שמות עם פסיקים: דנה, יואב, נועה'),
    h('label', { class: 'field inline' }, h('span', {}, 'מי שילם?'),
      h('select', { onchange: (e) => { bill.payerId = e.target.value; changed(); } },
        bill.people.map((p) => h('option', { value: p.id, selected: p.id === bill.payerId }, p.name))))
  );

  // Equal split: one line for the whole bill, shared by everyone.
  const quickInput = h('input', { inputmode: 'decimal', placeholder: '₪ סה״כ החשבון', 'aria-label': 'סה״כ החשבון', enterkeyhint: 'done' });
  const addQuick = () => {
    const price = parseMoney(quickInput.value);
    if (!price) return toast('לא הבנתי את הסכום'), quickInput.focus();
    bill.items.push({ id: uid(), name: 'סה״כ החשבון', price, qty: 1, sharedBy: [] });
    changed(true);
  };
  quickInput.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), addQuick()));
  const quick = h('div', { class: 'row quick', hidden: true }, quickInput, h('button', { class: 'btn primary', onclick: addQuick }, 'חלוקה'));

  // Items
  const items = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'מה הוזמן?'),
      h('span', { class: 'muted' }, bill.items.length ? `${bill.items.length} פריטים` : '')),
    bill.items.length === 0 && h('p', { class: 'hint' }, 'מוסיפים כל שורה מהחשבונית ומסמנים מי חלק אותה. פריט בלי סימון מתחלק בין כולם.'),
    h('ol', { class: 'items' }, bill.items.map((it, n) => renderItem(bill, it, n, changed))),
    h('div', { class: 'row wrap' },
      h('button', {
        class: 'btn primary add-item',
        onclick: () => {
          bill.items.push({ id: uid(), name: '', price: 0, qty: 1, sharedBy: [] });
          changed(true);
          const names = document.querySelectorAll('.item-name');
          names[names.length - 1]?.focus();
        },
      }, '+ פריט'),
      bill.items.length === 0 && h('button', {
        class: 'btn ghost',
        onclick: (e) => {
          e.currentTarget.hidden = true;
          quick.hidden = false;
          quick.querySelector('input').focus();
        },
      }, 'רק לחלק שווה בשווה')
    ),
    quick
  );

  // Tip
  const customTip = h('input', {
    type: 'number', min: 0, max: 100, step: 0.5, inputmode: 'decimal', class: 'tip-custom', 'aria-label': 'אחוז טיפ אחר',
    value: [0, 10, 12, 15].includes(bill.tipPercent) ? '' : bill.tipPercent, placeholder: 'אחר %',
    oninput: (e) => {
      const v = Number(e.target.value);
      bill.tipPercent = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
      tipChips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      changed();
    },
  });
  const tipChips = h('div', { class: 'chips' },
    [0, 10, 12, 15].map((pct) =>
      h('button', {
        class: 'chip toggle', 'aria-pressed': String(bill.tipPercent === pct),
        onclick: () => { bill.tipPercent = pct; changed(true); },
      }, pct ? `${pct}%` : 'בלי'))
    , customTip);
  const tip = h('section', { class: 'card' },
    h('h2', {}, 'טיפ'),
    h('p', { class: 'hint' }, 'אם הטיפ לא נכלל בחשבונית. מתחלק לפי כמה כל אחד הזמין.'),
    tipChips
  );

  const titleInput = h('input', {
    class: 'title-input', value: bill.title, placeholder: 'איפה אכלתם?', maxlength: 60, 'aria-label': 'שם החשבון',
    oninput: (e) => { bill.title = e.target.value; changed(); },
  });

  mount(
    h('nav', { class: 'topbar' }, h('a', { href: '#/', class: 'back' }, '→ כל החשבונות'),
      h('input', { type: 'date', class: 'date', value: bill.date, 'aria-label': 'תאריך', onchange: (e) => { bill.date = e.target.value; changed(); } })),
    titleInput,
    people,
    items,
    tip,
    h('footer', { class: 'sticky' },
      h('div', { class: 'sticky-total' }, footerTotal, footerNote),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const empty = bill.items.filter((it) => !it.price);
          if (!bill.items.length) return toast('צריך להוסיף לפחות פריט אחד');
          if (empty.length) return toast('יש פריט בלי מחיר');
          go(`#/bill/${bill.id}/summary`);
        },
      }, 'לסיכום ←'))
  );
  updateFooter();
  if (!bill.title && !bill.items.length && bill.people.length === 1) titleInput.focus();
}

function renderItem(bill, it, n, changed) {
  const lineEl = h('span', { class: 'muted line-total' });
  const updateLine = () => (lineEl.textContent = it.qty > 1 && it.price ? `= ${formatMoney(lineTotal(it))}` : '');
  updateLine();
  const allSelected = it.sharedBy.length === bill.people.length;

  const priceInput = h('input', {
    class: 'item-price', inputmode: 'decimal', placeholder: '₪ מחיר', value: moneyValue(it.price), 'aria-label': `מחיר פריט ${n + 1}`,
    oninput: (e) => {
      const v = parseMoney(e.target.value);
      e.target.classList.toggle('invalid', e.target.value !== '' && v == null);
      it.price = v ?? 0;
      updateLine();
      changed();
    },
    enterkeyhint: 'next',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Enter on the last price adds the next line, like typing down a receipt.
      if (bill.items[bill.items.length - 1] === it) document.querySelector('.add-item')?.click();
      else e.target.closest('.item').nextElementSibling?.querySelector('.item-name')?.focus();
    },
  });

  return h('li', { class: 'item' },
    h('div', { class: 'row' },
      h('input', {
        class: 'item-name', value: it.name, placeholder: `פריט ${n + 1}`, maxlength: 60, 'aria-label': `שם פריט ${n + 1}`,
        oninput: (e) => { it.name = e.target.value; changed(); },
        enterkeyhint: 'next',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); priceInput.focus(); } },
      }),
      priceInput,
      h('button', {
        class: 'icon-btn', 'aria-label': 'מחיקת פריט', title: 'מחיקה',
        onclick: () => { bill.items = bill.items.filter((x) => x !== it); changed(true); },
      }, '✕')
    ),
    h('div', { class: 'row item-meta' },
      h('span', { class: 'qty' },
        h('button', { class: 'qty-btn', 'aria-label': 'פחות', disabled: it.qty <= 1, onclick: () => { it.qty = Math.max(1, it.qty - 1); changed(true); } }, '−'),
        h('span', { class: 'qty-n', 'aria-label': 'כמות' }, `×${it.qty}`),
        h('button', { class: 'qty-btn', 'aria-label': 'יותר', onclick: () => { it.qty += 1; changed(true); } }, '+')),
      lineEl
    ),
    h('div', { class: 'chips small' },
      bill.people.length > 1 && h('button', {
        class: 'chip toggle all', 'aria-pressed': String(allSelected),
        onclick: () => { it.sharedBy = allSelected ? [] : bill.people.map((p) => p.id); changed(true); },
      }, 'כולם'),
      bill.people.map((p) =>
        h('button', {
          class: 'chip toggle', 'aria-pressed': String(it.sharedBy.includes(p.id)),
          onclick: () => {
            it.sharedBy = it.sharedBy.includes(p.id) ? it.sharedBy.filter((id) => id !== p.id) : [...it.sharedBy, p.id];
            changed(true);
          },
        }, p.name))
    )
  );
}

// ---------- Summary ----------

function shareUrl(bill) {
  return `${location.origin}${location.pathname}#/s/${encodeBill(bill)}`;
}

function payLine(bill) {
  const parts = [];
  if (bill.payerPhone) parts.push(`Bit / PayBox למספר ${bill.payerPhone}`);
  if (bill.payboxLink) parts.push(`PayBox: ${bill.payboxLink}`);
  return parts.join('\n');
}

function groupMessage(bill, r) {
  const payer = nameOf(bill, bill.payerId);
  const lines = [
    `💸 ${billTitle(bill)}`,
    `סה״כ ${formatMoney(r.total)}${r.tip ? ` (כולל טיפ ${bill.tipPercent}%)` : ''}`,
    '',
    ...r.shares.map((s) => `${s.name}: ${formatMoney(s.total)}${s.id === bill.payerId ? ' (שילם/ה)' : ''}`),
  ];
  if (payer) lines.push('', `מעבירים ל${payer}${bill.payerPhone || bill.payboxLink ? ':' : ''}`);
  const pl = payLine(bill);
  if (pl) lines.push(pl);
  lines.push('', `פירוט מלא: ${shareUrl(bill)}`);
  return lines.join('\n');
}

function personMessage(bill, s) {
  const payer = nameOf(bill, bill.payerId);
  const lines = [
    `היי ${s.name}, יצא לך ${formatMoney(s.total)} על ${billTitle(bill)}`,
    ...s.lines.map((l) => `• ${l.name || 'פריט'}${l.of > 1 ? ` (בין ${l.of})` : ''}: ${formatMoney(l.share)}`),
  ];
  if (s.tip) lines.push(`• טיפ: ${formatMoney(s.tip)}`);
  if (payer) lines.push('', `להעביר ל${payer}`);
  const pl = payLine(bill);
  if (pl) lines.push(pl);
  return lines.join('\n');
}

const whatsapp = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  window.open(whatsapp(text), '_blank', 'noopener');
}

function breakdown(s) {
  return h('ul', { class: 'breakdown' },
    s.lines.map((l) => h('li', {}, h('span', {}, l.name || 'פריט', l.of > 1 ? h('small', {}, ` · בין ${l.of}`) : null), h('span', {}, formatMoney(l.share)))),
    s.tip ? h('li', {}, h('span', {}, 'טיפ'), h('span', {}, formatMoney(s.tip))) : null);
}

function renderSummary(bill) {
  const r = computeSplit(bill);
  const payer = nameOf(bill, bill.payerId);
  const st = collectStatus(bill, r);

  const field = (label, key, profileKey, attrs) =>
    h('label', { class: 'field' }, h('span', {}, label),
      h('input', {
        ...attrs, value: bill[key],
        onchange: (e) => {
          bill[key] = e.target.value.trim();
          if (!profile[profileKey]) { profile[profileKey] = bill[key]; saveProfile(); }
          touch(bill);
          render();
        },
      }));

  mount(
    h('nav', { class: 'topbar' }, h('a', { href: `#/bill/${bill.id}`, class: 'back' }, '→ חזרה לעריכה')),
    h('header', { class: 'summary-head' },
      h('h1', {}, billTitle(bill)),
      h('div', { class: 'big-total' }, formatMoney(r.total)),
      h('p', { class: 'muted' }, [`${formatMoney(r.subtotal)} בחשבונית`, r.tip ? ` + ${formatMoney(r.tip)} טיפ` : '', payer ? ` · ${payer} שילם/ה` : ''].join(''))),
    payer === 'אני' && h('p', { class: 'warn' }, 'כדאי לשנות את "אני" לשם שלך בעריכה, כדי שהחברים ידעו למי להעביר.'),
    st.owing > 0 && h('p', { class: `collect${st.paid === st.owing ? ' done' : ''}` },
      st.paid === st.owing ? '✓ כולם העבירו. סגרנו!' : `נשאר לקבל ${formatMoney(st.left)} מ-${st.owing - st.paid} ${st.owing - st.paid === 1 ? 'אדם' : 'אנשים'}. מסמנים ✓ כשמישהו מעביר.`),
    r.unassigned.length > 0 && h('p', { class: 'warn' },
      `${r.unassigned.length === 1 ? 'פריט אחד לא סומן' : `${r.unassigned.length} פריטים לא סומנו`}, אז ${r.unassigned.length === 1 ? 'הוא מתחלק' : 'הם מתחלקים'} בין כולם.`),
    h('section', { class: 'people-sum' },
      r.shares.map((s) => {
        const isPayer = s.id === bill.payerId;
        const owes = !isPayer && s.total > 0 && !!payer;
        const paid = owes && !!bill.paid?.[s.id];
        return h('details', { class: `person-card${isPayer ? ' payer' : ''}${paid ? ' paid' : ''}` },
          h('summary', {},
            h('span', { class: 'person-name' }, s.name, isPayer ? h('small', {}, ' שילם/ה') : null),
            h('span', { class: 'amount' }, formatMoney(s.total)),
            owes && h('button', {
              class: 'paid-toggle', 'aria-pressed': String(paid),
              'aria-label': paid ? `${s.name} העביר/ה. לחיצה לביטול` : `לסמן ש${s.name} העביר/ה`,
              title: paid ? 'העביר/ה' : 'לסמן שהעביר/ה',
              onclick: (e) => {
                e.preventDefault();
                bill.paid = { ...bill.paid, [s.id]: !paid };
                touch(bill);
                const y = window.scrollY;
                render();
                window.scrollTo(0, y);
              },
            }, '✓')),
          breakdown(s),
          !isPayer && s.total > 0 && h('div', { class: 'row wrap' },
            h('a', { class: 'btn small whatsapp', href: whatsapp(personMessage(bill, s)), target: '_blank', rel: 'noopener' }, `שליחה ל${s.name} בוואטסאפ`),
            h('button', { class: 'btn small ghost', onclick: () => copy(personMessage(bill, s)) }, 'העתקה')));
      })),
    h('section', { class: 'card' },
      h('h2', {}, `לאן מעבירים${payer ? ` ל${payer}` : ''}?`),
      h('p', { class: 'hint' }, 'יופיע בהודעה ובקישור, כדי שכל אחד ידע לאן להעביר.'),
      field('טלפון ל-Bit / PayBox', 'payerPhone', 'phone', { type: 'tel', inputmode: 'tel', placeholder: '050-0000000' }),
      field('קישור PayBox (לא חובה)', 'payboxLink', 'paybox', { type: 'url', inputmode: 'url', placeholder: 'https://...' })),
    h('footer', { class: 'sticky stack' },
      h('button', { class: 'btn primary big', onclick: () => shareText(groupMessage(bill, r)) }, 'שיתוף לקבוצה'),
      h('button', { class: 'btn ghost', onclick: () => copy(shareUrl(bill), 'הקישור הועתק') }, 'העתקת קישור לפירוט'))
  );
}

// ---------- Shared link (what friends see) ----------

function renderShared(payload) {
  let bill;
  try {
    bill = decodeBill(payload);
  } catch {
    mount(h('section', { class: 'card center' }, h('h1', {}, 'הקישור לא תקין'), h('p', {}, 'אולי הוא נחתך בהעתקה. בקשו קישור חדש ממי ששילם.'), h('a', { class: 'btn primary', href: '#/' }, 'ל-EasyPay')));
    return;
  }
  const r = computeSplit(bill);
  const payer = nameOf(bill, bill.payerId);
  const meKey = `easypay.me.${payload.slice(0, 32)}`;
  const meId = sessionGet(meKey);
  const me = r.shares.find((s) => s.id === meId);

  const pick = h('section', { class: 'card' },
    h('h2', {}, me ? 'לא את/ה?' : 'מי את/ה?'),
    h('div', { class: 'chips' }, r.shares.map((s) =>
      h('button', {
        class: 'chip toggle', 'aria-pressed': String(s.id === meId),
        onclick: () => { sessionSet(meKey, s.id); render(); },
      }, s.name))));

  const mine = me && h('section', { class: 'card mine' },
    h('p', { class: 'muted' }, `${me.name}, החלק שלך`),
    h('div', { class: 'big-total' }, formatMoney(me.total)),
    breakdown(me),
    me.id === bill.payerId
      ? h('p', { class: 'hint' }, 'את/ה שילמת, אז מחכים לשאר.')
      : h('div', { class: 'stack' },
          payer && h('p', {}, `מעבירים ל${payer}`),
          bill.payerPhone && h('button', { class: 'btn primary', onclick: () => copy(bill.payerPhone, 'המספר הועתק, אפשר להדביק ב-Bit') }, `העתקת המספר ${bill.payerPhone}`),
          bill.payboxLink && h('a', { class: 'btn ghost', href: bill.payboxLink, target: '_blank', rel: 'noopener noreferrer' }, 'פתיחת PayBox'),
          h('button', { class: 'btn ghost', onclick: () => copy(String(me.total / 100), 'הסכום הועתק') }, `העתקת הסכום ${formatMoney(me.total)}`),
          payer && h('a', {
            class: 'btn whatsapp', target: '_blank', rel: 'noopener',
            href: whatsapp(`היי ${payer}, העברתי לך ${formatMoney(me.total)} על ${billTitle(bill)} 👍`),
          }, `העברתי! לעדכן את ${payer}`)));

  mount(
    h('header', { class: 'summary-head' },
      h('div', { class: 'logo' }, 'EasyPay'),
      h('h1', {}, billTitle(bill)),
      h('p', { class: 'muted' }, [formatDate(bill.date), payer ? `${payer} שילם/ה ${formatMoney(r.total)}` : formatMoney(r.total)].filter(Boolean).join(' · '))),
    mine || null,
    pick,
    h('details', { class: 'card' },
      h('summary', {}, 'כל החלוקה'),
      h('ul', { class: 'breakdown' }, r.shares.map((s) => h('li', {}, h('span', {}, s.name), h('span', {}, formatMoney(s.total)))))),
    h('p', { class: 'hint center' }, 'משהו לא נכון? כתבו ל', payer || 'מי ששילם', ' ובקשו קישור מתוקן.'),
    h('div', { class: 'center' }, h('button', {
      class: 'btn ghost small',
      onclick: () => {
        const copyBill = { ...bill, id: uid(), updatedAt: Date.now() };
        bills.unshift(copyBill);
        saveBills();
        go(`#/bill/${copyBill.id}`);
      },
    }, 'שמירה אצלי ועריכה'))
  );
}

// ---------- Boot ----------

render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
