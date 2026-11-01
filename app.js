(function () {
'use strict';
const C = Core;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('pf_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pf_' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('pf_' + k); } catch (e) {} }
};

// ---------- التخزين المحلي (IndexedDB) ----------
let db = null;
function idbOpen() {
  return new Promise(res => {
    try {
      const r = indexedDB.open('perfume-erp', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('ops', { keyPath: 'id' });
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => res();
    } catch (e) { res(); }
  });
}
function idbAll() { return new Promise(res => { if (!db) return res([]); const q = db.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); }
function idbPut(list) {
  return new Promise(res => {
    if (!db || !list.length) return res();
    const tx = db.transaction('ops', 'readwrite'), st = tx.objectStore('ops');
    list.forEach(o => st.put(o));
    tx.oncomplete = () => res(); tx.onerror = () => { toast('تعذّر الحفظ على الجهاز', 1); res(); };
  });
}

// ---------- الحالة ----------
let OPS = [], S = C.emptyState(), USER = null, ui = { tab: 'dash', period: 'month', ostatus: 'all', q: '', stab: 'mat' }, syncing = false, lastErr = '';
let DEV = LS.get('dev', null); if (!DEV) { DEV = C.uid().slice(0, 8); LS.set('dev', DEV); }
const recompute = () => { S = C.reduce(OPS); };
const role = () => (USER ? USER.role : '');
const seesCost = () => role() === 'owner' || role() === 'manager';
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
function range(p) {
  const t = new Date(), to = iso(t);
  if (p === 'today') return [to, to];
  if (p === 'week') { const d = new Date(t); d.setDate(d.getDate() - 6); return [iso(d), to]; }
  if (p === 'month') return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), to];
  return ['', ''];
}
const num = (m, mx) => C.fmtNum(m, mx);
const lyd = m => '<span dir="ltr">' + num(m) + '</span> د.ل';
const usdv = m => { if (!(S.settings.rate > 0)) return ''; const v = C.toUsd(m, S.settings.rate); return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
const money = m => lyd(m) + (S.settings.rate > 0 ? '<small class="d" dir="ltr">' + usdv(m) + '</small>' : '');
const qty = (m, u) => '<span dir="ltr">' + num(m) + '</span> ' + C.UNITS[u];
const stBadge = s => '<span class="st ' + s + '">' + C.STATUS[s] + '</span>';
function opt(map, sel) { return Object.keys(map).map(k => '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(map[k]) + '</option>').join(''); }
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, err ? 4200 : 2200); }
const fnum = (v, d) => (v === '' || v == null ? d : C.toM(v));

// ---------- تسجيل العمليات ----------
function commit(type, p, date) {
  if (!USER) return false;
  const op = { id: C.uid(), ts: Date.now(), date: date || today(), dev: DEV, by: USER.id, type, p };
  if (!C.canOp(USER.role, op)) { toast('لا تملك صلاحية هذه العملية', 1); return false; }
  const err = C.validate(S, op);
  if (err) { toast(err, 1); return false; }
  OPS.push(op); idbPut([op]); recompute(); render(); scheduleSync();
  return op;
}

// ---------- المزامنة ----------
let syncTimer = null;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 400); }
const strip = o => { const c = Object.assign({}, o); delete c._s; delete c._r; return c; };
async function sync(manual) {
  const cfg = LS.get('api', null);
  if (!cfg || !cfg.url || !cfg.token || syncing) return false;
  if (!navigator.onLine && !manual) return false;
  syncing = true; setBadge();
  try {
    const pending = OPS.filter(o => !o._s && !o._r).sort((a, b) => a.ts - b.ts);
    const res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: cfg.token, since: LS.get('cursor', 0), ops: pending.map(strip) }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error === 'auth' ? 'مفتاح الربط غير صحيح' : (j.error || 'خطأ من الخادم'));
    const byId = new Map(OPS.map(o => [o.id, o])), changed = [];
    (j.accepted || []).forEach(id => { const o = byId.get(id); if (o && !o._s) { o._s = 1; changed.push(o); } });
    (j.rejected || []).forEach(r => { const o = byId.get(r.id); if (o) { o._r = r.reason; changed.push(o); } });
    let got = 0;
    (j.ops || []).forEach(o => {
      const ex = byId.get(o.id);
      if (ex) { if (!ex._s) { ex._s = 1; changed.push(ex); } } else { o._s = 1; OPS.push(o); byId.set(o.id, o); changed.push(o); got++; }
    });
    LS.set('cursor', j.cursor);
    await idbPut(changed);
    lastErr = '';
    if (USER && !S.users[USER.id]) { /* مستخدم محذوف */ }
    recompute();
    if (changed.length) renderSoft();
    if ((j.rejected || []).length) toast('رُفضت ' + j.rejected.length + ' عملية من الخادم، راجع الإعدادات', 1);
    return true;
  } catch (e) { lastErr = e.message || 'تعذر الاتصال'; return false; }
  finally { syncing = false; setBadge(); }
}
function setBadge() {
  const b = $('#sb'); if (!b) return;
  const cfg = LS.get('api', null), n = OPS.filter(o => !o._s && !o._r).length;
  let t, c;
  if (!cfg) { t = 'دون ربط · ' + n + ' محفوظة محليًا'; c = 'off'; }
  else if (syncing) { t = 'جارٍ المزامنة…'; c = ''; }
  else if (!navigator.onLine) { t = 'دون إنترنت · ' + n + ' بانتظار الرفع'; c = 'off'; }
  else if (lastErr) { t = 'فشلت المزامنة · ' + n + ' بانتظار'; c = 'err'; }
  else if (n) { t = n + ' بانتظار الرفع'; c = 'off'; }
  else { t = 'متزامن ✓'; c = 'ok'; }
  b.textContent = t; b.className = 'badge ' + c; b.title = lastErr;
}
window.addEventListener('online', () => { setBadge(); sync(); });
window.addEventListener('offline', setBadge);
setInterval(() => { if (USER) sync(); }, 30000);
function renderSoft() { const a = document.activeElement; if (!$('#modal').hidden || (a && a.closest && a.closest('main') && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) { setBadge(); return; } render(); }

// ---------- النوافذ ----------
function modal(title, body, onSubmit, okLabel) {
  const m = $('#modal');
  m.innerHTML = '<form class="sheet" id="mf" novalidate><h2>' + esc(title) + '</h2>' + body + '<div class="row" style="margin-top:12px;justify-content:flex-start"><button class="btn pri" type="submit">' + esc(okLabel || 'حفظ') + '</button><button class="btn" type="button" data-a="close">إلغاء</button></div></form>';
  m.hidden = false;
  $('#mf').onsubmit = e => { e.preventDefault(); if (onSubmit($('#mf')) !== false) closeModal(); };
  const f = $('#mf input:not([type=hidden]),#mf select'); if (f && !/Android|iPhone/i.test(navigator.userAgent)) f.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
const fd = f => Object.fromEntries(new FormData(f).entries());
const askConfirm = (msg, fn) => modal('تأكيد', '<p>' + esc(msg) + '</p>', () => { fn(); }, 'نعم، تابع');

// ---------- الدخول والإعداد ----------
function renderLogin() {
  const users = Object.values(S.users).filter(u => u.active !== false);
  const logo = '<img class="logo" src="icon.svg" alt="">';
  if (!users.length) {
    $('#app').innerHTML = '<div class="login">' + logo + '<h2 style="text-align:center">إعداد المنظومة</h2>' +
      '<form id="setup" class="card" novalidate><label>اسم العلامة التجارية<input name="brand" required></label><label>اسمك (المالك)<input name="name" required></label>' +
      '<label>رمز سري (4 أرقام فأكثر)<input name="pin" type="password" inputmode="numeric" minlength="4" required></label>' +
      '<label>سعر الصرف: كم دينارًا يساوي 1 دولار<input name="rate" inputmode="decimal" placeholder="مثال: 7.20" required></label><button class="btn pri" style="width:100%">ابدأ</button></form>' +
      '<div class="card"><b>لديك منظومة تعمل على جهاز آخر؟</b><p class="hint">اربط هذا الجهاز بنفس جوجل شيت وستنتقل كل البيانات إليه.</p><button class="btn" style="width:100%" data-a="connect">ربط بجوجل شيت</button></div></div>';
    $('#setup').onsubmit = e => {
      e.preventDefault(); const v = fd(e.target), rate = C.toM(v.rate);
      if (!v.brand.trim() || !v.name.trim()) return toast('أكمل الحقول', 1);
      if (!/^\d{4,}$/.test(C.normDigits(v.pin))) return toast('الرمز السري 4 أرقام على الأقل', 1);
      if (!(rate > 0)) return toast('سعر الصرف غير صحيح', 1);
      const id = C.uid(), salt = C.uid().slice(0, 8);
      USER = { id, role: 'owner', name: v.name.trim() };
      const mk = (type, p) => ({ id: C.uid(), ts: Date.now(), date: today(), dev: DEV, by: id, type, p });
      const a = mk('user_upsert', { id, name: v.name.trim(), role: 'owner', salt, hash: C.hashPin(C.normDigits(v.pin), salt), active: true });
      const b = mk('settings_set', { rate, brand: v.brand.trim() }); b.ts++;
      OPS.push(a, b); idbPut([a, b]); recompute(); LS.set('session', id); scheduleSync(); render();
    };
    return;
  }
  $('#app').innerHTML = '<div class="login">' + logo + '<h2 style="text-align:center">' + esc(S.settings.brand || 'تسجيل الدخول') + '</h2><form id="lg" class="card" novalidate><label>المستخدم<select name="u">' +
    users.map(u => '<option value="' + u.id + '">' + esc(u.name) + ' — ' + C.ROLES[u.role] + '</option>').join('') + '</select></label><label>الرمز السري<input name="pin" type="password" inputmode="numeric" autocomplete="off"></label><button class="btn pri" style="width:100%">دخول</button></form>' +
    '<p class="hint" style="text-align:center">' + (LS.get('api', null) ? '' : '<a href="#" data-a="connect">ربط بجوجل شيت</a>') + '</p></div>';
  $('#lg').onsubmit = e => {
    e.preventDefault(); const v = fd(e.target), u = S.users[v.u];
    if (u && u.active !== false && C.hashPin(C.normDigits(v.pin), u.salt) === u.hash) { USER = u; LS.set('session', u.id); render(); sync(); }
    else toast('الرمز السري غير صحيح', 1);
  };
}
function connectModal() {
  const cfg = LS.get('api', {}) || {};
  modal('الربط بجوجل شيت', '<label>رابط تطبيق الويب (Web App URL)<input name="url" dir="ltr" value="' + esc(cfg.url || '') + '" placeholder="https://script.google.com/macros/s/…/exec"></label><label>مفتاح الربط<input name="token" dir="ltr" value="' + esc(cfg.token || '') + '"></label><p class="hint">تجدهما بعد تنفيذ خطوات دليل الإعداد داخل جوجل شيت.</p>', f => {
    const v = fd(f);
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(v.url.trim()) && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(v.url.trim())) { toast('الرابط غير صحيح، يجب أن ينتهي بـ /exec', 1); return false; }
    LS.set('api', { url: v.url.trim(), token: v.token.trim() }); LS.set('cursor', 0);
    sync(true).then(ok => { recompute(); if (ok) toast('تم الربط وتحميل البيانات'); else toast('تعذر الاتصال: ' + lastErr, 1); render(); });
  }, 'ربط ومزامنة');
}
function logout() { USER = null; LS.del('session'); render(); }

// ---------- الهيكل ----------
const ICON = {
  dash: '<path d="M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-3H4z"/>', orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>', stock: '<path d="M3 8l9-5 9 5-9 5zM3 8v8l9 5 9-5V8"/>',
  exp: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5C9.5 8 14.5 8 14.5 10s-5 2-5 4 5 2 5.5.5"/>', rep: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', set: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'
};
function tabs() {
  const r = role(), all = [['dash', 'الرئيسية'], ['orders', 'الطلبات'], ['stock', 'المخزون'], ['exp', 'المصروفات'], ['rep', 'التقارير'], ['set', 'الإعدادات']];
  if (r === 'sales') return all.filter(t => ['orders', 'set'].includes(t[0]));
  if (r === 'warehouse') return all.filter(t => ['stock', 'orders', 'set'].includes(t[0]));
  return all;
}
function render() {
  if (!USER) return renderLogin();
  const t = tabs(); if (!t.some(x => x[0] === ui.tab)) ui.tab = t[0][0];
  $('#app').innerHTML = '<div class="top"><h1>' + esc(S.settings.brand || 'المنظومة') + '</h1><span id="sb" class="badge"></span></div><main id="pg"></main><nav class="nav">' +
    t.map(x => '<button data-a="tab" data-id="' + x[0] + '" class="' + (ui.tab === x[0] ? 'on' : '') + '"><svg viewBox="0 0 24 24">' + ICON[x[0]] + '</svg>' + x[1] + '</button>').join('') + '</nav>';
  $('#pg').innerHTML = ({ dash: pgDash, orders: pgOrders, stock: pgStock, exp: pgExp, rep: pgRep, set: pgSet })[ui.tab]();
  setBadge();
  if (ui.tab === 'orders') bindOrders();
}
function periodChips() {
  return '<div class="chips">' + [['today', 'اليوم'], ['week', '7 أيام'], ['month', 'هذا الشهر'], ['all', 'الكل']].map(p => '<button class="chip ' + (ui.period === p[0] ? 'on' : '') + '" data-a="period" data-id="' + p[0] + '">' + p[1] + '</button>').join('') + '</div>';
}
const kpi = (label, val, sub, cls) => '<div class="kpi ' + (cls || '') + '"><small>' + label + '</small><b>' + val + '</b>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';

// ---------- الرئيسية ----------
function pgDash() {
  const [f, t] = range(ui.period), r = C.report(S, f, t), cost = seesCost();
  const alerts = S.alerts.filter(a => a.lvl !== 'info'), pend = OPS.filter(o => !o._s && !o._r).length, rej = OPS.filter(o => o._r);
  let h = '<h2>نظرة عامة</h2>' + periodChips() + '<div class="kpis">' +
    kpi('الإيراد', lyd(r.revenue), usdv(r.revenue)) +
    (cost ? kpi('مجمل الربح', lyd(r.gross), usdv(r.gross), r.gross >= 0 ? 'pos' : 'neg') + kpi('صافي الربح', lyd(r.net), usdv(r.net), r.net >= 0 ? 'pos' : 'neg') : '') +
    kpi('طلبات جديدة', r.created) + kpi('مستلمة', r.delivered) + kpi('نسبة الرفض', Math.round(r.rejectRate * 100) + '%', r.rejected + ' مرفوض', r.rejectRate > 0.2 ? 'neg' : '') + '</div>';
  if (cost) h += '<h3>الإعلانات والمشاهير</h3><div class="kpis">' + kpi('الإنفاق الإعلاني', lyd(r.adSpend), usdv(r.adSpend)) + kpi('تكلفة الطلب الجديد', r.created ? lyd(r.costPerOrder) : '—', r.created ? usdv(r.costPerOrder) : '') + kpi('تكلفة الطلب المستلم', r.delivered ? lyd(r.costPerDelivered) : '—') + kpi('العائد على الإعلان', r.adSpend ? r.roas.toFixed(2) + '×' : '—', 'مبيعات ÷ إنفاق') + '</div>' +
    '<h3>الذمم والمخزون</h3><div class="kpis">' + kpi('عند المندوب', lyd(r.inTransit)) + kpi('لم يُحصَّل', lyd(r.receivables), '', r.receivables > 0 ? 'neg' : '') + kpi('مواد خام', lyd(r.matValue), usdv(r.matValue)) + kpi('منتجات جاهزة', lyd(r.fgValue), usdv(r.fgValue)) + '</div>';
  h += '<h3>تنبيهات</h3>';
  const al = [];
  alerts.slice(0, 20).forEach(a => al.push('<div class="alert ' + (a.lvl === 'err' ? 'err' : 'warn') + '">' + esc(a.msg) + '</div>'));
  rej.forEach(o => al.push('<div class="alert err">رفض الخادم عملية (' + esc(C.OP_TYPES.includes(o.type) ? o.type : '') + '): ' + esc(o._r) + '</div>'));
  if (pend) al.push('<div class="alert info">' + pend + ' عملية محفوظة على هذا الجهاز بانتظار المزامنة</div>');
  h += al.length ? al.join('') : '<div class="empty">لا توجد تنبيهات</div>';
  if (cost && r.byProduct.length) h += '<h3>أرباح المنتجات</h3><div class="tw"><table><tr><th>المنتج</th><th class="n">مباع</th><th class="n">الربح</th></tr>' + r.byProduct.slice(0, 6).map(p => '<tr><td>' + esc(p.name) + '</td><td class="n">' + p.qty + '</td><td class="n">' + num(p.profit) + '</td></tr>').join('') + '</table></div>';
  return h;
}

// ---------- الطلبات ----------
function ordersList() {
  let list = Object.values(S.orders).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts));
  if (role() === 'sales') list = list.filter(o => o.by === USER.id || o.status === 'new');
  if (ui.ostatus !== 'all') list = list.filter(o => o.status === ui.ostatus);
  const q = C.normDigits(ui.q || '').toLowerCase();
  if (q) list = list.filter(o => (o.code + ' ' + (o.courierCode || '') + ' ' + o.customer.name + ' ' + o.customer.phone + ' ' + o.customer.city).toLowerCase().includes(q));
  if (!list.length) return '<div class="empty">لا توجد طلبات</div>';
  return list.slice(0, 150).map(o => '<div class="card" data-a="order" data-id="' + o.id + '" style="cursor:pointer"><div class="row spread"><b>' + esc(o.code) + ' · ' + esc(o.customer.name) + '</b>' + (o.courierCode ? '<small class="d" dir="ltr">' + esc(o.courierCode) + '</small>' : '') + stBadge(o.status) + '</div><div class="row spread"><small class="d">' + esc(o.customer.city) + ' · ' + o.date + ' · ' + o.items.map(i => esc(i.name) + '×' + i.qty).join('، ') + '</small><b>' + lyd(o.total) + '</b></div></div>').join('');
}
function pgOrders() {
  const cnt = {}; Object.values(S.orders).forEach(o => { cnt[o.status] = (cnt[o.status] || 0) + 1; });
  return '<div class="row spread"><h2>الطلبات</h2>' + (C.can(role(), 'order_create') ? '<button class="btn pri" data-a="newOrder">+ طلب جديد</button>' : '') + '</div>' +
    '<input id="oq" placeholder="بحث بالاسم أو الهاتف أو كود التوصيل" value="' + esc(ui.q) + '"><div class="chips" style="margin-top:8px"><button class="chip ' + (ui.ostatus === 'all' ? 'on' : '') + '" data-a="ostatus" data-id="all">الكل</button>' +
    Object.keys(C.STATUS).map(s => '<button class="chip ' + (ui.ostatus === s ? 'on' : '') + '" data-a="ostatus" data-id="' + s + '">' + C.STATUS[s] + (cnt[s] ? ' ' + cnt[s] : '') + '</button>').join('') + '</div><div id="olist">' + ordersList() + '</div>';
}
function bindOrders() { const q = $('#oq'); if (q) q.oninput = () => { ui.q = q.value; $('#olist').innerHTML = ordersList(); }; }
const CHANNELS = ['فيسبوك', 'انستغرام', 'واتساب', 'تيك توك', 'زيارة المتجر', 'أخرى'];
const CITIES = ['طرابلس', 'بنغازي', 'مصراتة', 'الزاوية', 'زليتن', 'البيضاء', 'طبرق', 'سبها', 'صبراتة', 'الخمس', 'غريان', 'أجدابيا', 'درنة', 'سرت', 'الزنتان'];
function lineHtml() {
  const prods = Object.values(S.products).filter(p => p.active !== false);
  return '<div class="line"><label>المنتج<select name="pid"><option value="">اختر…</option>' + prods.map(p => '<option value="' + p.id + '" data-price="' + p.price / 1000 + '">' + esc(p.name) + ' (' + p.stock + ')</option>').join('') + '</select></label><label>الكمية<input name="qty" inputmode="numeric" value="1"></label><label>السعر<input name="price" inputmode="decimal"></label><button type="button" class="x" data-a="rmLine" aria-label="حذف">×</button></div>';
}
function calcOrderForm() {
  const f = $('#mf'); if (!f) return;
  let items = 0;
  $$('.line', f).forEach(l => { const q = C.toM($('[name=qty]', l).value) / 1000, p = C.toM($('[name=price]', l).value); if (q > 0 && p >= 0) items += q * p; });
  const total = items - fnum(f.discount.value, 0) + fnum(f.deliveryFee.value, 0);
  $('#otot').innerHTML = isFinite(total) ? lyd(total) + (S.settings.rate ? ' · ' + usdv(total) : '') : '—';
}
function newOrder() {
  if (!Object.keys(S.products).length) return toast('أضف منتجًا أولًا من المخزون', 1);
  modal('طلب جديد', '<div class="g2"><label>اسم العميل<input name="name"></label><label>الهاتف<input name="phone" inputmode="tel" dir="ltr"></label></div><div class="g2"><label>المدينة<input name="city" list="cities"></label><label>القناة<select name="channel">' + CHANNELS.map(c => '<option>' + c + '</option>').join('') + '</select></label></div><datalist id="cities">' + CITIES.map(c => '<option value="' + c + '">').join('') + '</datalist><label>العنوان / أقرب نقطة دالة<input name="address"></label>' +
    '<div id="lines">' + lineHtml() + '</div><button type="button" class="btn sm" data-a="addLine">+ منتج آخر</button><div class="g3" style="margin-top:10px"><label>خصم<input name="discount" inputmode="decimal" value="0"></label><label>رسوم توصيل على العميل<input name="deliveryFee" inputmode="decimal" value="0"></label><label>تكلفة المندوب علينا<input name="courierCost" inputmode="decimal" value="0"></label></div><label>كود شركة التوصيل (اختياري، يمكن إضافته لاحقًا)<input name="ccode" dir="ltr"></label><label>ملاحظة<input name="note"></label><div class="sum big"><span>الإجمالي</span><span id="otot">—</span></div>', f => {
      const v = fd(f), items = [];
      for (const l of $$('.line', f)) {
        const pid = $('[name=pid]', l).value; if (!pid) continue;
        items.push({ productId: pid, qty: C.toM($('[name=qty]', l).value) / 1000, price: C.toM($('[name=price]', l).value) });
      }
      if (items.some(i => !Number.isInteger(i.qty) || !(i.price >= 0))) { toast('تحقق من الكميات والأسعار', 1); return false; }
      const d = fnum(v.discount, 0), df = fnum(v.deliveryFee, 0), cc = fnum(v.courierCost, 0);
      if ([d, df, cc].some(x => !Number.isFinite(x) || x < 0)) { toast('تحقق من الخصم والرسوم', 1); return false; }
      const code = today().slice(5).replace('-', '') + '-' + C.uid().slice(0, 4).toUpperCase();
      return !!commit('order_create', { id: C.uid(), code, customer: { name: v.name.trim(), phone: C.normDigits(v.phone), city: v.city.trim(), address: v.address.trim() }, items, discount: d, deliveryFee: df, courierCost: cc, courierCode: v.ccode.trim(), channel: v.channel, note: v.note.trim() }) && undefined;
    }, 'حفظ الطلب');
  $('#mf').addEventListener('input', calcOrderForm);
  $('#mf').addEventListener('change', e => { if (e.target.name === 'pid') { const o = e.target.selectedOptions[0], l = e.target.closest('.line'); if (o && o.dataset.price) $('[name=price]', l).value = o.dataset.price; } calcOrderForm(); });
}
function orderDetail(id) {
  const o = S.orders[id]; if (!o) return;
  const next = (C.TRANSITIONS[o.status] || []).filter(s => C.canOp(role(), { type: 'order_status', p: { status: s } }));
  const m = $('#modal');
  m.innerHTML = '<div class="sheet"><div class="row spread"><h2>' + esc(o.code) + '</h2>' + stBadge(o.status) + '</div>' +
    '<div class="card"><b>' + esc(o.customer.name) + '</b> · <a href="tel:' + esc(o.customer.phone) + '" dir="ltr">' + esc(o.customer.phone) + '</a><small class="d">' + esc(o.customer.city) + ' — ' + esc(o.customer.address || '') + '<br>' + o.date + ' · ' + esc(o.channel) + ' · ' + esc((S.users[o.by] || {}).name || '') + (o.note ? '<br>' + esc(o.note) : '') + '</small></div>' +
    '<div class="row spread card"><span>كود شركة التوصيل: <b dir="ltr">' + (o.courierCode ? esc(o.courierCode) : '—') + '</b></span>' + (C.can(role(), 'order_edit') ? '<button class="btn sm" data-a="ccode" data-id="' + o.id + '">' + (o.courierCode ? 'تعديل' : 'إضافة') + '</button>' : '') + '</div>' +
    '<div class="tw"><table>' + o.items.map(i => '<tr><td>' + esc(i.name) + '</td><td class="n">' + i.qty + ' × ' + num(i.price) + '</td><td class="n">' + num(i.qty * i.price) + '</td></tr>').join('') + '</table></div>' +
    '<div class="sum"><span>المنتجات</span><span>' + lyd(o.itemsTotal) + '</span></div>' + (o.discount ? '<div class="sum"><span>خصم</span><span>- ' + lyd(o.discount) + '</span></div>' : '') + (o.deliveryFee ? '<div class="sum"><span>توصيل</span><span>' + lyd(o.deliveryFee) + '</span></div>' : '') +
    '<div class="sum big"><span>الإجمالي</span><span>' + lyd(o.total) + '</span></div><div class="sum"><span>المدفوع</span><span>' + lyd(o.paid) + '</span></div><div class="sum"><span>المتبقي</span><span>' + lyd(o.total - o.paid) + '</span></div>' +
    (seesCost() && o.cogs ? '<div class="sum"><span>التكلفة</span><span>' + lyd(o.cogs) + '</span></div><div class="sum"><span>الربح المتوقع</span><span>' + lyd(o.total - o.cogs - o.courierCost) + '</span></div>' : '') +
    '<h3>السجل</h3>' + o.history.map(h => '<small class="d">' + h.date + ' — ' + C.STATUS[h.status] + ' — ' + esc((S.users[h.by] || {}).name || '') + (h.note ? ' (' + esc(h.note) + ')' : '') + '</small>').join('') +
    '<div class="row" style="margin-top:14px">' + next.map(s => '<button class="btn ' + (s === 'rejected' || s === 'cancelled' || s === 'returned' ? 'red' : 'pri') + '" data-a="status" data-id="' + o.id + '" data-s="' + s + '">' + ({ confirmed: 'تأكيد الطلب', shipped: 'تسليم للمندوب', delivered: 'تم الاستلام', rejected: 'رفضه العميل', cancelled: 'إلغاء', returned: 'مرتجع' })[s] + '</button>').join('') +
    (C.can(role(), 'payment') && o.total - o.paid > 0 && o.status !== 'cancelled' && o.status !== 'rejected' ? '<button class="btn" data-a="pay" data-id="' + o.id + '">تسجيل دفعة</button>' : '') + '<button class="btn" data-a="print" data-id="' + o.id + '">طباعة</button><button class="btn" data-a="close">إغلاق</button></div></div>';
  m.hidden = false;
}
function setStatus(id, s) {
  if (s === 'rejected') {
    return modal('رفض العميل للطلب', '<label>خسارة التوصيل (اتركه 0 إن لم توجد)<input name="loss" inputmode="decimal" value="0"></label><label>السبب<input name="note"></label>', f => { const v = fd(f), l = fnum(v.loss, 0); if (!(l >= 0)) { toast('قيمة غير صحيحة', 1); return false; } if (!commit('order_status', { orderId: id, status: s, lossFee: l, note: v.note })) return false; });
  }
  const label = { confirmed: 'تأكيد الطلب', shipped: 'تسليم الطلب للمندوب (سيُخصم من المخزون)', delivered: 'تأكيد أن العميل استلم الطلب', cancelled: 'إلغاء الطلب', returned: 'تسجيل الطلب كمرتجع وإعادته للمخزون' }[s];
  modal('تأكيد', '<p>' + label + '؟</p>', () => { if (!commit('order_status', { orderId: id, status: s })) return false; }, 'نعم');
}
function courierModal(id) {
  const o = S.orders[id];
  modal('كود شركة التوصيل', '<label>الكود الذي أعطتك إياه الشركة<input name="c" dir="ltr" value="' + esc(o.courierCode || '') + '"></label>', f => { if (!commit('order_edit', { orderId: id, courierCode: f.c.value.trim() })) return false; });
}
function payModal(id) {
  const o = S.orders[id], rem = o.total - o.paid;
  modal('تسجيل دفعة', '<label>المبلغ (د.ل) — المتبقي ' + num(rem) + '<input name="amt" inputmode="decimal" value="' + rem / 1000 + '"></label><label>الطريقة<select><option>نقدًا</option><option>تحويل مصرفي</option><option>محفظة</option><option>تحصيل من شركة التوصيل</option></select></label>', f => { if (!commit('payment', { orderId: id, amt: C.toM(f.amt.value), method: f.querySelector('select').value })) return false; });
}
function printOrder(id) {
  const o = S.orders[id];
  $('#printArea').innerHTML = '<h1>' + esc(S.settings.brand) + '</h1><h2>فاتورة ' + esc(o.code) + '</h2><p>' + o.date + '<br>العميل: ' + esc(o.customer.name) + ' — ' + esc(o.customer.phone) + '<br>العنوان: ' + esc(o.customer.city) + ' ' + esc(o.customer.address || '') + '</p><table><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>المجموع</th></tr>' +
    o.items.map(i => '<tr><td>' + esc(i.name) + '</td><td>' + i.qty + '</td><td>' + num(i.price) + '</td><td>' + num(i.qty * i.price) + '</td></tr>').join('') + '</table><p>خصم: ' + num(o.discount) + ' — توصيل: ' + num(o.deliveryFee) + '</p><h3>الإجمالي: ' + num(o.total) + ' د.ل — المتبقي: ' + num(o.total - o.paid) + ' د.ل</h3>';
  window.print();
}

// ---------- المخزون ----------
function pgStock() {
  const r = role(), cost = seesCost(), t = ui.stab;
  let h = '<div class="row spread"><h2>المخزون</h2><div class="row">' + (C.can(r, 'material_upsert') ? '<button class="btn sm" data-a="editMat">+ مادة خام</button>' : '') + (C.can(r, 'product_upsert') ? '<button class="btn sm" data-a="editProd">+ منتج</button>' : '') + '</div></div>' +
    '<div class="chips">' + [['mat', 'المواد الخام'], ['prod', 'المنتجات الجاهزة'], ['mov', 'الحركة']].map(x => '<button class="chip ' + (t === x[0] ? 'on' : '') + '" data-a="stab" data-id="' + x[0] + '">' + x[1] + '</button>').join('') + '</div>';
  if (t === 'mat') {
    const ms = Object.values(S.materials).filter(m => m.active !== false);
    h += ms.length ? '<div class="tw"><table><tr><th>المادة</th><th class="n">الرصيد</th>' + (cost ? '<th class="n">تكلفة/وحدة</th><th class="n">القيمة</th>' : '') + '<th></th></tr>' + ms.map(m => {
      const low = m.min > 0 && m.qty <= m.min;
      return '<tr><td>' + esc(m.name) + '<small class="d">' + C.MAT_CATS[m.cat] + '</small></td><td class="n ' + (low || m.qty < 0 ? 'low' : '') + '">' + qty(m.qty, m.unit) + '</td>' + (cost ? '<td class="n">' + (m.qty > 0 ? num(Math.round(m.value / m.qty * 1000), 4) : '—') + '</td><td class="n">' + num(m.value) + '</td>' : '') +
        '<td class="n">' + (C.can(r, 'purchase') ? '<button class="btn sm" data-a="buy" data-id="' + m.id + '">شراء</button> ' : '') + (C.can(r, 'adjust') ? '<button class="btn sm" data-a="adj" data-t="material" data-id="' + m.id + '">تسوية</button> ' : '') + (C.can(r, 'material_upsert') ? '<button class="btn sm" data-a="editMat" data-id="' + m.id + '">تعديل</button>' : '') + '</td></tr>';
    }).join('') + '</table></div>' : '<div class="empty">أضف المواد الخام: كحول، زيوت عطرية، زجاجات، بوكسات، ستيكر</div>';
  } else if (t === 'prod') {
    const ps = Object.values(S.products).filter(p => p.active !== false);
    h += ps.length ? '<div class="tw"><table><tr><th>المنتج</th><th class="n">السعر</th>' + (cost ? '<th class="n">التكلفة</th><th class="n">الهامش</th>' : '') + '<th class="n">المخزون</th><th></th></tr>' + ps.map(p => {
      const rc = p.stock > 0 ? Math.round(p.value / p.stock) : C.recipeCost(S, p), mg = p.price > 0 ? Math.round((p.price - rc) / p.price * 100) : 0;
      return '<tr><td>' + esc(p.name) + '<small class="d">' + p.sizeMl + ' مل</small></td><td class="n">' + num(p.price) + '</td>' + (cost ? '<td class="n">' + num(rc) + '</td><td class="n ' + (mg < 30 ? 'low' : '') + '">' + mg + '%</td>' : '') + '<td class="n">' + p.stock + '</td><td class="n">' + (C.can(r, 'production') && p.recipe.length ? '<button class="btn sm" data-a="prod" data-id="' + p.id + '">تعبئة</button> ' : '') + (C.can(r, 'adjust') ? '<button class="btn sm" data-a="adj" data-t="product" data-id="' + p.id + '">تسوية</button> ' : '') + (C.can(r, 'product_upsert') ? '<button class="btn sm" data-a="editProd" data-id="' + p.id + '">تعديل</button>' : '') + '</td></tr>';
    }).join('') + '</table></div>' : '<div class="empty">أضف منتجًا: اسم العطر والزيت وعدد الزجاجات من العبوة، والباقي يُحسب تلقائيًا</div>';
  } else {
    const mv = S.movements.slice().sort((a, b) => b.ts - a.ts).slice(0, 120), K = { purchase: 'شراء', consume: 'استهلاك', produce: 'إنتاج', ship: 'شحن', restock: 'إرجاع', adjust: 'تسوية', opening: 'رصيد افتتاحي' };
    h += mv.length ? '<div class="tw"><table><tr><th>التاريخ</th><th>الحركة</th><th>الصنف</th><th class="n">الكمية</th>' + (cost ? '<th class="n">القيمة</th>' : '') + '</tr>' + mv.map(m => '<tr><td>' + m.date + '</td><td>' + K[m.kind] + '</td><td>' + esc(m.name) + '<small class="d">' + esc(m.note || '') + '</small></td><td class="n">' + (m.type === 'material' ? num(m.qty) : m.qty) + '</td>' + (cost ? '<td class="n">' + num(m.value) + '</td>' : '') + '</tr>').join('') + '</table></div>' : '<div class="empty">لا توجد حركات</div>';
  }
  return h;
}
function matModal(id) {
  const m = S.materials[id] || {}, isNew = !id;
  modal(id ? 'تعديل مادة' : 'مادة خام جديدة', '<label>الاسم<input name="name" value="' + esc(m.name || '') + '" placeholder="مثال: كحول إيثانول 96%"></label><div class="g2"><label>التصنيف<select name="cat">' + opt(C.MAT_CATS, m.cat) + '</select></label><label>وحدة القياس<select name="unit">' + opt(C.UNITS, m.unit) + '</select></label></div><label>حد التنبيه عند النقص<input name="min" inputmode="decimal" value="' + (m.min ? m.min / 1000 : 0) + '"></label>' +
    (isNew ? '<h3>ما عندك منها الآن (اختياري)</h3><div class="g2"><label>الكمية الموجودة<input name="q0" inputmode="decimal"></label><label>إجمالي ما دفعته (د.ل)<input name="a0" inputmode="decimal"></label></div><p class="hint">اتركهما فارغين إن لم تشترِها بعد، وسجّل الشراء لاحقًا من زر «شراء». الزيت والكحول: اختر الوحدة «مل»، والزجاجة بغطائها ورشاشها قطعة واحدة.</p>' : ''), f => {
    const v = fd(f), mn = fnum(v.min, 0);
    if (!(mn >= 0)) { toast('حد التنبيه غير صحيح', 1); return false; }
    let buy = null;
    if (isNew && (v.q0.trim() || v.a0.trim())) {
      const q = C.toM(v.q0), a = C.toM(v.a0);
      if (!(q > 0) || !(a > 0)) { toast('أدخل الكمية والمبلغ معًا، أو اتركهما فارغين', 1); return false; }
      buy = { q, a };
    }
    const mid = id || C.uid();
    if (!commit('material_upsert', { id: mid, name: v.name.trim(), cat: v.cat, unit: v.unit, min: mn })) return false;
    if (buy && !commit('purchase', { materialId: mid, qty: buy.q, amt: buy.a, currency: 'LYD', rate: 0, supplier: 'رصيد أولي' })) return false;
  });
}
function buyModal(id) {
  const m = S.materials[id];
  modal('شراء: ' + m.name, '<label>الكمية (' + C.UNITS[m.unit] + ')<input name="qty" inputmode="decimal"></label><div class="g2"><label>إجمالي السعر<input name="amt" inputmode="decimal"></label><label>العملة<select name="cur"><option value="LYD">دينار</option><option value="USD">دولار</option></select></label></div><label>سعر الصرف<input name="rate" inputmode="decimal" value="' + (S.settings.rate / 1000 || '') + '"></label><p class="hint">يُستخدم سعر الصرف عند الشراء بالدولار وتُسجَّل التكلفة بالدينار.</p><label>المورد<input name="sup"></label>', f => {
    const v = fd(f);
    if (!commit('purchase', { materialId: id, qty: C.toM(v.qty), amt: C.toM(v.amt), currency: v.cur, rate: C.toM(v.rate), supplier: v.sup.trim() })) return false;
  });
}
function adjModal(target, id) {
  const it = target === 'material' ? S.materials[id] : S.products[id];
  modal('تسوية: ' + it.name, '<p class="hint">للجرد أو التالف أو الكسر. أدخل الفرق بالسالب للنقص وبالموجب للزيادة.</p><label>الفرق' + (target === 'material' ? ' (' + C.UNITS[it.unit] + ')' : ' (عدد)') + '<input name="d" inputmode="decimal" placeholder="-5"></label><label>السبب (مطلوب)<input name="r"></label>', f => {
    const v = fd(f), d = target === 'material' ? C.toM(v.d) : Number(C.normDigits(v.d));
    if (!commit('adjust', { target, id, delta: d, reason: v.r })) return false;
  });
}
const PACK_CATS = ['glass', 'box', 'sticker', 'bag', 'other'];
function blendFrom(f) {
  const size = Number(C.normDigits(f.size.value)) || 0, cont = C.toM(f.cont.value), y = Number(C.normDigits(f.yield.value)) || 0;
  const oil = S.materials[f.oil.value], alc = S.materials[f.alc.value];
  if (!oil) return { none: true };
  if (!(size > 0) || !(cont > 0) || !(y > 0) || !Number.isInteger(y)) return { err: 'أدخل الحجم وحجم عبوة الزيت وعدد الزجاجات' };
  if (!alc) return { err: 'اختر الكحول (أو أضفه من المخزون)' };
  const oilM = Math.round(cont / y), alcM = size * 1000 - oilM;
  if (alcM <= 0) return { err: 'الزيت للزجاجة أكبر من حجمها: راجع عدد الزجاجات' };
  const recipe = [{ materialId: oil.id, qty: oilM }, { materialId: alc.id, qty: alcM }];
  const packs = $$('[name=pk]:checked', f).map(c => c.value);
  packs.forEach(pid => recipe.push({ materialId: pid, qty: 1000 }));
  return { recipe, packs, oilM, alcM, oil: { oilId: oil.id, cont, yield: y, alcId: alc.id }, cost: C.recipeCost(S, { recipe }) };
}
function prodModal(id) {
  const pr = S.products[id];
  if (pr && !pr.oil && pr.recipe.length) return prodModalAdv(id);
  const mats = Object.values(S.materials).filter(m => m.active !== false);
  const oils = mats.filter(m => m.cat === 'oil'), alcs = mats.filter(m => m.cat === 'alcohol'), packs = mats.filter(m => PACK_CATS.includes(m.cat));
  const o = (pr && pr.oil) || {}, last = pr ? pr.recipe.map(l => l.materialId) : LS.get('lastPack', null);
  modal(id ? 'تعديل منتج' : 'منتج جديد',
    '<label>اسم العطر<input name="name" value="' + esc(pr ? pr.name : '') + '"></label><div class="g2"><label>الحجم (مل)<input name="size" inputmode="numeric" value="' + ((pr && pr.sizeMl) || 50) + '"></label><label>سعر البيع (د.ل)<input name="price" inputmode="decimal" value="' + (pr && pr.price ? pr.price / 1000 : '') + '"></label></div>' +
    '<h3>التصنيع</h3><label>الزيت العطري<select name="oil"><option value="">بدون تصنيع (منتج جاهز فقط)</option>' + oils.map(m => '<option value="' + m.id + '"' + (m.id === o.oilId ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select></label>' +
    '<div class="g2"><label>حجم عبوة الزيت<input name="cont" inputmode="decimal" value="' + (o.cont ? o.cont / 1000 : 100) + '"></label><label>كم زجاجة تخرج منها؟<input name="yield" inputmode="numeric" value="' + (o.yield || '') + '"></label></div>' +
    '<label>الكحول<select name="alc">' + (alcs.length ? '' : '<option value="">أضف الكحول أولًا</option>') + alcs.map(m => '<option value="' + m.id + '"' + (m.id === o.alcId ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select></label>' +
    '<h3>التغليف لكل زجاجة</h3>' + (packs.length ? packs.map(m => '<label style="display:flex;align-items:center;gap:8px;color:var(--ink)"><input type="checkbox" name="pk" value="' + m.id + '" style="width:auto;margin:0"' + (!last || last.includes(m.id) ? ' checked' : '') + '>' + esc(m.name) + '</label>').join('') : '<p class="hint">أضف الزجاجة والعلبة والستيكر والكيس كمواد خام لتظهر هنا.</p>') +
    '<div class="alert info" id="pv" style="margin-top:8px"></div>' +
    '<h3>' + (id ? 'إضافة رصيد جاهز' : 'عندك منه جاهز الآن؟ (اختياري)') + '</h3><div class="g2"><label>عدد الزجاجات<input name="n0" inputmode="numeric"></label><label>تكلفة الزجاجة (د.ل)<input name="c0" inputmode="decimal"></label></div><p class="hint">اترك التكلفة فارغة لاعتماد تكلفة التصنيع المحسوبة أعلاه.</p>' +
    '<button type="button" class="btn sm" data-a="advProd" data-id="' + (id || '') + '">متقدم: تحديد التركيبة يدويًا</button>',
    f => {
      const v = fd(f), size = Number(C.normDigits(v.size)) || 0, price = C.toM(v.price);
      let recipe = [], oil = null, b = { none: true };
      if (v.oil) {
        b = blendFrom(f);
        if (b.err) { toast(b.err, 1); return false; }
        recipe = b.recipe; oil = b.oil;
      }
      let n0 = 0, c0 = 0;
      if (v.n0.trim()) {
        n0 = Number(C.normDigits(v.n0)); c0 = v.c0.trim() ? C.toM(v.c0) : (b.cost || NaN);
        if (!Number.isInteger(n0) || n0 <= 0) { toast('عدد الزجاجات الجاهزة غير صحيح', 1); return false; }
        if (!(c0 >= 0)) { toast('أدخل تكلفة الزجاجة الجاهزة', 1); return false; }
      }
      const pid = id || C.uid();
      if (!commit('product_upsert', { id: pid, name: v.name.trim(), sizeMl: size, price, recipe, oil })) return false;
      if (b.packs) LS.set('lastPack', b.packs);
      if (n0 && !commit('adjust', { target: 'product', id: pid, delta: n0, opening: true, unitCost: c0, reason: 'رصيد افتتاحي' })) return false;
    });
  const pv = () => {
    const f = $('#mf'), b = blendFrom(f), box = $('#pv');
    if (!box) return;
    if (b.none) box.textContent = 'منتج جاهز بدون تصنيع: لن يظهر له زر «تعبئة»، وتضيف رصيده من الخانة أدناه.';
    else if (b.err) box.textContent = b.err;
    else box.innerHTML = 'للزجاجة الواحدة: زيت <b>' + num(b.oilM) + '</b> + كحول <b>' + num(b.alcM) + '</b> + ' + b.packs.length + ' من التغليف' + (seesCost() ? '<br>التكلفة التقريبية: <b>' + (b.cost ? num(b.cost) + ' د.ل' : '— (سجّل شراء المواد أولًا)') + '</b>' : '');
  };
  $('#mf').addEventListener('input', pv); $('#mf').addEventListener('change', pv); pv();
}
function prodModalAdv(id) {
  const pr = S.products[id] || { recipe: [] }, mats = Object.values(S.materials).filter(m => m.active !== false);
  if (!mats.length) return toast('أضف المواد الخام أولًا', 1);
  const rl = l => '<div class="line"><label>المكوّن<select name="mid">' + mats.map(m => '<option value="' + m.id + '"' + (l && l.materialId === m.id ? ' selected' : '') + '>' + esc(m.name) + ' (' + C.UNITS[m.unit] + ')</option>').join('') + '</select></label><label>الكمية لكل وحدة<input name="rq" inputmode="decimal" value="' + (l ? l.qty / 1000 : '') + '"></label><span></span><button type="button" class="x" data-a="rmLine">×</button></div>';
  modal(id ? 'تعديل منتج' : 'منتج جديد', '<label>الاسم<input name="name" value="' + esc(pr.name || '') + '"></label><div class="g2"><label>الحجم (مل)<input name="size" inputmode="numeric" value="' + (pr.sizeMl || '') + '"></label><label>سعر البيع (د.ل)<input name="price" inputmode="decimal" value="' + (pr.price ? pr.price / 1000 : '') + '"></label></div><h3>التركيبة لوحدة واحدة</h3><div id="lines">' + (pr.recipe.length ? pr.recipe.map(rl).join('') : rl(null)) + '</div><button type="button" class="btn sm" id="addR">+ مكوّن</button><p class="hint">مثال لعطر 50 مل: كحول 35 مل + زيت 15 مل + زجاجة 1 + بوكس 1 + ستيكر 1. تغيير التركيبة لا يغيّر تكلفة ما عُبِّئ سابقًا.</p>', f => {
    const v = fd(f), recipe = $$('.line', f).map(l => ({ materialId: $('[name=mid]', l).value, qty: C.toM($('[name=rq]', l).value) }));
    if (recipe.some(x => !(x.qty > 0))) { toast('أدخل كمية صحيحة لكل مكوّن', 1); return false; }
    const price = C.toM(v.price);
    if (!commit('product_upsert', { id: id || C.uid(), name: v.name.trim(), sizeMl: Number(C.normDigits(v.size)) || 0, price, recipe })) return false;
  });
  $('#addR').onclick = () => { $('#lines').insertAdjacentHTML('beforeend', rl(null)); };
}
function produceModal(id) {
  const p = S.products[id];
  if (!p.recipe.length) return toast('هذا المنتج بلا تصنيع. أضف رصيده الجاهز من «تعديل».', 1);
  const y = (p.oil && p.oil.yield) || 0;
  modal('تعبئة: ' + p.name, (y ? '<div class="g2"><label>عبوات الزيت التي فتحتها<input name="c" inputmode="numeric" value="1"></label><label>عدد الزجاجات<input name="u" inputmode="numeric" value="' + y + '"></label></div><p class="hint">كل عبوة تعطي ' + y + ' زجاجات. عدّل عدد الزجاجات إن لم تُنهِ العبوة.</p>' : '<label>عدد الوحدات المعبّأة<input name="u" inputmode="numeric" value="1"></label>') + '<div id="need"></div><label>ملاحظة<input name="n"></label>', f => {
    const u = Number(C.normDigits(f.u.value));
    if (!commit('production', C.productionPayload(S, id, u, f.n.value))) return false;
  }, 'تنفيذ التعبئة');
  const f = $('#mf'), upd = () => {
    const u = Number(C.normDigits(f.u.value)) || 0;
    $('#need').innerHTML = '<h3>سيُخصم من المخزون</h3>' + p.recipe.map(l => {
      const m = S.materials[l.materialId] || { name: '؟', qty: 0, unit: 'pcs' }, need = l.qty * u, ok = m.qty >= need;
      return '<div class="sum"><span>' + esc(m.name) + '</span><span class="' + (ok ? '' : 'low') + '">' + qty(need, m.unit) + ' <small class="d">(المتاح ' + num(m.qty) + ')</small></span></div>';
    }).join('');
  };
  if (f.c) f.c.oninput = () => { f.u.value = (Number(C.normDigits(f.c.value)) || 0) * y; upd(); };
  f.u.oninput = upd; upd();
}

// ---------- المصروفات ----------
function pgExp() {
  const [f, t] = range(ui.period), list = S.expenses.filter(e => (!f || e.date >= f) && (!t || e.date <= t)).sort((a, b) => (a.date < b.date ? 1 : -1));
  return '<div class="row spread"><h2>المصروفات</h2>' + (C.can(role(), 'expense') ? '<button class="btn pri" data-a="newExp">+ مصروف</button>' : '') + '</div>' + periodChips() +
    '<div class="kpis">' + kpi('الإجمالي', lyd(list.reduce((a, e) => a + e.lyd, 0))) + kpi('إعلانات ومشاهير', lyd(list.filter(e => C.AD_CATS.includes(e.cat)).reduce((a, e) => a + e.lyd, 0))) + '</div>' +
    (list.length ? '<div class="tw"><table><tr><th>التاريخ</th><th>النوع</th><th class="n">المبلغ</th></tr>' + list.map(e => '<tr><td>' + e.date + '</td><td>' + C.EXP_CATS[e.cat] + '<small class="d">' + esc(e.note || '') + (e.auto ? ' · تلقائي' : '') + '</small></td><td class="n">' + num(e.lyd) + (e.cur === 'USD' ? '<small class="d">$' + num(e.orig) + '</small>' : '') + '</td></tr>').join('') + '</table></div>' : '<div class="empty">لا توجد مصروفات في هذه الفترة</div>') +
    '<p class="hint">شراء المواد الخام والتغليف يُسجَّل من «المخزون» ويدخل التكلفة عند التعبئة والبيع، فلا يُسجَّل هنا.</p>';
}
function expModal() {
  modal('مصروف جديد', '<label>النوع<select name="cat">' + opt(C.EXP_CATS).replace(/<option value="delivery_loss">[^<]*<\/option>/, '') + '</select></label><div class="g2"><label>المبلغ<input name="amt" inputmode="decimal"></label><label>العملة<select name="cur"><option value="LYD">دينار</option><option value="USD">دولار</option></select></label></div><label>سعر الصرف<input name="rate" inputmode="decimal" value="' + (S.settings.rate / 1000 || '') + '"></label><label>تفاصيل (اسم المشهور / الحملة)<input name="note"></label><label>التاريخ<input name="date" type="date" value="' + today() + '"></label>', f => {
    const v = fd(f);
    if (!commit('expense', { cat: v.cat, amt: C.toM(v.amt), currency: v.cur, rate: C.toM(v.rate), note: v.note.trim() }, v.date || today())) return false;
  });
}

// ---------- التقارير ----------
function toCSV(rows) { return '﻿' + rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n'); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function pgRep() {
  if (!seesCost()) return '<div class="empty">غير متاح لصلاحيتك</div>';
  const [f, t] = range(ui.period), r = C.report(S, f, t), row = (l, v, b) => '<div class="sum' + (b ? ' big' : '') + '"><span>' + l + '</span><span>' + lyd(v) + ' <small class="d" dir="ltr">' + usdv(v) + '</small></span></div>';
  return '<h2>التقارير</h2>' + periodChips() + '<div class="card"><h3 style="margin-top:0">الأرباح والخسائر</h3>' + row('الإيراد (طلبات مستلمة)', r.revenue) + row('تكلفة البضاعة المباعة', -r.cogs) + row('مجمل الربح', r.gross, 1) +
    Object.keys(r.byCat).map(c => row(C.EXP_CATS[c], -r.byCat[c])).join('') + (r.shrink ? row('فاقد وتسويات', -r.shrink) : '') + row('صافي الربح', r.net, 1) + '</div>' +
    '<div class="card"><h3 style="margin-top:0">كفاءة الإعلانات</h3><div class="sum"><span>الإنفاق</span><span>' + lyd(r.adSpend) + '</span></div><div class="sum"><span>طلبات جديدة</span><span>' + r.created + '</span></div><div class="sum"><span>تكلفة الطلب الجديد</span><span>' + (r.created ? lyd(r.costPerOrder) : '—') + '</span></div><div class="sum"><span>تكلفة الطلب المستلم</span><span>' + (r.delivered ? lyd(r.costPerDelivered) : '—') + '</span></div><div class="sum"><span>العائد على الإعلان</span><span>' + (r.adSpend ? r.roas.toFixed(2) + '×' : '—') + '</span></div><div class="sum"><span>نسبة رفض الاستلام</span><span>' + Math.round(r.rejectRate * 100) + '%</span></div></div>' +
    (r.byProduct.length ? '<div class="tw"><table><tr><th>المنتج</th><th class="n">مباع</th><th class="n">إيراد</th><th class="n">ربح</th></tr>' + r.byProduct.map(p => '<tr><td>' + esc(p.name) + '</td><td class="n">' + p.qty + '</td><td class="n">' + num(p.revenue) + '</td><td class="n">' + num(p.profit) + '</td></tr>').join('') + '</table></div><p class="hint">أرباح المنتجات قبل الخصم والتوصيل.</p>' : '') +
    '<h3>تصدير</h3><div class="row">' + Object.keys(C.views(S)).map(k => '<button class="btn sm" data-a="csv" data-id="' + esc(k) + '">' + esc(k) + '</button>').join('') + '</div>';
}

// ---------- الإعدادات ----------
function describe(o) {
  const p = o.p, u = (S.users[o.by] || {}).name || '';
  const t = { user_upsert: 'مستخدم: ' + p.name, settings_set: 'إعدادات', material_upsert: 'مادة: ' + p.name, product_upsert: 'منتج: ' + p.name, purchase: 'شراء ' + ((S.materials[p.materialId] || {}).name || ''), production: 'تعبئة ' + p.units + ' × ' + ((S.products[p.productId] || {}).name || ''), order_create: 'طلب ' + p.code, order_edit: 'كود توصيل ' + ((S.orders[p.orderId] || {}).code || ''), order_status: 'حالة ' + ((S.orders[p.orderId] || {}).code || '') + ' ← ' + C.STATUS[p.status], payment: 'دفعة ' + num(p.amt), expense: 'مصروف ' + C.EXP_CATS[p.cat] + ' ' + num(p.amt), adjust: 'تسوية: ' + p.reason, void: 'إلغاء عملية' }[o.type];
  return o.date + ' · ' + t + ' · ' + u;
}
function pgSet() {
  const r = role(), cfg = LS.get('api', null), own = r === 'owner';
  let h = '<h2>الإعدادات</h2><div class="card"><b>' + esc(USER.name) + '</b> · ' + C.ROLES[r] + '<div class="row" style="margin-top:8px"><button class="btn" data-a="logout">تسجيل الخروج</button></div></div>';
  h += '<div class="card"><b>المزامنة مع جوجل شيت</b><p class="hint">' + (cfg ? 'مرتبط. كل عملية تُحفظ على الجهاز أولًا ثم تُرفع عند توفر الإنترنت.' : 'غير مرتبط: البيانات محفوظة على هذا الجهاز فقط.') + '</p><div class="row"><button class="btn" data-a="connect">' + (cfg ? 'تغيير الربط' : 'ربط') + '</button>' + (cfg ? '<button class="btn pri" data-a="syncNow">مزامنة الآن</button>' : '') + '</div></div>';
  if (own) {
    h += '<div class="card"><b>سعر الصرف</b><p class="hint">' + num(S.settings.rate) + ' دينار لكل دولار. يُطبَّق على العمليات الجديدة فقط، والقديمة تحتفظ بسعرها.</p><button class="btn" data-a="rate">تعديل</button></div>';
    h += '<div class="card"><div class="row spread"><b>المستخدمون</b><button class="btn sm" data-a="user">+ مستخدم</button></div>' + Object.values(S.users).map(u => '<div class="sum"><span>' + esc(u.name) + ' · ' + C.ROLES[u.role] + (u.active === false ? ' (موقوف)' : '') + '</span><span><button class="btn sm" data-a="user" data-id="' + u.id + '">تعديل</button></span></div>').join('') + '</div>';
  }
  if (seesCost()) {
    const log = OPS.filter(o => o.type !== 'void' && !S.voided.has(o.id) && !['user_upsert', 'settings_set'].includes(o.type)).sort((a, b) => b.ts - a.ts).slice(0, 30);
    h += '<div class="card"><b>آخر العمليات</b><p class="hint">إلغاء عملية يعكس أثرها بالكامل ويبقى سجلها محفوظًا.</p>' + log.map(o => '<div class="sum"><span>' + esc(describe(o)) + '</span><button class="btn sm red" data-a="void" data-id="' + o.id + '">إلغاء</button></div>').join('') + '</div>';
    h += '<div class="card"><b>نسخة احتياطية</b><div class="row" style="margin-top:8px"><button class="btn" data-a="backup">تنزيل نسخة</button><label class="btn" style="margin:0">استعادة<input type="file" id="restore" accept=".json" hidden></label></div></div>';
  }
  return h + '<p class="hint" style="text-align:center">الإصدار ' + C.VERSION + ' · جهاز ' + DEV + ' · ' + S.opsCount + ' عملية</p>';
}
function userModal(id) {
  const u = S.users[id] || {};
  modal(id ? 'تعديل مستخدم' : 'مستخدم جديد', '<label>الاسم<input name="name" value="' + esc(u.name || '') + '"></label><label>الدور<select name="role">' + opt(C.ROLES, u.role || 'sales') + '</select></label><label>رمز سري جديد' + (id ? ' (اتركه فارغًا للإبقاء)' : '') + '<input name="pin" type="password" inputmode="numeric"></label>' + (id ? '<label>الحالة<select name="active"><option value="1"' + (u.active !== false ? ' selected' : '') + '>فعّال</option><option value="0"' + (u.active === false ? ' selected' : '') + '>موقوف</option></select></label>' : ''), f => {
    const v = fd(f), pin = C.normDigits(v.pin);
    if (!id && !/^\d{4,}$/.test(pin)) { toast('الرمز السري 4 أرقام على الأقل', 1); return false; }
    if (pin && !/^\d{4,}$/.test(pin)) { toast('الرمز السري 4 أرقام على الأقل', 1); return false; }
    const rec = Object.assign({}, u, { id: id || C.uid(), name: v.name.trim(), role: v.role, active: id ? v.active === '1' : true });
    if (pin) { rec.salt = C.uid().slice(0, 8); rec.hash = C.hashPin(pin, rec.salt); }
    if (id === USER.id && (rec.role !== 'owner' || rec.active === false)) { toast('لا يمكنك تقليل صلاحيتك أو إيقاف نفسك', 1); return false; }
    if (!commit('user_upsert', rec)) return false;
  });
}

// ---------- الأحداث ----------
const A = {
  tab: t => { ui.tab = t.dataset.id; render(); },
  period: t => { ui.period = t.dataset.id; render(); },
  ostatus: t => { ui.ostatus = t.dataset.id; render(); },
  stab: t => { ui.stab = t.dataset.id; render(); },
  close: closeModal,
  connect: connectModal, logout,
  syncNow: () => sync(true).then(ok => { toast(ok ? 'تمت المزامنة' : 'تعذرت المزامنة: ' + lastErr, !ok); render(); }),
  newOrder, order: t => orderDetail(t.dataset.id), status: t => setStatus(t.dataset.id, t.dataset.s), pay: t => payModal(t.dataset.id), ccode: t => courierModal(t.dataset.id), print: t => printOrder(t.dataset.id),
  addLine: () => $('#lines').insertAdjacentHTML('beforeend', lineHtml()),
  rmLine: t => { const ls = $$('.line'); if (ls.length > 1) { t.closest('.line').remove(); calcOrderForm(); } },
  editMat: t => matModal(t.dataset.id), editProd: t => prodModal(t.dataset.id), advProd: t => prodModalAdv(t.dataset.id || undefined), buy: t => buyModal(t.dataset.id), adj: t => adjModal(t.dataset.t, t.dataset.id), prod: t => produceModal(t.dataset.id),
  newExp: expModal, user: t => userModal(t.dataset.id),
  rate: () => modal('سعر الصرف', '<label>دينار لكل 1 دولار<input name="r" inputmode="decimal" value="' + S.settings.rate / 1000 + '"></label>', f => { if (!commit('settings_set', { rate: C.toM(f.r.value) })) return false; }),
  void: t => askConfirm('سيتم عكس أثر هذه العملية بالكامل. متأكد؟', () => commit('void', { target: t.dataset.id })),
  csv: t => { const v = C.views(S)[t.dataset.id]; if (v) download(t.dataset.id + '.csv', toCSV(v)); },
  backup: () => download('backup-' + today() + '.json', JSON.stringify(OPS.map(strip)), 'application/json')
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-a]'); if (!t) return;
  if (t.tagName === 'A') e.preventDefault();
  if (A[t.dataset.a]) A[t.dataset.a](t);
});
document.addEventListener('change', e => {
  if (e.target.id !== 'restore' || !e.target.files[0]) return;
  e.target.files[0].text().then(txt => {
    const list = JSON.parse(txt), have = new Set(OPS.map(o => o.id)), add = list.filter(o => o && o.id && o.type && o.p && !have.has(o.id));
    add.forEach(o => { o._s = 0; OPS.push(o); }); idbPut(add); recompute(); render(); scheduleSync(); toast('تمت استعادة ' + add.length + ' عملية');
  }).catch(() => toast('ملف غير صالح', 1));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ---------- التشغيل ----------
(async function boot() {
  await idbOpen();
  OPS = await idbAll(); recompute();
  const sid = LS.get('session', null); if (sid && S.users[sid] && S.users[sid].active !== false) USER = S.users[sid];
  render(); sync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();
