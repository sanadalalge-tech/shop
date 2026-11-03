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

  const ROLES = { owner: 'المالك', manager: 'مشرف', sales: 'مبيعات', warehouse: 'مخزن' };
  const STATUS = { new: 'جديد', confirmed: 'مؤكد', shipped: 'مع المندوب', delivered: 'مستلم', rejected: 'مرفوض', cancelled: 'ملغي', returned: 'مرتجع' };
  const TRANSITIONS = { new: ['confirmed', 'shipped', 'cancelled'], confirmed: ['shipped', 'cancelled'], shipped: ['delivered', 'rejected'], delivered: ['returned'] };
  const EXP_CATS = { sponsored: 'إعلانات ممولة', influencer: 'مشاهير ومؤثرون', ads_other: 'إعلانات أخرى', delivery: 'تكلفة التوصيل', delivery_loss: 'خسارة توصيل مرفوض', gift: 'هدايا', salary: 'رواتب وعمولات', rent: 'إيجار وخدمات', other: 'أخرى' };
  const GIFT_KINDS = { influencer: 'مشهور / مؤثر', customer: 'زبون', sample: 'عينة', other: 'أخرى' };
  const AD_CATS = ['sponsored', 'influencer', 'ads_other'];
  const MAT_CATS = { alcohol: 'كحول', oil: 'زيوت عطرية', glass: 'زجاج', box: 'بوكس', sticker: 'ستيكر', bag: 'أكياس', other: 'أخرى' };
  const UNITS = { ml: 'مل', g: 'جرام', pcs: 'قطعة' };
  const MASTER = ['user_upsert', 'settings_set', 'material_upsert', 'product_upsert'];
  const WD_CATS = { food: 'أكل وشرب', clothes: 'ملابس', transport: 'مواصلات', family: 'عائلة ومنزل', other: 'أخرى' };
  const OP_TYPES = ['user_upsert', 'settings_set', 'material_upsert', 'product_upsert', 'purchase', 'production', 'order_create', 'order_status', 'order_edit', 'payment', 'expense', 'adjust', 'gift', 'withdrawal', 'void'];

  const PERMS = {
    owner: null,
    manager: OP_TYPES.filter(t => t !== 'user_upsert' && t !== 'settings_set' && t !== 'withdrawal'),
    sales: ['order_create', 'order_status', 'order_edit', 'payment'],
    warehouse: ['purchase', 'production', 'adjust', 'material_upsert', 'order_status', 'order_edit']
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
    return { settings: { rate: 0, brand: '' }, users: {}, materials: {}, products: {}, orders: {}, expenses: [], adjustments: [], gifts: [], withdrawals: [], payments: [], movements: [], alerts: [], opsCount: 0 };
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
        const items = p.items.map(i => ({ productId: i.productId, qty: i.qty, price: i.price, name: (S.products[i.productId] || {}).name || '؟', cogs: 0 }));
        S.orders[p.id] = { id: p.id, code: p.code, date: d, ts: op.ts, by: op.by, customer: p.customer, items, discount: p.discount || 0, deliveryFee: p.deliveryFee || 0, courierCost: p.courierCost || 0, courierCode: p.courierCode || '', channel: p.channel || '', payMethod: p.payMethod || 'cod', note: p.note || '', status: 'new', history: [{ status: 'new', date: d, by: op.by }], paid: 0, cogs: 0 };
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
        S.expenses.push({ id: op.id, date: d, cat: p.cat, lyd: toLyd(p.amt, p.currency, p.rate), cur: p.currency, orig: p.amt, note: p.note || '' });
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
        if (!p.customer || !p.customer.name || !p.customer.phone) return 'اسم العميل ورقم هاتفه مطلوبان';
        if (!p.customer.city) return 'المدينة مطلوبة';
        if (!p.items || !p.items.length) return 'أضف منتجًا واحدًا على الأقل';
        for (const i of p.items) {
          if (!S.products[i.productId]) return 'منتج غير موجود';
          if (!Number.isInteger(i.qty) || i.qty <= 0) return 'الكمية يجب أن تكون عددًا صحيحًا موجبًا';
          if (!(i.price >= 0)) return 'سعر غير صحيح';
        }
        return orderTotals({ items: p.items, discount: p.discount, deliveryFee: p.deliveryFee }).total < 0 ? 'الخصم أكبر من قيمة الطلب' : null;
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
      case 'withdrawal':
        if (!WD_CATS[p.cat]) return 'اختر نوع المسحوب';
        if ((e = pos(p.amt, 'المبلغ'))) return e;
        return p.currency === 'USD' && !(p.rate > 0) ? 'سعر الصرف مطلوب' : null;
      case 'expense':
        if (!EXP_CATS[p.cat]) return 'اختر نوع المصروف';
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
    const exps = S.expenses.filter(e => inR(e.date));
    const byCat = {};
    for (const e of exps) byCat[e.cat] = (byCat[e.cat] || 0) + e.lyd;
    const expTotal = sum(exps, e => e.lyd);
    const shrink = 0 - sum(S.adjustments.filter(a => inR(a.date)), a => a.value);
    const adSpend = sum(AD_CATS, c => byCat[c] || 0);
    const gross = revenue - cogs;
    const wds = S.withdrawals.filter(w => inR(w.date)), wdByCat = {};
    for (const w of wds) wdByCat[w.cat] = (wdByCat[w.cat] || 0) + w.lyd;
    const wdTotal = sum(wds, w => w.lyd);
    const byProduct = {};
    for (const o of delivered) for (const it of o.items) {
      const r = byProduct[it.productId] || (byProduct[it.productId] = { name: it.name, qty: 0, revenue: 0, cogs: 0 });
      r.qty += it.qty; r.revenue += it.qty * it.price; r.cogs += it.cogs;
    }
    const decided = delivered.length + rejected.length;
    return {
      from, to, revenue, cogs, gross, expTotal, byCat, shrink, net: gross - expTotal - shrink, adSpend, wdTotal, wdByCat, remainder: gross - expTotal - shrink - wdTotal, outAll: expTotal + shrink + wdTotal,
      created: created.length, delivered: delivered.length, rejected: rejected.length,
      rejectRate: decided ? rejected.length / decided : 0,
      costPerOrder: created.length ? Math.round(adSpend / created.length) : 0,
      costPerDelivered: delivered.length ? Math.round(adSpend / delivered.length) : 0,
      roas: adSpend ? itemsRevenue / adSpend : 0,
      avgOrder: delivered.length ? Math.round(revenue / delivered.length) : 0,
      byProduct: Object.values(byProduct).map(r => Object.assign(r, { profit: r.revenue - r.cogs })).sort((a, b) => b.profit - a.profit),
      receivables: sum(orders.filter(o => o.status === 'delivered'), o => Math.max(0, o.total - o.paid)),
      inTransit: sum(orders.filter(o => o.status === 'shipped'), o => o.total),
      giftCost: byCat.gift || 0, giftCount: sum(S.gifts.filter(g => inR(g.date)), g => g.qty),
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
        orders.map(o => [o.code, o.courierCode || '', o.date, o.customer.name, o.customer.phone, o.customer.city, o.customer.address || '', STATUS[o.status], o.items.map(i => i.name + '×' + i.qty).join(' + '), n(o.total), n(o.paid), n(o.total - o.paid), n(o.cogs), o.status === 'delivered' ? n(o.total - o.cogs) : '', o.channel, (users[o.by] || {}).name || ''])),
      'المواد الخام': [['المادة', 'التصنيف', 'الوحدة', 'الرصيد', 'متوسط تكلفة الوحدة د.ل', 'القيمة د.ل', 'حد التنبيه']].concat(
        Object.values(S.materials).map(m => [m.name, MAT_CATS[m.cat], UNITS[m.unit], n(m.qty), m.qty > 0 ? m.value / m.qty : 0, n(m.value), n(m.min)])),
      'المنتجات': [['المنتج', 'الحجم مل', 'السعر د.ل', 'تكلفة التركيبة الحالية', 'المخزون', 'قيمة المخزون']].concat(
        Object.values(S.products).map(p => [p.name, p.sizeMl, n(p.price), n(recipeCost(S, p)), p.stock, n(p.value)])),
      'المصروفات': [['التاريخ', 'النوع', 'المبلغ د.ل', 'ملاحظة']].concat(
        S.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map(e => [e.date, EXP_CATS[e.cat], n(e.lyd), e.note || ''])),
      'حركة المخزون': [['التاريخ', 'الحركة', 'الصنف', 'الكمية', 'القيمة د.ل', 'ملاحظة']].concat(
        S.movements.slice().sort((a, b) => b.ts - a.ts).map(m => [m.date, { purchase: 'شراء', consume: 'استهلاك تعبئة', produce: 'إنتاج', ship: 'شحن', restock: 'إعادة للمخزون', adjust: 'تسوية', opening: 'رصيد افتتاحي', gift: 'هدية' }[m.kind], m.name, m.type === 'material' ? n(m.qty) : m.qty, n(m.value), m.note || ''])),
      'المسحوبات': [['التاريخ', 'النوع', 'المبلغ د.ل', 'ملاحظة', 'الموظف']].concat(
        S.withdrawals.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts)).map(w => [w.date, WD_CATS[w.cat], n(w.lyd), w.note || '', (users[w.by] || {}).name || ''])),
      'الهدايا': [['التاريخ', 'المستلم', 'النوع', 'العطر', 'العدد', 'التكلفة د.ل', 'ملاحظة', 'الموظف']].concat(
        S.gifts.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts)).map(g => [g.date, g.to, GIFT_KINDS[g.kind] || '', g.name, g.qty, n(g.cost), g.note || '', (users[g.by] || {}).name || ''])),
      'الملخص': (function () {
        const r = report(S, '', ''), usd = v => (rate ? n(toUsd(v, rate)) : '');
        return [['البند', 'د.ل', 'دولار'], ['الإيراد (طلبات مستلمة)', n(r.revenue), usd(r.revenue)], ['تكلفة البضاعة', n(r.cogs), usd(r.cogs)], ['مجمل الربح', n(r.gross), usd(r.gross)], ['المصروفات', n(r.expTotal), usd(r.expTotal)], ['فاقد وتسويات', n(r.shrink), usd(r.shrink)], ['صافي الربح', n(r.net), usd(r.net)], ['المسحوبات الشخصية', n(r.wdTotal), usd(r.wdTotal)], ['المتبقي بعد المسحوبات', n(r.remainder), usd(r.remainder)], ['منها إنفاق إعلاني', n(r.adSpend), usd(r.adSpend)], ['ذمم لم تُحصَّل', n(r.receivables), usd(r.receivables)], ['قيمة المواد الخام', n(r.matValue), usd(r.matValue)], ['قيمة المنتجات الجاهزة', n(r.fgValue), usd(r.fgValue)]];
      })()
    };
  }

  return { VERSION, MILLI, MASTER, productionPayload, ROLES, STATUS, TRANSITIONS, EXP_CATS, WD_CATS, AD_CATS, MAT_CATS, UNITS, GIFT_KINDS, OP_TYPES, PERMS, can, canOp, uid, normDigits, toM, fromM, toLyd, toUsd, fmtNum, sha256, hashPin, reduce, validate, report, views, recipeCost, orderTotals, emptyState };
});
