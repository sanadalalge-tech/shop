/* منطق المنظومة المشترك: يعمل في المتصفح وفي Apps Script وفي الاختبارات.
   المبدأ: سجل عمليات (ops) لا يُعدَّل أبدًا، والحالة كلها تُشتق منه بإعادة التشغيل.
   المبالغ والكميات أعداد صحيحة بوحدة "ألف" (milli) لتفادي أخطاء الفاصلة العشرية. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MILLI = 1000;
  const VERSION = 1;

  const ROLES = { owner: 'المالك', manager: 'مشرف', sales: 'مبيعات', warehouse: 'مخزن وتعبئة', accountant: 'محاسب', ads: 'مسؤول إعلانات' };
  const STATUS = { new: 'جديد', confirmed: 'مؤكد', shipped: 'مع المندوب', delivered: 'مستلم', rejected: 'مرفوض', cancelled: 'ملغي', returned: 'مرتجع' };
  const TRANSITIONS = { new: ['confirmed', 'shipped', 'cancelled'], confirmed: ['shipped', 'cancelled'], shipped: ['delivered', 'rejected'], delivered: ['returned'] };
  const EXP_CATS = { sponsored: 'إعلانات ممولة', influencer: 'مشاهير ومؤثرون', ads_other: 'إعلانات أخرى', delivery: 'تكلفة التوصيل', delivery_loss: 'خسارة توصيل مرفوض', gift: 'هدايا', salary: 'رواتب وعمولات', rent: 'إيجار وخدمات', other: 'أخرى' };
  const GIFT_KINDS = { influencer: 'مشهور / مؤثر', customer: 'زبون', sample: 'عينة', other: 'أخرى' };
  const AD_CATS = ['sponsored', 'influencer', 'ads_other'];
  const MAT_CATS = { alcohol: 'كحول', oil: 'زيوت عطرية', glass: 'زجاج', box: 'بوكس', sticker: 'ستيكر', bag: 'أكياس', other: 'أخرى' };
  const UNITS = { ml: 'مل', g: 'جرام', pcs: 'قطعة' };
  const MASTER = ['user_upsert', 'settings_set', 'material_upsert', 'product_upsert'];
  const WD_CATS = { food: 'أكل وشرب', clothes: 'ملابس', transport: 'مواصلات', family: 'عائلة ومنزل', other: 'أخرى' };
  const OP_TYPES = ['user_upsert', 'settings_set', 'material_upsert', 'product_upsert', 'purchase', 'production', 'order_create', 'order_status', 'order_edit', 'payment', 'expense', 'adjust', 'gift', 'withdrawal', 'coupon_upsert', 'bundle_upsert', 'debt_add', 'debt_pay', 'void'];

  const PERMS = {
    owner: null,
    manager: OP_TYPES.filter(t => t !== 'user_upsert' && t !== 'settings_set' && t !== 'withdrawal'),
    sales: ['order_create', 'order_status', 'order_edit', 'payment'],
    warehouse: ['purchase', 'production', 'adjust', 'material_upsert', 'order_status', 'order_edit'],
    accountant: ['expense', 'payment', 'debt_pay'],
    ads: ['expense']
  };
  const STATUS_BY_ROLE = { sales: ['confirmed', 'cancelled', 'delivered', 'rejected'], warehouse: ['shipped', 'returned'] };

  function can(role, type) {
    if (!(role in PERMS)) return false;
    return PERMS[role] === null || PERMS[role].indexOf(type) >= 0;
  }
  function canOp(role, op) {
    if (!can(role, op.type)) return false;
    if (op.type === 'order_status' && STATUS_BY_ROLE[role]) return STATUS_BY_ROLE[role].indexOf(op.p.status) >= 0;
    return true;
  }

  // ---------- أدوات ----------
  function uid() {
    const c = typeof crypto !== 'undefined' && crypto.randomUUID;
    if (c) return crypto.randomUUID();
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
  }
  function normDigits(s) {
    return String(s).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6f0)
      .replace(/[٫,]/g, '.').replace(/[٬\s]/g, '');
  }
  function toM(v) {
    if (v === '' || v == null) return NaN;
    const n = typeof v === 'number' ? v : Number(normDigits(v));
    return isFinite(n) ? Math.round(n * MILLI) : NaN;
  }
  function fromM(m) { return m / MILLI; }
  function toLyd(amt, currency, rate) {
    return currency === 'USD' ? Math.round(amt * rate / MILLI) : amt;
  }
  function toUsd(lyd, rate) { return rate > 0 ? lyd / rate : 0; }
  function fmtNum(m, max) {
    const n = m / MILLI;
    return n.toLocaleString('en-US', { maximumFractionDigits: max == null ? 3 : max });
  }
  function sum(arr, f) { let t = 0; for (const x of arr) t += f(x); return t; }
  const cmp = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /*@client-start*/
  // SHA-256 نقي (لا يحتاج سياقًا آمنًا) لتجزئة الرمز السري
  function sha256(str) {
    const bytes = [];
    const u = unescape(encodeURIComponent(str));
    for (let i = 0; i < u.length; i++) bytes.push(u.charCodeAt(i));
    const primes = [];
    for (let n = 2; primes.length < 64; n++) { let ok = true; for (const p of primes) { if (p * p > n) break; if (n % p === 0) { ok = false; break; } } if (ok) primes.push(n); }
    const frac = x => Math.floor((x - Math.floor(x)) * 4294967296);
    const K = primes.map(p => frac(Math.cbrt(p)));
    const H = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    for (const w of [hi, lo]) bytes.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      const w = new Array(64);
      for (let i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => ('00000000' + (x >>> 0).toString(16)).slice(-8)).join('');
  }
  function hashPin(pin, salt) { return sha256(salt + ':' + pin); }

  /*@client-end*/

  // ---------- الحالة ----------
  function emptyState() {
    return { settings: { rate: 0, brand: '' }, users: {}, materials: {}, products: {}, orders: {}, expenses: [], adjustments: [], gifts: [], withdrawals: [], coupons: {}, bundles: {}, debts: {}, payments: [], movements: [], alerts: [], opsCount: 0 };
  }
  function take(o, k, n) {
    const have = o[k];
    if (have > 0 && o.value > 0) o.lastUnit = o.value / have;
    let cost;
    if (have <= 0) cost = 0; else if (n >= have) cost = o.value; else cost = Math.round(o.value * n / have);
    o.value -= cost; o[k] = have - n;
    if (o[k] === 0) o.value = 0;
    return cost;
  }
  function put(o, k, n, cost) { o[k] += n; o.value += cost; if (o[k] > 0 && o.value > 0) o.lastUnit = o.value / o[k]; }
  function recipeCost(S, product) {
    let t = 0;
    for (const l of product.recipe || []) {
      const m = S.materials[l.materialId];
      if (m && m.qty > 0) t += Math.round(m.value * l.qty / m.qty);
      else if (m && m.lastUnit > 0) t += Math.round(m.lastUnit * l.qty);
    }
    return t;
  }
  function orderTotals(o) {
    const items = sum(o.items, i => i.qty * i.price);
    return { itemsTotal: items, total: items - (o.discount || 0) + (o.deliveryFee || 0) };
  }

  const normCode = c => String(c == null ? '' : c).trim().toUpperCase().replace(/\s+/g, '');
  const DEAD = { cancelled: 1, rejected: 1 };
  function couponUses(S, code) { return Object.values(S.orders).filter(o => o.coupon === code && !DEAD[o.status]).length; }
  // يفحص الكود ويحسب الخصم على إجمالي المنتجات (بالميلي). ignoreOrder: لا يحتسب طلبًا بعينه عند العدّ
  function couponCheck(S, code, itemsTotal, date) {
    const c = S.coupons[normCode(code)];
    if (!c) return { ok: false, err: 'كود الخصم غير موجود' };
    if (!c.active) return { ok: false, err: 'كود الخصم موقوف' };
    if (c.expires && date > c.expires) return { ok: false, err: 'انتهت صلاحية الكود في ' + c.expires };
    if (c.maxUses > 0 && couponUses(S, c.code) >= c.maxUses) return { ok: false, err: 'استُنفد عدد استخدامات الكود' };
    const discount = c.type === 'pct' ? Math.round(itemsTotal * c.value / 100000) : Math.min(c.value, itemsTotal);
    return { ok: true, discount, coupon: c };
  }

  // كل الهدايا: من بنود «هدية» في الطلبات + الهدايا المسجّلة بالطريقة القديمة
  function giftRows(S) {
    const rows = [];
    for (const o of Object.values(S.orders)) {
      if (DEAD[o.status] || o.status === 'returned') continue;
      for (const it of o.items) if (it.gift) rows.push({ date: o.date, ts: o.ts, to: o.customer.name, name: it.name, qty: it.qty, cost: it.cogs || 0, note: o.code, by: o.by });
    }
    for (const g of S.gifts) rows.push({ date: g.date, ts: g.ts, to: g.to, name: g.name, qty: g.qty, cost: g.cost, note: g.note || '', by: g.by });
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts));
  }

  // ---------- العملاء (مشتقّون من الطلبات، يُعرَّف العميل برقم هاتفه) ----------
  function phoneKey(p) { const d = normDigits(String(p || '')).replace(/\D/g, ''); return d.length > 9 ? d.slice(-9) : d; }
  function customers(S) {
    const map = {};
    for (const o of Object.values(S.orders).sort((a, b) => a.ts - b.ts)) {
      const c = o.customer, k = phoneKey(c.phone);
      if (!k) continue;
      const r = map[k] || (map[k] = { key: k, name: '', phone: '', phone2: '', city: '', area: '', address: '', orders: [], n: 0, delivered: 0, rejected: 0, cancelled: 0, returned: 0, spent: 0, first: o.date, last: o.date });
      r.name = c.name || r.name; r.phone = c.phone; r.phone2 = c.phone2 || r.phone2; r.city = c.city || r.city; r.area = c.area || r.area; r.address = c.address || r.address;
      r.orders.push(o.id); r.n++; r.last = o.date > r.last ? o.date : r.last;
      if (o.status === 'delivered') { r.delivered++; r.spent += o.total; }
      else if (o.status === 'rejected') r.rejected++;
      else if (o.status === 'cancelled') r.cancelled++;
      else if (o.status === 'returned') r.returned++;
    }
    return map;
  }
  function customerRisk(S, phone) {
    const r = customers(S)[phoneKey(phone)];
    if (!r) return { level: 'new', msg: '' };
    const bad = r.rejected + r.returned;
    if (bad >= 2 && bad >= r.delivered) return { level: 'high', msg: 'تحذير: هذا العميل رفض/أرجع ' + bad + ' طلبات سابقة وتسلّم ' + r.delivered, rec: r };
    if (bad >= 1) return { level: 'warn', msg: 'تنبيه: رفض/أرجع هذا العميل ' + bad + ' طلب سابقًا (تسلّم ' + r.delivered + ')', rec: r };
    if (r.delivered >= 1) return { level: 'repeat', msg: 'عميل سابق: تسلّم ' + r.delivered + ' طلب', rec: r };
    return { level: 'known', msg: 'لهذا الرقم طلب سابق قيد المعالجة', rec: r };
  }
  // ---------- نقص المخزون: الحد اليدوي + الاستهلاك الفعلي آخر 30 يومًا ----------
  function lowStock(S, today) {
    const from = new Date(today + 'T00:00:00Z'); from.setUTCDate(from.getUTCDate() - 30);
    const f = from.toISOString().slice(0, 10), use = {};
    for (const m of S.movements) if (m.date >= f && (m.kind === 'consume' || m.kind === 'ship') && m.qty < 0) use[m.type + ':' + m.id] = (use[m.type + ':' + m.id] || 0) - m.qty;
    const out = [];
    for (const m of Object.values(S.materials)) {
      if (m.active === false) continue;
      const daily = (use['material:' + m.id] || 0) / 30, days = daily > 0 ? m.qty / daily : Infinity;
      const manual = m.min > 0 && m.qty <= m.min, auto = m.qty > 0 && days <= 14;
      if (m.qty <= 0 && daily > 0 || manual || auto) out.push({ type: 'material', id: m.id, name: m.name, qty: m.qty, unit: m.unit, days: isFinite(days) ? Math.floor(days) : null, why: m.qty <= 0 ? 'نفدت' : manual ? 'تحت الحد' : 'تكفي ' + Math.floor(days) + ' يومًا' });
    }
    for (const p of Object.values(S.products)) {
      if (p.active === false) continue;
      const daily = (use['product:' + p.id] || 0) / 30, days = daily > 0 ? p.stock / daily : Infinity;
      if (daily > 0 && (p.stock <= 0 || days <= 10)) out.push({ type: 'product', id: p.id, name: p.name, qty: p.stock, unit: 'pcs', days: isFinite(days) ? Math.floor(days) : null, why: p.stock <= 0 ? 'نفد' : 'يكفي ' + Math.floor(days) + ' أيام' });
    }
    return out.sort((a, b) => (a.days == null ? -1 : a.days) - (b.days == null ? -1 : b.days));
  }
  function debtInfo(S, today) {
    const list = Object.values(S.debts).map(d => Object.assign({}, d, { rem: d.lyd - d.paid, overdue: !!d.due && d.due < today && d.lyd - d.paid > 0, soon: !!d.due && d.due >= today && d.due <= (function () { const t = new Date(today + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 3); return t.toISOString().slice(0, 10); })() && d.lyd - d.paid > 0 }));
    const open = list.filter(d => d.rem > 0);
    return { list, owedToUs: sum(open.filter(d => d.dir === 'in'), d => d.rem), weOwe: sum(open.filter(d => d.dir === 'out'), d => d.rem), overdue: open.filter(d => d.overdue), soon: open.filter(d => d.soon) };
  }

  function apply(S, op) {
    const p = op.p, d = op.date, add = (lvl, msg) => S.alerts.push({ lvl, msg, op: op.id });
    switch (op.type) {
      case 'user_upsert': S.users[p.id] = Object.assign({}, S.users[p.id], p); break;
      case 'settings_set': Object.assign(S.settings, p); break;
      case 'material_upsert': {
        const m = S.materials[p.id] || { qty: 0, value: 0 };
        S.materials[p.id] = Object.assign(m, { id: p.id, name: p.name, unit: p.unit, cat: p.cat, min: p.min || 0, active: p.active !== false });
        break;
      }
      case 'product_upsert': {
        const pr = S.products[p.id] || { stock: 0, value: 0 };
        S.products[p.id] = Object.assign(pr, { id: p.id, name: p.name, sizeMl: p.sizeMl || 0, price: p.price, recipe: p.recipe || [], oil: p.oil || null, active: p.active !== false });
        break;
      }
      case 'purchase': {
        const m = S.materials[p.materialId];
        if (!m) return add('err', 'شراء لمادة غير موجودة');
        const lyd = toLyd(p.amt, p.currency, p.rate);
        put(m, 'qty', p.qty, lyd);
        S.movements.push({ ts: op.ts, date: d, kind: 'purchase', type: 'material', id: m.id, name: m.name, qty: p.qty, value: lyd, note: p.supplier || '' });
        if (p.paid !== undefined && p.paid !== null && p.paid < p.amt) {
          const due = toLyd(p.amt - p.paid, p.currency, p.rate);
          S.debts[op.id + ':d'] = { id: op.id + ':d', dir: 'out', kind: 'supplier', party: String(p.supplier || 'مورد').trim() || 'مورد', lyd: due, cur: p.currency, orig: p.amt - p.paid, due: p.due || '', note: 'شراء ' + m.name, date: d, ts: op.ts, by: op.by, paid: 0, payments: [], auto: true };
        }
        break;
      }
      case 'production': {
        const pr = S.products[p.productId];
        if (!pr) return add('err', 'تعبئة لمنتج غير موجود');
        let total = 0;
        for (const l of (p.recipe || pr.recipe)) {
          const m = S.materials[l.materialId];
          if (!m) { add('err', 'مادة محذوفة داخل تركيبة ' + pr.name); continue; }
          const need = l.qty * p.units;
          if (m.qty < need) add('err', 'مخزون ' + m.name + ' لا يكفي لتعبئة ' + pr.name);
          const c = take(m, 'qty', need);
          total += c;
          S.movements.push({ ts: op.ts, date: d, kind: 'consume', type: 'material', id: m.id, name: m.name, qty: -need, value: -c, note: 'تعبئة ' + pr.name });
        }
        put(pr, 'stock', p.units, total);
        S.movements.push({ ts: op.ts, date: d, kind: 'produce', type: 'product', id: pr.id, name: pr.name, qty: p.units, value: total, note: p.note || '' });
        break;
      }
      case 'order_create': {
        const items = p.items.map(i => ({ productId: i.productId, qty: i.qty, gift: !!i.gift, price: i.gift ? 0 : i.price, name: (S.products[i.productId] || {}).name || '؟', cogs: 0 }));
        S.orders[p.id] = { id: p.id, code: p.code, date: d, ts: op.ts, by: op.by, customer: p.customer, items, discount: p.discount || 0, coupon: p.coupon ? normCode(p.coupon) : '', discountPct: p.discountPct || 0, campaign: p.campaign ? String(p.campaign).trim() : '', bundles: p.bundles || [], deliveryFee: p.deliveryFee || 0, courierCost: p.courierCost || 0, courierCode: p.courierCode || '', channel: p.channel || '', payMethod: p.payMethod || 'cod', note: p.note || '', status: 'new', history: [{ status: 'new', date: d, by: op.by }], paid: 0, cogs: 0 };
        break;
      }
      case 'order_status': {
        const o = S.orders[p.orderId];
        if (!o) return add('err', 'تغيير حالة لطلب غير موجود');
        if ((TRANSITIONS[o.status] || []).indexOf(p.status) < 0) return add('warn', 'تم تجاهل تغيير حالة غير صالح للطلب ' + o.code + ' (' + STATUS[o.status] + ' ← ' + STATUS[p.status] + ')');
        if (p.status === 'shipped') {
          for (const it of o.items) {
            const pr = S.products[it.productId];
            if (!pr) { add('err', 'منتج محذوف في الطلب ' + o.code); continue; }
            if (pr.stock < it.qty) add('err', 'مخزون ' + pr.name + ' لا يكفي للطلب ' + o.code);
            it.cogs = take(pr, 'stock', it.qty);
            S.movements.push({ ts: op.ts, date: d, kind: 'ship', type: 'product', id: pr.id, name: pr.name, qty: -it.qty, value: -it.cogs, note: o.code });
          }
          o.cogs = sum(o.items, i => i.cogs);
        }
        if (p.status === 'rejected' || p.status === 'returned' || (p.status === 'cancelled' && o.status === 'shipped')) {
          for (const it of o.items) {
            const pr = S.products[it.productId];
            if (!pr) continue;
            put(pr, 'stock', it.qty, it.cogs);
            S.movements.push({ ts: op.ts, date: d, kind: 'restock', type: 'product', id: pr.id, name: pr.name, qty: it.qty, value: it.cogs, note: o.code });
          }
          o.cogs = 0;
        }
        if (p.status === 'delivered') {
          o.deliveredDate = d;
          if (o.courierCost > 0) S.expenses.push({ id: op.id + ':c', date: d, cat: 'delivery', lyd: o.courierCost, note: 'طلب ' + o.code, auto: true });
        }
        if (p.status === 'rejected') {
          o.rejectedDate = d;
          if (p.lossFee > 0) S.expenses.push({ id: op.id + ':l', date: d, cat: 'delivery_loss', lyd: p.lossFee, note: 'طلب ' + o.code, auto: true });
        }
        o.status = p.status;
        o.history.push({ status: p.status, date: d, by: op.by, note: p.note || '' });
        break;
      }
      case 'order_edit': {
        const o = S.orders[p.orderId];
        if (!o) return add('err', 'تعديل لطلب غير موجود');
        if (typeof p.courierCode === 'string') o.courierCode = p.courierCode;
        break;
      }
      case 'payment': {
        const o = S.orders[p.orderId];
        if (!o) return add('err', 'دفعة لطلب غير موجود');
        o.paid += p.amt;
        S.payments.push({ id: op.id, date: d, orderId: o.id, code: o.code, amt: p.amt, method: p.method || '' });
        break;
      }
      case 'expense': {
        S.expenses.push({ id: op.id, date: d, cat: p.cat, lyd: toLyd(p.amt, p.currency, p.rate), cur: p.currency, orig: p.amt, note: p.note || '', campaign: p.campaign ? String(p.campaign).trim() : '', by: op.by });
        break;
      }
      case 'bundle_upsert': {
        S.bundles[p.id] = { id: p.id, name: String(p.name).trim(), items: p.items, price: p.price, active: p.active !== false };
        break;
      }
      case 'debt_add': {
        S.debts[p.id] = { id: p.id, dir: p.dir, kind: p.kind || 'other', party: String(p.party).trim(), lyd: toLyd(p.amt, p.currency, p.rate), cur: p.currency || 'LYD', orig: p.amt, due: p.due || '', note: p.note || '', date: d, ts: op.ts, by: op.by, paid: 0, payments: [] };
        break;
      }
      case 'debt_pay': {
        const db = S.debts[p.debtId];
        if (!db) return add('err', 'دفعة لدين غير موجود');
        const v = toLyd(p.amt, p.currency, p.rate);
        db.paid += v; db.payments.push({ id: op.id, date: d, lyd: v, note: p.note || '', by: op.by });
        break;
      }
      case 'coupon_upsert': {
        const code = normCode(p.code), old = S.coupons[code] || {};
        S.coupons[code] = { code, type: p.type, value: p.value, expires: p.expires || '', maxUses: p.maxUses || 0, active: p.active !== false, note: p.note || '', created: old.created || d };
        break;
      }
      case 'withdrawal': {
        S.withdrawals.push({ id: op.id, date: d, ts: op.ts, by: op.by, cat: p.cat, lyd: toLyd(p.amt, p.currency, p.rate), cur: p.currency, orig: p.amt, note: p.note || '' });
        break;
      }
      case 'gift': {
        const pr = S.products[p.productId];
        if (!pr) return add('err', 'هدية لمنتج غير موجود');
        if (pr.stock < p.qty) add('err', 'مخزون ' + pr.name + ' لا يكفي للهدية');
        const cost = take(pr, 'stock', p.qty);
        S.movements.push({ ts: op.ts, date: d, kind: 'gift', type: 'product', id: pr.id, name: pr.name, qty: -p.qty, value: -cost, note: 'هدية: ' + p.to });
        S.expenses.push({ id: op.id + ':g', date: d, cat: 'gift', lyd: cost, note: p.to + ' — ' + pr.name + ' ×' + p.qty, auto: true });
        S.gifts.push({ id: op.id, date: d, ts: op.ts, by: op.by, productId: pr.id, name: pr.name, qty: p.qty, cost, to: String(p.to).trim(), kind: p.kind || 'other', note: p.note || '' });
        break;
      }
      case 'adjust': {
        const isMat = p.target === 'material';
        const it = isMat ? S.materials[p.id] : S.products[p.id];
        if (!it) return add('err', 'تسوية لصنف غير موجود');
        const k = isMat ? 'qty' : 'stock';
        if (p.opening && !isMat && p.delta > 0) {
          const v0 = Math.round((p.unitCost || 0) * p.delta);
          put(it, k, p.delta, v0);
          S.movements.push({ ts: op.ts, date: d, kind: 'opening', type: 'product', id: it.id, name: it.name, qty: p.delta, value: v0, note: p.reason || 'رصيد افتتاحي' });
          break;
        }
        let val;
        if (p.delta < 0) val = -take(it, k, -p.delta);
        else { const avg = it[k] > 0 ? it.value / it[k] : 0; val = Math.round(avg * p.delta); put(it, k, p.delta, val); }
        S.adjustments.push({ date: d, target: p.target, id: p.id, name: it.name, delta: p.delta, value: val, reason: p.reason });
        S.movements.push({ ts: op.ts, date: d, kind: 'adjust', type: isMat ? 'material' : 'product', id: it.id, name: it.name, qty: p.delta, value: val, note: p.reason });
        break;
      }
    }
  }

  function reduce(ops) {
    const voidOps = ops.filter(o => o.type === 'void');
    const targeted = new Set(voidOps.map(v => v.p.target));
    const effective = voidOps.filter(v => !targeted.has(v.id));
    const voided = new Set(effective.map(v => v.p.target));
    const S = emptyState();
    S.opsCount = ops.length;
    S.voided = voided;
    // البيانات الأساسية تُطبَّق أولًا حتى لا يضيع أثر عملية بسبب فرق ساعة بين جهازين
    const live = ops.filter(o => o.type !== 'void' && !voided.has(o.id));
    const master = live.filter(o => MASTER.indexOf(o.type) >= 0).sort(cmp);
    const trans = live.filter(o => MASTER.indexOf(o.type) < 0).sort(cmp);
    for (const op of master.concat(trans)) {
      try { apply(S, op); } catch (e) { S.alerts.push({ lvl: 'err', msg: 'خطأ في معالجة عملية: ' + e.message, op: op.id }); }
    }
    for (const o of Object.values(S.orders)) Object.assign(o, orderTotals(o));
    for (const m of Object.values(S.materials)) {
      if (m.active === false) continue;
      if (m.qty < 0) S.alerts.push({ lvl: 'err', msg: 'رصيد سالب: ' + m.name });
      else if (m.min > 0 && m.qty <= m.min) S.alerts.push({ lvl: 'warn', msg: 'مخزون منخفض: ' + m.name, low: true });
    }
    for (const pr of Object.values(S.products)) if (pr.stock < 0) S.alerts.push({ lvl: 'err', msg: 'رصيد سالب: ' + pr.name });
    return S;
  }

  /*@client-start*/
  // التعبئة تحفظ نسخة من التركيبة وقت التنفيذ كي لا تتغير التكلفة التاريخية إذا عُدِّلت التركيبة لاحقًا
  function productionPayload(S, productId, units, note) {
    const pr = S.products[productId];
    return { productId, units, note: note || '', recipe: pr ? pr.recipe.map(l => ({ materialId: l.materialId, qty: l.qty })) : [] };
  }

  // ---------- التحقق قبل التسجيل ----------
  function validate(S, op) {
    const p = op.p;
    const pos = (v, n) => Number.isFinite(v) && v > 0 ? null : 'قيمة غير صحيحة: ' + n;
    let e;
    switch (op.type) {
      case 'user_upsert': return !p.name ? 'اسم المستخدم مطلوب' : !ROLES[p.role] ? 'دور غير صحيح' : !p.hash ? 'الرمز السري مطلوب' : null;
      case 'settings_set': return p.rate !== undefined && !(p.rate > 0) ? 'سعر الصرف يجب أن يكون أكبر من صفر' : null;
      case 'material_upsert': return !p.name ? 'اسم المادة مطلوب' : !UNITS[p.unit] ? 'وحدة غير صحيحة' : !MAT_CATS[p.cat] ? 'تصنيف غير صحيح' : null;
      case 'product_upsert':
        if (!p.name) return 'اسم المنتج مطلوب';
        if (!(p.price >= 0)) return 'السعر غير صحيح';
        for (const l of (p.recipe || [])) { if (!S.materials[l.materialId]) return 'مادة غير موجودة في التركيبة'; if (!(l.qty > 0)) return 'كمية مكوّن غير صحيحة'; }
        return null;
      case 'purchase':
        if (p.paid !== undefined && p.paid !== null && !(p.paid >= 0 && p.paid <= p.amt)) return 'المبلغ المدفوع غير صحيح';
        if (!S.materials[p.materialId]) return 'اختر المادة';
        if ((e = pos(p.qty, 'الكمية')) || (e = pos(p.amt, 'المبلغ'))) return e;
        return p.currency === 'USD' && !(p.rate > 0) ? 'سعر الصرف مطلوب' : null;
      case 'production': {
        const pr = S.products[p.productId];
        if (!pr) return 'اختر المنتج';
        if (!Number.isInteger(p.units) || p.units <= 0) return 'عدد الوحدات يجب أن يكون عددًا صحيحًا موجبًا';
        for (const l of (p.recipe || pr.recipe)) {
          const m = S.materials[l.materialId];
          if (!m) return 'مادة محذوفة في التركيبة';
          const need = l.qty * p.units;
          if (m.qty < need) return 'مخزون «' + m.name + '» لا يكفي: المتاح ' + fmtNum(m.qty) + ' والمطلوب ' + fmtNum(need) + ' ' + UNITS[m.unit];
        }
        return null;
      }
      case 'order_create':
        const allGift = !!(p.items && p.items.length) && p.items.every(i => i.gift);
        if (!p.customer || !p.customer.name) return allGift ? 'اكتب اسم المستلم' : 'اسم العميل ورقم هاتفه مطلوبان';
        if (!allGift && !p.customer.phone) return 'اسم العميل ورقم هاتفه مطلوبان';
        if (!allGift && !p.customer.city) return 'المدينة مطلوبة';
        if (!p.items || !p.items.length) return 'أضف منتجًا واحدًا على الأقل';
        for (const i of p.items) {
          if (!S.products[i.productId]) return 'منتج غير موجود';
          if (!Number.isInteger(i.qty) || i.qty <= 0) return 'الكمية يجب أن تكون عددًا صحيحًا موجبًا';
          if (!i.gift && !(i.price >= 0)) return 'سعر غير صحيح';
        }
        if (p.coupon) {
          const it = sum(p.items, i => i.gift ? 0 : i.qty * i.price), ck = couponCheck(S, p.coupon, it, op.date);
          if (!ck.ok) return ck.err;
          if (Math.abs((p.discount || 0) - ck.discount) > 1) return 'قيمة الخصم لا تطابق الكود';
        } else if ((p.discount || 0) > 0 && ((S.users[op.by] || {}).role === 'sales')) return 'الخصم اليدوي للمالك والمدير فقط. استخدم كود خصم';
        return orderTotals({ items: p.items.map(i => ({ qty: i.qty, price: i.gift ? 0 : i.price })), discount: p.discount, deliveryFee: p.deliveryFee }).total < 0 ? 'الخصم أكبر من قيمة الطلب' : null;
      case 'order_status': {
        const o = S.orders[p.orderId];
        if (!o) return 'الطلب غير موجود';
        if ((TRANSITIONS[o.status] || []).indexOf(p.status) < 0) return 'لا يمكن الانتقال من «' + STATUS[o.status] + '» إلى «' + STATUS[p.status] + '»';
        if (p.status === 'shipped') for (const it of o.items) { const pr = S.products[it.productId]; if (!pr || pr.stock < it.qty) return 'مخزون «' + (pr ? pr.name : '؟') + '» لا يكفي: المتاح ' + (pr ? pr.stock : 0) + ' والمطلوب ' + it.qty; }
        return null;
      }
      case 'order_edit':
        if (!S.orders[p.orderId]) return 'الطلب غير موجود';
        return typeof p.courierCode === 'string' && p.courierCode.length > 60 ? 'كود التوصيل طويل جدًا' : null;
      case 'payment': {
        const o = S.orders[p.orderId];
        if (!o) return 'الطلب غير موجود';
        if ((e = pos(p.amt, 'المبلغ'))) return e;
        return p.amt > o.total - o.paid ? 'المبلغ أكبر من المتبقي (' + fmtNum(o.total - o.paid) + ')' : null;
      }
      case 'bundle_upsert':
        if (!String(p.name || '').trim()) return 'اسم الباقة مطلوب';
        if (!Array.isArray(p.items) || !p.items.length) return 'أضف عطرًا واحدًا على الأقل للباقة';
        for (const i of p.items) { if (!S.products[i.productId]) return 'عطر غير موجود في الباقة'; if (!Number.isInteger(i.qty) || i.qty <= 0) return 'كمية غير صحيحة في الباقة'; }
        return pos(p.price, 'سعر الباقة');
      case 'debt_add':
        if (p.dir !== 'in' && p.dir !== 'out') return 'اختر اتجاه الدين';
        if (!String(p.party || '').trim()) return 'اكتب اسم الطرف';
        if ((e = pos(p.amt, 'المبلغ'))) return e;
        return p.currency === 'USD' && !(p.rate > 0) ? 'سعر الصرف مطلوب' : null;
      case 'debt_pay': {
        const db = S.debts[p.debtId];
        if (!db) return 'الدين غير موجود';
        if ((e = pos(p.amt, 'المبلغ'))) return e;
        if (p.currency === 'USD' && !(p.rate > 0)) return 'سعر الصرف مطلوب';
        return toLyd(p.amt, p.currency, p.rate) > db.lyd - db.paid + 1 ? 'المبلغ أكبر من المتبقي (' + fmtNum(db.lyd - db.paid) + ')' : null;
      }
      case 'coupon_upsert': {
        const code = normCode(p.code);
        if (!code) return 'اكتب الكود';
        if (!/^[A-Z0-9\u0621-\u064A_-]+$/.test(code)) return 'الكود حروف وأرقام فقط بلا رموز';
        if (p.type !== 'pct' && p.type !== 'amt') return 'اختر نوع الخصم';
        if ((e = pos(p.value, 'قيمة الخصم'))) return e;
        if (p.type === 'pct' && p.value > 100000) return 'النسبة لا تزيد عن 100%';
        if (!Number.isInteger(p.maxUses || 0) || (p.maxUses || 0) < 0) return 'عدد الاستخدامات غير صحيح';
        return p.expires && !/^\d{4}-\d{2}-\d{2}$/.test(p.expires) ? 'تاريخ الانتهاء غير صحيح' : null;
      }
      case 'withdrawal':
        if (!WD_CATS[p.cat]) return 'اختر نوع المسحوب';
        if ((e = pos(p.amt, 'المبلغ'))) return e;
        return p.currency === 'USD' && !(p.rate > 0) ? 'سعر الصرف مطلوب' : null;
      case 'expense':
        if (!EXP_CATS[p.cat]) return 'اختر نوع المصروف';
        if (((S.users[op.by] || {}).role === 'ads') && AD_CATS.indexOf(p.cat) < 0) return 'مسؤول الإعلانات يسجّل مصروفات الإعلانات فقط';
        if ((e = pos(p.amt, 'المبلغ'))) return e;
        return p.currency === 'USD' && !(p.rate > 0) ? 'سعر الصرف مطلوب' : null;
      case 'gift': {
        const pr = S.products[p.productId];
        if (!pr) return 'اختر العطر';
        if (!Number.isInteger(p.qty) || p.qty <= 0) return 'العدد يجب أن يكون عددًا صحيحًا موجبًا';
        if (!p.to || !String(p.to).trim()) return 'اكتب لمن أُهديت';
        if (!GIFT_KINDS[p.kind]) return 'اختر نوع المستلم';
        return pr.stock < p.qty ? 'المخزون لا يكفي: المتاح ' + pr.stock : null;
      }
      case 'adjust': {
        const isMat = p.target === 'material';
        const it = isMat ? S.materials[p.id] : S.products[p.id];
        if (!it) return 'اختر الصنف';
        if (p.opening) {
          if (isMat) return 'الرصيد الافتتاحي للمنتجات فقط';
          if (!Number.isInteger(p.delta) || p.delta <= 0) return 'أدخل عددًا صحيحًا موجبًا';
          return Number.isFinite(p.unitCost) && p.unitCost >= 0 ? null : 'تكلفة الزجاجة غير صحيحة';
        }
        if (!p.reason || !p.reason.trim()) return 'سبب التسوية مطلوب';
        if (!Number.isFinite(p.delta) || p.delta === 0) return 'الفرق يجب ألا يكون صفرًا';
        if (!isMat && !Number.isInteger(p.delta)) return 'عدد المنتجات يجب أن يكون صحيحًا';
        return p.delta < 0 && (isMat ? it.qty : it.stock) < -p.delta ? 'الخصم أكبر من الرصيد' : null;
      }
      case 'void': return p.target ? null : 'عملية غير محددة';
    }
    return 'نوع عملية غير معروف';
  }

  /*@client-end*/

  // ---------- التقارير ----------
  function report(S, from, to) {
    const inR = d => (!from || d >= from) && (!to || d <= to);
    const orders = Object.values(S.orders);
    const delivered = orders.filter(o => o.status === 'delivered' && inR(o.deliveredDate));
    const rejected = orders.filter(o => o.status === 'rejected' && inR(o.rejectedDate));
    const created = orders.filter(o => inR(o.date));
    const revenue = sum(delivered, o => o.total), itemsRevenue = sum(delivered, o => o.itemsTotal - (o.discount || 0));
    const cogs = sum(delivered, o => o.cogs);
    const giftLinesCost = sum(delivered, o => sum(o.items.filter(i => i.gift), i => i.cogs)), giftLinesQty = sum(delivered, o => sum(o.items.filter(i => i.gift), i => i.qty));
    const exps = S.expenses.filter(e => inR(e.date));
    const byCat = {};
    for (const e of exps) byCat[e.cat] = (byCat[e.cat] || 0) + e.lyd;
    const expTotal = sum(exps, e => e.lyd);
    const shrink = 0 - sum(S.adjustments.filter(a => inR(a.date)), a => a.value);
    const adSpend = sum(AD_CATS, c => byCat[c] || 0);
    const gross = revenue - cogs;
    const discOrders = delivered.filter(o => (o.discount || 0) > 0), byCoupon = {};
    for (const o of discOrders) { const k = o.coupon || '—'; const r = byCoupon[k] || (byCoupon[k] = { code: k, n: 0, discount: 0 }); r.n++; r.discount += o.discount; }
    const discountTotal = sum(discOrders, o => o.discount);
    const wds = S.withdrawals.filter(w => inR(w.date)), wdByCat = {};
    for (const w of wds) wdByCat[w.cat] = (wdByCat[w.cat] || 0) + w.lyd;
    const wdTotal = sum(wds, w => w.lyd);
    const byProduct = {};
    for (const o of delivered) for (const it of o.items) {
      const r = byProduct[it.productId] || (byProduct[it.productId] = { name: it.name, qty: 0, revenue: 0, cogs: 0 });
      r.qty += it.qty; r.revenue += it.qty * it.price; r.cogs += it.cogs;
    }
    const camp = {}, cget = n => camp[n] || (camp[n] = { name: n, spend: 0, created: 0, delivered: 0, rejected: 0, revenue: 0, cogs: 0 });
    for (const e of exps) if (e.campaign && AD_CATS.indexOf(e.cat) >= 0) cget(e.campaign).spend += e.lyd;
    for (const o of created) if (o.campaign) cget(o.campaign).created++;
    for (const o of delivered) if (o.campaign) { const c = cget(o.campaign); c.delivered++; c.revenue += o.total; c.cogs += o.cogs; }
    for (const o of rejected) if (o.campaign) cget(o.campaign).rejected++;
    const byCampaign = Object.values(camp).map(c => Object.assign(c, { profit: c.revenue - c.cogs - c.spend, roas: c.spend ? c.revenue / c.spend : 0, cpo: c.created ? Math.round(c.spend / c.created) : 0 })).sort((a, b) => b.spend - a.spend);
    const city = {}, ctg = n => city[n] || (city[n] = { city: n, delivered: 0, rejected: 0, revenue: 0 });
    for (const o of delivered) { const c = ctg(o.customer.city || '—'); c.delivered++; c.revenue += o.total; }
    for (const o of rejected) ctg(o.customer.city || '—').rejected++;
    const byCity = Object.values(city).sort((a, b) => b.revenue - a.revenue);
    const cust = {};
    for (const o of delivered) { const k = phoneKey(o.customer.phone); if (!k) continue; const c = cust[k] || (cust[k] = { name: o.customer.name, phone: o.customer.phone, n: 0, spent: 0 }); c.n++; c.spent += o.total; }
    const topCustomers = Object.values(cust).sort((a, b) => b.spent - a.spent).slice(0, 10);
    const comm = {};
    for (const o of delivered) {
      const u = S.users[o.by]; if (!u || !u.commission || !(u.commission.value > 0)) continue;
      const c = comm[u.id] || (comm[u.id] = { id: u.id, name: u.name, orders: 0, base: 0, amount: 0 });
      c.orders++; c.base += o.total; c.amount += u.commission.type === 'pct' ? Math.round(o.total * u.commission.value / 100000) : u.commission.value;
    }
    const decided = delivered.length + rejected.length;
    return {
      from, to, revenue, cogs, gross, expTotal, byCat, shrink, net: gross - expTotal - shrink, adSpend, byCampaign, byCity, topCustomers, commissions: Object.values(comm), discountTotal, discountOrders: discOrders.length, byCoupon: Object.values(byCoupon).sort((a, b) => b.discount - a.discount), wdTotal, wdByCat, remainder: gross - expTotal - shrink - wdTotal, outAll: expTotal + shrink + wdTotal,
      created: created.length, delivered: delivered.length, rejected: rejected.length,
      rejectRate: decided ? rejected.length / decided : 0,
      costPerOrder: created.length ? Math.round(adSpend / created.length) : 0,
      costPerDelivered: delivered.length ? Math.round(adSpend / delivered.length) : 0,
      roas: adSpend ? itemsRevenue / adSpend : 0,
      avgOrder: delivered.length ? Math.round(revenue / delivered.length) : 0,
      byProduct: Object.values(byProduct).map(r => Object.assign(r, { profit: r.revenue - r.cogs })).sort((a, b) => b.profit - a.profit),
      receivables: sum(orders.filter(o => o.status === 'delivered'), o => Math.max(0, o.total - o.paid)),
      inTransit: sum(orders.filter(o => o.status === 'shipped'), o => o.total),
      giftLinesCost, cogsSold: cogs - giftLinesCost, giftCost: (byCat.gift || 0) + giftLinesCost, giftCount: giftLinesQty +  sum(S.gifts.filter(g => inR(g.date)), g => g.qty),
      matValue: sum(Object.values(S.materials), m => m.value),
      fgValue: sum(Object.values(S.products), p => p.value)
    };
  }

  // جداول جاهزة للكتابة في جوجل شيت أو التصدير CSV
  function views(S) {
    const n = v => v / MILLI;
    const rate = S.settings.rate;
    const orders = Object.values(S.orders).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts));
    const users = S.users;
    return {
      'الطلبات': [['الرقم', 'كود التوصيل', 'التاريخ', 'العميل', 'الهاتف', 'المدينة', 'العنوان', 'الحالة', 'المنتجات', 'الإجمالي د.ل', 'المدفوع', 'المتبقي', 'التكلفة', 'الربح', 'القناة', 'الموظف']].concat(
        orders.map(o => [o.code, o.courierCode || '', o.date, o.customer.name, o.customer.phone, o.customer.city, o.customer.address || '', STATUS[o.status], o.items.map(i => i.name + '×' + i.qty + (i.gift ? ' (هدية)' : '')).join(' + '), n(o.total), n(o.paid), n(o.total - o.paid), n(o.cogs), o.status === 'delivered' ? n(o.total - o.cogs) : '', o.channel, (users[o.by] || {}).name || ''])),
      'المواد الخام': [['المادة', 'التصنيف', 'الوحدة', 'الرصيد', 'متوسط تكلفة الوحدة د.ل', 'القيمة د.ل', 'حد التنبيه']].concat(
        Object.values(S.materials).map(m => [m.name, MAT_CATS[m.cat], UNITS[m.unit], n(m.qty), m.qty > 0 ? m.value / m.qty : 0, n(m.value), n(m.min)])),
      'المنتجات': [['المنتج', 'الحجم مل', 'السعر د.ل', 'تكلفة التركيبة الحالية', 'المخزون', 'قيمة المخزون']].concat(
        Object.values(S.products).map(p => [p.name, p.sizeMl, n(p.price), n(recipeCost(S, p)), p.stock, n(p.value)])),
      'المصروفات': [['التاريخ', 'النوع', 'المبلغ د.ل', 'ملاحظة']].concat(
        S.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map(e => [e.date, EXP_CATS[e.cat], n(e.lyd), e.note || ''])),
      'حركة المخزون': [['التاريخ', 'الحركة', 'الصنف', 'الكمية', 'القيمة د.ل', 'ملاحظة']].concat(
        S.movements.slice().sort((a, b) => b.ts - a.ts).map(m => [m.date, { purchase: 'شراء', consume: 'استهلاك تعبئة', produce: 'إنتاج', ship: 'شحن', restock: 'إعادة للمخزون', adjust: 'تسوية', opening: 'رصيد افتتاحي', gift: 'هدية' }[m.kind], m.name, m.type === 'material' ? n(m.qty) : m.qty, n(m.value), m.note || ''])),
      'الديون': [['التاريخ', 'الاتجاه', 'الطرف', 'النوع', 'الإجمالي د.ل', 'المدفوع', 'المتبقي', 'الاستحقاق', 'ملاحظة']].concat(
        Object.values(S.debts).map(d => [d.date, d.dir === 'in' ? 'لنا' : 'علينا', d.party, { customer: 'عميل', courier: 'شركة توصيل', supplier: 'مورد', printer: 'مطبعة', personal: 'شخصي', other: 'أخرى' }[d.kind] || d.kind, n(d.lyd), n(d.paid), n(d.lyd - d.paid), d.due || '', d.note || ''])),
      'العملاء': [['الاسم', 'الهاتف', 'المدينة', 'الطلبات', 'المستلمة', 'المرفوضة', 'إجمالي الشراء د.ل', 'آخر طلب']].concat(
        Object.values(customers(S)).sort((a, b) => b.spent - a.spent).map(c => [c.name, c.phone, c.city, c.n, c.delivered, c.rejected + c.returned, n(c.spent), c.last])),
      'أكواد الخصم': [['الكود', 'النوع', 'القيمة', 'ينتهي', 'الحد الأقصى', 'استُخدم', 'الحالة', 'ملاحظة']].concat(
        Object.values(S.coupons).map(c => [c.code, c.type === 'pct' ? 'نسبة' : 'مبلغ', c.type === 'pct' ? n(c.value) + '%' : n(c.value), c.expires || '', c.maxUses || 'بلا حد', couponUses(S, c.code), c.active ? 'فعّال' : 'موقوف', c.note || ''])),
      'المسحوبات': [['التاريخ', 'النوع', 'المبلغ د.ل', 'ملاحظة', 'الموظف']].concat(
        S.withdrawals.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts)).map(w => [w.date, WD_CATS[w.cat], n(w.lyd), w.note || '', (users[w.by] || {}).name || ''])),
      'الهدايا': [['التاريخ', 'المستلم', 'العطر', 'العدد', 'التكلفة د.ل', 'الطلب / ملاحظة', 'الموظف']].concat(
        giftRows(S).map(g => [g.date, g.to, g.name, g.qty, n(g.cost), g.note || '', (users[g.by] || {}).name || ''])),
      'الملخص': (function () {
        const r = report(S, '', ''), usd = v => (rate ? n(toUsd(v, rate)) : '');
        return [['البند', 'د.ل', 'دولار'], ['الإيراد (طلبات مستلمة)', n(r.revenue), usd(r.revenue)], ['تكلفة البضاعة', n(r.cogs), usd(r.cogs)], ['مجمل الربح', n(r.gross), usd(r.gross)], ['المصروفات', n(r.expTotal), usd(r.expTotal)], ['فاقد وتسويات', n(r.shrink), usd(r.shrink)], ['صافي الربح', n(r.net), usd(r.net)], ['الخصومات المُعطاة (ضمن الإيراد الصافي)', n(r.discountTotal), usd(r.discountTotal)], ['المسحوبات الشخصية', n(r.wdTotal), usd(r.wdTotal)], ['المتبقي بعد المسحوبات', n(r.remainder), usd(r.remainder)], ['منها إنفاق إعلاني', n(r.adSpend), usd(r.adSpend)], ['ذمم لم تُحصَّل', n(r.receivables), usd(r.receivables)], ['قيمة المواد الخام', n(r.matValue), usd(r.matValue)], ['قيمة المنتجات الجاهزة', n(r.fgValue), usd(r.fgValue)]];
      })()
    };
  }

  return { VERSION, MILLI, MASTER, productionPayload, ROLES, STATUS, TRANSITIONS, EXP_CATS, WD_CATS, couponCheck, couponUses, normCode, giftRows, phoneKey, customers, customerRisk, lowStock, debtInfo, AD_CATS, MAT_CATS, UNITS, GIFT_KINDS, OP_TYPES, PERMS, can, canOp, uid, normDigits, toM, fromM, toLyd, toUsd, fmtNum, sha256, hashPin, reduce, validate, report, views, recipeCost, orderTotals, emptyState };
});
