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
let OPS = [], S = C.emptyState(), USER = null, ui = { tab: 'dash', period: 'month', ostatus: 'all', q: '', stab: 'mat', etab: 'exp', mtab: '', cq: '', dtab: 'in', rtab: 'pl' }, syncing = false, lastErr = '';
let DEV = LS.get('dev', null); if (!DEV) { DEV = C.uid().slice(0, 8); LS.set('dev', DEV); }
const recompute = () => { S = C.reduce(OPS); };
const role = () => (USER ? USER.role : '');
const seesCost = () => ['owner', 'manager', 'accountant'].includes(role());
const canEdit = () => role() !== 'accountant';
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
// ---------- الدخول والإعداد ----------
function brandHead() {
  return '<img class="logo" src="logo.png" alt=""><img class="word" src="wordmark.png" alt="عطور سانفوير"><div class="tag">Where greatness is the only essence</div>';
}
function renderLogin() {
  const users = Object.values(S.users).filter(u => u.active !== false);
  if (!users.length) {
    $('#app').innerHTML = '<div class="login">' + brandHead() + '<h2>إعداد المنظومة</h2>' +
      '<form id="setup" class="card" novalidate><label>اسمك (المالك)<input name="name" required></label>' +
      '<label>رمز سري (4 أرقام فأكثر)<input name="pin" type="password" inputmode="numeric" minlength="4" required></label>' +
      '<label>سعر الصرف: كم دينارًا يساوي 1 دولار<input name="rate" inputmode="decimal" placeholder="مثال: 7.20" required></label><button class="btn pri wide">ابدأ</button></form>' +
      '<div class="card"><b>لديك منظومة تعمل على جهاز آخر؟</b><p class="hint">اربط هذا الجهاز بنفس جوجل شيت وستنتقل كل البيانات إليه.</p><button class="btn wide" data-a="connect">ربط بجوجل شيت</button></div></div>';
    $('#setup').onsubmit = e => {
      e.preventDefault(); const v = fd(e.target), rate = C.toM(v.rate);
      if (!v.name.trim()) return toast('اكتب اسمك', 1);
      if (!/^\d{4,}$/.test(C.normDigits(v.pin))) return toast('الرمز السري 4 أرقام على الأقل', 1);
      if (!(rate > 0)) return toast('سعر الصرف غير صحيح', 1);
      const id = C.uid(), salt = C.uid().slice(0, 8);
      USER = { id, role: 'owner', name: v.name.trim() };
      const mk = (type, p) => ({ id: C.uid(), ts: Date.now(), date: today(), dev: DEV, by: id, type, p });
      const a = mk('user_upsert', { id, name: v.name.trim(), role: 'owner', salt, hash: C.hashPin(C.normDigits(v.pin), salt), active: true });
      const b = mk('settings_set', { rate, brand: 'سانفوير' }); b.ts++;
      OPS.push(a, b); idbPut([a, b]); recompute(); LS.set('session', id); scheduleSync(); render();
    };
    return;
  }
  $('#app').innerHTML = '<div class="login">' + brandHead() + '<form id="lg" class="card" novalidate><label>المستخدم<select name="u">' +
    users.map(u => '<option value="' + u.id + '">' + esc(u.name) + ' — ' + C.ROLES[u.role] + '</option>').join('') + '</select></label><label>الرمز السري<input name="pin" type="password" inputmode="numeric" autocomplete="off"></label><button class="btn pri wide">دخول</button></form>' +
    '<p class="hint" style="text-align:center">' + (LS.get('api', null) ? '' : '<a href="#" data-a="connect">ربط بجوجل شيت</a>') + '</p></div>';
  $('#lg').onsubmit = e => {
    e.preventDefault(); const v = fd(e.target), u = S.users[v.u];
    if (u && u.active !== false && C.hashPin(C.normDigits(v.pin), u.salt) === u.hash) { USER = u; LS.set('session', u.id); ui.tab = 'dash'; render(); sync(); }
    else toast('الرمز السري غير صحيح', 1);
  };
}

// ---------- الهيكل والتنقل ----------
const SVG = d => '<svg viewBox="0 0 24 24">' + d + '</svg>';
const ICON = {
  dash: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>', orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>', stock: '<path d="M3 8l9-5 9 5-9 5zM3 8v8l9 5 9-5V8M12 13v8"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', cust: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  debts: '<path d="M4 7h16v12H4zM4 7l2-3h12l2 3M9 13h6"/>', exp: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5C9.5 8 14.5 8 14.5 10s-5 2-5 4 5 2 5.5.5"/>',
  rep: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', set: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'
};
const NAV_LABEL = { dash: 'الرئيسية', orders: 'الطلبات', stock: 'المخزون', more: 'المزيد' };
function navItems() {
  const r = role();
  if (r === 'sales') return ['dash', 'orders', 'fab', 'more'];
  if (r === 'warehouse') return ['orders', 'stock', 'more'];
  if (r === 'ads') return ['dash', 'more'];
  if (r === 'accountant') return ['dash', 'orders', 'stock', 'more'];
  return ['dash', 'orders', 'fab', 'stock', 'more'];
}
function moreItems() {
  const r = role(), all = [['cust', 'العملاء', 'سجل العملاء وطلباتهم', ['owner', 'manager', 'accountant', 'sales']], ['debts', 'الديون', 'لنا وعلينا والسلف', ['owner', 'manager', 'accountant']],
    ['exp', 'المصروفات والمسحوبات', 'مصروفات العمل والمسحوبات الشخصية', ['owner', 'manager', 'accountant', 'ads']], ['rep', 'التقارير', 'الأرباح والحملات والعملاء', ['owner', 'manager', 'accountant', 'ads']], ['set', 'الإعدادات', 'الحساب والفريق والمزامنة', ['owner', 'manager', 'accountant', 'sales', 'warehouse', 'ads']]];
  return all.filter(x => x[3].includes(r));
}
const PAGES = () => ({ dash: pgDash, orders: pgOrders, stock: pgStock, more: pgMore, cust: pgCust, debts: pgDebts, exp: pgExp, rep: pgRep, set: pgSet });
function render() {
  if (!USER) return renderLogin();
  const nav = navItems(), subs = moreItems().map(x => x[0]);
  if (!nav.includes(ui.tab) && !subs.includes(ui.tab)) ui.tab = nav.find(x => x !== 'fab');
  if (!PAGES()[ui.tab]) ui.tab = nav.find(x => x !== 'fab');
  const cur = subs.includes(ui.tab) ? 'more' : ui.tab;
  $('#app').innerHTML = '<div class="top"><img class="mark" src="logo.png" alt=""><h1>SANVOIR</h1><span id="sb" class="badge"></span></div><main id="pg"></main><nav class="nav">' +
    nav.map(x => x === 'fab' ? '<button class="fab" data-a="newOrder" aria-label="طلب جديد"><span>' + SVG(ICON.plus) + '</span></button>' : '<button data-a="tab" data-id="' + x + '" class="' + (cur === x ? 'on' : '') + '">' + SVG(ICON[x]) + NAV_LABEL[x] + '</button>').join('') + '</nav>';
  $('#pg').innerHTML = PAGES()[ui.tab]();
  setBadge();
  if (ui.tab === 'orders') bindOrders();
  if (ui.tab === 'dash') bindSearch();
  if (ui.tab === 'cust') bindCust();
}
const backBar = title => '<div class="row" style="margin-bottom:6px"><button class="btn sm" data-a="tab" data-id="more">‹ المزيد</button></div><h2>' + title + '</h2>';
function periodChips() {
  return '<div class="chips">' + [['today', 'اليوم'], ['week', '7 أيام'], ['month', 'هذا الشهر'], ['all', 'الكل']].map(p => '<button class="chip ' + (ui.period === p[0] ? 'on' : '') + '" data-a="period" data-id="' + p[0] + '">' + p[1] + '</button>').join('') + '</div>';
}
const kpi = (label, val, sub, cls) => '<div class="kpi ' + (cls || '') + '"><small>' + label + '</small><b>' + val + '</b>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';
const help = t => '<div class="help">' + t + '</div>';
function pgMore() {
  const items = moreItems();
  return '<h2>المزيد</h2><div class="menu">' + items.map(x => '<button class="item" data-a="tab" data-id="' + x[0] + '">' + SVG(ICON[x[0]]) + '<span class="grow"><b>' + x[1] + '</b><small class="d">' + x[2] + '</small></span><span style="color:var(--gold)">‹</span></button>').join('') + '</div>' +
    '<div class="card" style="text-align:center;margin-top:14px"><img src="logo.png" alt="" style="height:64px"><div style="font-family:var(--serif);letter-spacing:.2em;color:var(--gold2);margin-top:4px">SANVOIR</div></div>';
}

// ---------- الرئيسية ----------
function goalCard(r) {
  const g = S.settings.goalOrders || 0;
  if (!g) return role() === 'owner' ? '<div class="card tap" data-a="goal"><b>الهدف الشهري</b><small class="d">اضغط لتحديد هدف عدد الطلبات المستلمة هذا الشهر</small></div>' : '';
  const pc = Math.min(100, Math.round(r.delivered / g * 100)), left = Math.max(0, g - r.delivered);
  return '<div class="card' + (role() === 'owner' ? ' tap" data-a="goal' : '') + '"><div class="row spread"><b>الهدف الشهري</b><span class="pill">' + pc + '%</span></div><div class="bar" style="margin:8px 0"><i style="width:' + pc + '%"></i></div><small class="d">' + r.delivered + ' من ' + g + ' طلب مستلم' + (left ? ' · المتبقي ' + left : ' · تحقق الهدف 🎉') + '</small></div>';
}
function pgDash() {
  const r = role(), cost = seesCost(), td = today(), rT = C.report(S, td, td), [mf, mt] = range('month'), rM = C.report(S, mf, mt);
  if (r === 'ads') return '<h2>الحملات الإعلانية</h2><div class="kpis">' + kpi('إنفاق الشهر', lyd(rM.adSpend), usdv(rM.adSpend), 'gold') + kpi('طلبات جديدة', rM.created) + kpi('تكلفة الطلب', rM.created ? lyd(rM.costPerOrder) : '—') + kpi('العائد', rM.adSpend ? rM.roas.toFixed(2) + '×' : '—') + '</div>' + campTable(rM.byCampaign, false) + help('يمكنك تسجيل مصروفات الإعلانات من «المزيد ← المصروفات».');
  const os = Object.values(S.orders), cnt = st => os.filter(o => o.status === st).length, noCode = os.filter(o => o.status === 'shipped' && !o.courierCode).length;
  const lows = C.lowStock(S, td), di = cost ? C.debtInfo(S, td) : null;
  let h = '<div class="search"><svg viewBox="0 0 24 24">' + ICON.search + '</svg><input id="gq" placeholder="ابحث: طلب، عميل، هاتف، كود توصيل، عطر" value="' + esc(ui.gq || '') + '" autocomplete="off"></div><div id="gres"></div><div id="gdash">';
  h += '<div class="hero"><small>مبيعات اليوم (طلبات مستلمة)</small><span class="big">' + lyd(rT.revenue) + '</span><small dir="ltr" style="display:block;text-align:right">' + usdv(rT.revenue) + '</small>' +
    (cost ? '<div class="row" style="margin-top:10px;gap:18px"><div><small>ربح اليوم</small><b class="' + (rT.net >= 0 ? 'ok' : 'low') + '" dir="ltr" style="display:block">' + num(rT.net) + ' د.ل</b></div><div><small>طلبات جديدة اليوم</small><b style="display:block">' + rT.created + '</b></div><div><small>مستلمة اليوم</small><b style="display:block">' + rT.delivered + '</b></div></div>' : '<div class="row" style="margin-top:10px;gap:18px"><div><small>طلبات جديدة اليوم</small><b style="display:block">' + rT.created + '</b></div><div><small>مستلمة اليوم</small><b style="display:block">' + rT.delivered + '</b></div></div>') + '</div>';
  h += goalCard(rM);
  h += '<h3>طلبات تحتاج إجراء</h3><div class="kpis">' + [['new', 'جديدة', cnt('new') + cnt('confirmed')], ['shipped', 'مع المندوب', cnt('shipped')]].map(x => '<div class="kpi tap card" style="margin:0;cursor:pointer" data-a="goOrders" data-s="' + x[0] + '"><small>' + x[1] + '</small><b>' + x[2] + '</b></div>').join('') +
    (noCode ? '<div class="kpi" style="cursor:pointer" data-a="goOrders" data-s="shipped"><small>بلا كود توصيل</small><b class="low">' + noCode + '</b></div>' : '') + '</div>';
  if (lows.length) h += '<h3>نقص المخزون</h3>' + lows.slice(0, 5).map(x => '<div class="alert warn" data-a="goStock" data-t="' + x.type + '" style="cursor:pointer"><b>' + esc(x.name) + '</b> · ' + x.why + '</div>').join('') + (lows.length > 5 ? '<small class="d">و ' + (lows.length - 5) + ' أخرى في المخزون</small>' : '');
  if (rM.byProduct.length) h += '<h3>أفضل العطور مبيعًا هذا الشهر</h3><div class="tw"><table>' + rM.byProduct.slice().sort((a, b) => b.qty - a.qty).slice(0, 5).map((p, i) => '<tr><td>' + (i + 1) + '. ' + esc(p.name) + '</td><td class="n">' + p.qty + ' زجاجة</td>' + (cost ? '<td class="n">' + num(p.profit) + '</td>' : '') + '</tr>').join('') + '</table></div>';
  const al = [], rej = OPS.filter(o => o._r), pend = OPS.filter(o => !o._s && !o._r).length;
  if (di) { di.overdue.slice(0, 4).forEach(d => al.push('<div class="alert err">دين متأخر: ' + esc(d.party) + ' — ' + (d.dir === 'in' ? 'لنا' : 'علينا') + ' ' + num(d.rem) + ' د.ل (استحقاق ' + d.due + ')</div>')); di.soon.slice(0, 4).forEach(d => al.push('<div class="alert warn">يستحق قريبًا: ' + esc(d.party) + ' — ' + num(d.rem) + ' د.ل (' + d.due + ')</div>')); }
  S.alerts.filter(a => a.lvl !== 'info').slice(0, 10).forEach(a => al.push('<div class="alert ' + (a.lvl === 'err' ? 'err' : 'warn') + '">' + esc(a.msg) + '</div>'));
  rej.forEach(o => al.push('<div class="alert err">رفض الخادم عملية (' + esc(C.OP_TYPES.includes(o.type) ? o.type : '') + '): ' + esc(o._r) + '</div>'));
  if (pend) al.push('<div class="alert info">' + pend + ' عملية محفوظة على هذا الجهاز بانتظار المزامنة</div>');
  if (al.length) h += '<h3>تنبيهات</h3>' + al.join('');
  return h + '</div>';
}
function searchHtml(q) {
  q = C.normDigits(q).toLowerCase().trim(); if (q.length < 2) return '';
  const os = Object.values(S.orders).filter(o => (o.code + ' ' + (o.courierCode || '') + ' ' + o.customer.name + ' ' + o.customer.phone + ' ' + (o.customer.phone2 || '') + ' ' + o.customer.city).toLowerCase().includes(q)).sort((a, b) => b.ts - a.ts).slice(0, 8);
  const cs = Object.values(C.customers(S)).filter(c => (c.name + ' ' + c.phone + ' ' + c.phone2).toLowerCase().includes(q)).slice(0, 5);
  const ps = Object.values(S.products).filter(p => p.name.toLowerCase().includes(q)).slice(0, 4);
  let h = '';
  if (os.length) h += '<h3>طلبات</h3>' + os.map(o => '<div class="card tap" data-a="order" data-id="' + o.id + '"><div class="row spread"><b>' + esc(o.code) + ' · ' + esc(o.customer.name) + '</b>' + stBadge(o.status) + '</div><small class="d">' + esc(o.customer.phone) + (o.courierCode ? ' · ' + esc(o.courierCode) : '') + ' · ' + o.date + '</small></div>').join('');
  if (cs.length) h += '<h3>عملاء</h3>' + cs.map(c => '<div class="card tap" data-a="cust" data-id="' + c.key + '"><div class="row spread"><b>' + esc(c.name) + '</b><small class="d" dir="ltr">' + esc(c.phone) + '</small></div><small class="d">' + c.n + ' طلب · ' + c.delivered + ' مستلم' + (c.rejected ? ' · ' + c.rejected + ' مرفوض' : '') + '</small></div>').join('');
  if (ps.length) h += '<h3>عطور</h3>' + ps.map(p => '<div class="card tap" data-a="goStock" data-t="product"><b>' + esc(p.name) + '</b> <small class="d">المخزون ' + p.stock + ' · السعر ' + num(p.price) + '</small></div>').join('');
  return h || '<div class="empty">لا نتائج</div>';
}
function bindSearch() {
  const q = $('#gq'); if (!q) return;
  const go = () => { ui.gq = q.value; const r = searchHtml(q.value); $('#gres').innerHTML = r; $('#gdash').style.display = r ? 'none' : ''; };
  q.oninput = go; if (ui.gq) go();
}
// ---------- الطلبات ----------
const OSTAT = [['all', 'الكل'], ['new', 'جديد'], ['shipped', 'مع المندوب'], ['delivered', 'مستلم'], ['bad', 'مرفوض / مرتجع / ملغي']];
const inGroup = (o, g) => g === 'all' || (g === 'new' ? o.status === 'new' || o.status === 'confirmed' : g === 'bad' ? ['rejected', 'returned', 'cancelled'].includes(o.status) : o.status === g);
function ordersList() {
  let list = Object.values(S.orders).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts));
  if (role() === 'sales') list = list.filter(o => o.by === USER.id || o.status === 'new');
  list = list.filter(o => inGroup(o, ui.ostatus));
  const q = C.normDigits(ui.q || '').toLowerCase();
  if (q) list = list.filter(o => (o.code + ' ' + (o.courierCode || '') + ' ' + o.customer.name + ' ' + o.customer.phone + ' ' + (o.customer.phone2 || '') + ' ' + o.customer.city).toLowerCase().includes(q));
  if (!list.length) return '<div class="empty">لا توجد طلبات</div>';
  return list.slice(0, 150).map(o => {
    const gifts = o.items.some(i => i.gift);
    return '<div class="card tap" data-a="order" data-id="' + o.id + '"><div class="row spread"><b>' + esc(o.customer.name) + '</b>' + stBadge(o.status) + '</div><div class="row spread"><small class="d">' + esc(o.customer.city || '') + ' · ' + o.date + ' · ' + esc(o.code) + (o.courierCode ? ' · <span dir="ltr">' + esc(o.courierCode) + '</span>' : '') + '</small><b>' + lyd(o.total) + '</b></div><small class="d">' + o.items.map(i => esc(i.name) + '×' + i.qty + (i.gift ? ' 🎁' : '')).join('، ') + (gifts ? '' : '') + '</small></div>';
  }).join('');
}
function pgOrders() {
  const cnt = {}; Object.values(S.orders).forEach(o => { OSTAT.forEach(g => { if (g[0] !== 'all' && inGroup(o, g[0])) cnt[g[0]] = (cnt[g[0]] || 0) + 1; }); });
  return '<div class="row spread"><h2>الطلبات</h2>' + (C.can(role(), 'order_create') ? '<button class="btn pri" data-a="newOrder">+ طلب جديد</button>' : '') + '</div>' +
    '<input id="oq" placeholder="بحث: اسم، هاتف، كود توصيل، رقم الطلب" value="' + esc(ui.q) + '"><div class="chips" style="margin-top:8px">' +
    OSTAT.map(g => '<button class="chip ' + (ui.ostatus === g[0] ? 'on' : '') + '" data-a="ostatus" data-id="' + g[0] + '">' + g[1] + (cnt[g[0]] ? ' ' + cnt[g[0]] : '') + '</button>').join('') + '</div><div id="olist">' + ordersList() + '</div>';
}
function bindOrders() { const q = $('#oq'); if (q) q.oninput = () => { ui.q = q.value; $('#olist').innerHTML = ordersList(); }; }
const CHANNELS = ['فيسبوك', 'انستغرام', 'واتساب', 'تيك توك', 'مشهور / مؤثر', 'زيارة المتجر', 'أخرى'];
const PAYS = { cod: 'عند الاستلام', bank: 'تحويل مصرفي', wallet: 'محفظة', paid: 'مدفوع مسبقًا' };
const CITIES = ['طرابلس', 'بنغازي', 'مصراتة', 'الزاوية', 'زليتن', 'البيضاء', 'طبرق', 'سبها', 'صبراتة', 'الخمس', 'غريان', 'أجدابيا', 'درنة', 'سرت', 'الزنتان'];
function campaignNames() { return [...new Set(Object.values(S.orders).map(o => o.campaign).concat(S.expenses.map(e => e.campaign)).filter(Boolean))]; }

function lineHtml(pre) {
  pre = pre || {};
  const prods = Object.values(S.products).filter(p => p.active !== false);
  return '<div class="line"' + (pre.bundle ? ' data-bundle="' + esc(pre.bundle) + '"' : '') + '><label>المنتج' + (pre.bundle ? ' <span class="pill">' + esc(pre.bundle) + '</span>' : '') + '<select name="pid"><option value="">اختر…</option>' + prods.map(p => '<option value="' + p.id + '" data-price="' + p.price / 1000 + '"' + (pre.productId === p.id ? ' selected' : '') + '>' + esc(p.name) + ' (' + p.stock + ')</option>').join('') + '</select></label><label>الكمية<input name="qty" inputmode="numeric" value="' + (pre.qty || 1) + '"></label><label>السعر<input name="price" inputmode="decimal" value="' + (pre.price != null ? pre.price / 1000 : '') + '"></label><button type="button" class="x" data-a="rmLine" aria-label="حذف">×</button><label class="gl"><input type="checkbox" name="gift">هدية (مجانًا، تُخصم من المخزون بسعر التكلفة)</label></div>';
}
function formDiscount(f, items) {
  if (!f.discount) return { discount: 0, coupon: '', msg: '' };
  const v = fnum(f.discount.value, 0), pct = f.dkind && f.dkind.value === 'pct';
  if (pct) { const d = Math.round(items * v / 100000); return { discount: d, pct: v, coupon: '', msg: v > 0 ? '= ' + lyd(d) : '' }; }
  return { discount: v, coupon: '', msg: '' };
}
function orderLines(f) {
  const out = [];
  $$('.line', f).forEach(l => {
    const pid = $('[name=pid]', l).value, gift = $('[name=gift]', l).checked; if (!pid) return;
    out.push({ productId: pid, qty: C.toM($('[name=qty]', l).value) / 1000, price: gift ? 0 : C.toM($('[name=price]', l).value), gift, bundle: l.dataset.bundle || '' });
  });
  return out;
}
function calcOrderForm() {
  const f = $('#mf'); if (!f) return;
  const lines = orderLines(f); let items = 0, cost = 0, gifts = 0;
  lines.forEach(i => {
    if (!(i.qty > 0)) return; const p = S.products[i.productId], unit = p ? (p.stock > 0 ? p.value / p.stock : C.recipeCost(S, p)) : 0;
    cost += unit * i.qty; if (i.gift) gifts += i.qty; else if (i.price >= 0) items += i.qty * i.price;
  });
  const dc = formDiscount(f, items), df = fnum(f.deliveryFee.value, 0), cc = fnum(f.courierCost.value, 0);
  const cm = $('#dmsg'); if (cm) cm.innerHTML = dc.msg;
  const total = items - dc.discount + df;
  $('#otot').innerHTML = isFinite(total) ? lyd(total) + (S.settings.rate ? ' · ' + usdv(total) : '') : '—';
  const ge = $('#ogift'); if (ge) ge.textContent = gifts ? '🎁 ' + gifts + ' هدية ضمن الطلب' : '';
  const pe = $('#oprof'); if (pe) pe.innerHTML = seesCost() && lines.length ? 'الربح المتوقع: <b class="' + (total - cost - cc >= 0 ? 'ok' : 'low') + '">' + lyd(Math.round(total - cost - cc)) + '</b>' : '';
}
function checkRisk() {
  const f = $('#mf'); if (!f || !f.phone) return; const box = $('#rk'); if (!box) return;
  const k = C.phoneKey(f.phone.value); if (k.length < 8) { box.innerHTML = ''; return; }
  const rk = C.customerRisk(S, f.phone.value);
  if (rk.level === 'new') { box.innerHTML = ''; return; }
  const cls = rk.level === 'high' ? 'err' : rk.level === 'warn' ? 'warn' : 'info', rec = rk.rec;
  box.innerHTML = '<div class="alert ' + cls + '">' + esc(rk.msg) + '</div>';
  if (rec && !f.name.value.trim()) { f.name.value = rec.name; if (!f.city.value) f.city.value = rec.city; if (!f.area.value) f.area.value = rec.area; if (!f.address.value) f.address.value = rec.address; if (!f.phone2.value) f.phone2.value = rec.phone2; }
}
function addBundle(id) {
  const b = S.bundles[id]; if (!b) return;
  const its = b.items.map(i => ({ i, p: S.products[i.productId] })).filter(x => x.p), base = its.reduce((a, x) => a + x.i.qty * x.p.price, 0) || 1;
  let left = b.price; const lines = [];
  its.forEach((x, idx) => {
    const last = idx === its.length - 1, tot = last ? left : Math.round(b.price * (x.i.qty * x.p.price) / base); left -= tot;
    lines.push({ productId: x.p.id, qty: x.i.qty, price: Math.round(tot / x.i.qty), bundle: b.name });
  });
  const box = $('#lines'); const first = $$('.line', box); if (first.length === 1 && !$('[name=pid]', first[0]).value) first[0].remove();
  lines.forEach(l => box.insertAdjacentHTML('beforeend', lineHtml(l))); calcOrderForm();
}
function newOrder() {
  if (!C.can(role(), 'order_create')) return toast('لا تملك صلاحية إنشاء الطلبات', 1);
  if (!Object.keys(S.products).length) return toast('أضف منتجًا أولًا من المخزون', 1);
  const manual = C.can(role(), 'coupon_upsert'), bundles = Object.values(S.bundles).filter(b => b.active);
  modal('طلب جديد', '<div class="sec"><h3>العميل</h3><div class="g2 keep"><label>الاسم<input name="name" autocomplete="off"></label><label>الهاتف<input name="phone" inputmode="tel" dir="ltr"></label></div><div id="rk"></div><div class="g2 keep"><label>هاتف ثانٍ<input name="phone2" inputmode="tel" dir="ltr"></label><label>المدينة<input name="city" list="cities"></label></div><datalist id="cities">' + CITIES.map(c => '<option value="' + c + '">').join('') + '</datalist><div class="g2 keep"><label>المنطقة / الحي<input name="area"></label><label>العنوان / أقرب نقطة دالة<input name="address"></label></div></div>' +
    '<div class="sec"><h3>المنتجات</h3><div id="lines">' + lineHtml() + '</div><div class="row"><button type="button" class="btn sm" data-a="addLine">+ منتج آخر</button>' + (bundles.length ? '<select id="bsel" style="width:auto;margin:0"><option value="">+ باقة…</option>' + bundles.map(b => '<option value="' + b.id + '">' + esc(b.name) + ' — ' + num(b.price) + '</option>').join('') + '</select>' : '') + '</div><small class="d" id="ogift" style="margin:6px 0"></small></div>' +
    (manual ? '<div class="sec"><h3>الخصم</h3><div class="g2 keep"><label>خصم يدوي<input name="discount" inputmode="decimal" value="0"></label><label>نوعه<select name="dkind"><option value="amt">مبلغ (د.ل)</option><option value="pct">نسبة %</option></select></label></div><small class="d" id="dmsg" style="margin:-4px 0 8px"></small></div>' : '') +
    '<div class="sec"><h3>التوصيل والدفع</h3><div class="g2 keep"><label>رسوم توصيل يدفعها العميل<input name="deliveryFee" inputmode="decimal" value="0"></label><label>تكلفة المندوب علينا<input name="courierCost" inputmode="decimal" value="0"></label></div><div class="g2 keep"><label>كود شركة التوصيل<input name="ccode" dir="ltr"></label><label>طريقة الدفع<select name="pay">' + opt(PAYS, 'cod') + '</select></label></div></div>' +
    '<div class="sec"><h3>المصدر</h3><div class="g2 keep"><label>القناة<select name="channel">' + CHANNELS.map(c => '<option>' + c + '</option>').join('') + '</select></label><label>الحملة الإعلانية<input name="campaign" list="camps" autocomplete="off"></label></div><datalist id="camps">' + campaignNames().map(c => '<option value="' + esc(c) + '">').join('') + '</datalist></div>' +
    '<label>ملاحظة<input name="note"></label><div class="sum big"><span>الإجمالي</span><span id="otot">—</span></div><div class="hint" id="oprof" style="margin-top:6px"></div>', f => {
      const v = fd(f), items = orderLines(f);
      if (!items.length) { toast('اختر منتجًا واحدًا على الأقل', 1); return false; }
      if (items.some(i => !Number.isInteger(i.qty) || !(i.price >= 0))) { toast('تحقق من الكميات والأسعار', 1); return false; }
      const itemsT = items.reduce((t, i) => t + (i.gift ? 0 : i.qty * i.price), 0), dc = formDiscount(f, itemsT), d = dc.discount, df = fnum(v.deliveryFee, 0), cc = fnum(v.courierCost, 0);
      if ([d, df, cc].some(x => !Number.isFinite(x) || x < 0)) { toast('تحقق من الخصم والرسوم', 1); return false; }
      const code = today().slice(5).replace('-', '') + '-' + C.uid().slice(0, 4).toUpperCase();
      return !!commit('order_create', { id: C.uid(), code, customer: { name: v.name.trim(), phone: C.normDigits(v.phone), phone2: C.normDigits(v.phone2 || ''), city: v.city.trim(), area: (v.area || '').trim(), address: v.address.trim() }, items, discount: d, discountPct: dc.pct || 0, deliveryFee: df, courierCost: cc, courierCode: v.ccode.trim(), channel: v.channel, campaign: (v.campaign || '').trim(), payMethod: v.pay, note: v.note.trim() }) && undefined;
    }, 'حفظ الطلب');
  $('#modal .sheet').classList.add('full');
  const f = $('#mf');
  f.addEventListener('input', e => { calcOrderForm(); if (e.target.name === 'phone') checkRisk(); });
  f.addEventListener('change', e => {
    if (e.target.name === 'pid') { const o = e.target.selectedOptions[0], l = e.target.closest('.line'); if (o && o.dataset.price && !$('[name=gift]', l).checked) $('[name=price]', l).value = o.dataset.price; }
    if (e.target.name === 'gift') { const l = e.target.closest('.line'), pr = $('[name=price]', l); if (e.target.checked) { pr.dataset.prev = pr.value; pr.value = 0; pr.disabled = true; } else { pr.disabled = false; pr.value = pr.dataset.prev || ($('[name=pid]', l).selectedOptions[0] || {}).dataset.price || ''; } }
    if (e.target.id === 'bsel') { addBundle(e.target.value); e.target.value = ''; }
    calcOrderForm();
  });
  calcOrderForm();
}

// ---------- تفاصيل الطلب ----------
const NEXT_LABEL = { shipped: 'تسليم للمندوب', delivered: 'تم الاستلام', rejected: 'رفضه العميل', cancelled: 'إلغاء الطلب', returned: 'مرتجع' };
function intlPhone(p) { let d = C.normDigits(String(p || '')).replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '218' + d.slice(1); return d; }
function waText(o) {
  const c = o.customer, due = o.total - o.paid, items = o.items.map(i => '• ' + i.name + ' × ' + i.qty + (i.gift ? ' (هدية)' : '')).join('\n'), pay = due > 0 ? 'المبلغ المطلوب عند الاستلام: ' + num(due) + ' دينار ليبي.' : 'الطلب مدفوع بالكامل.';
  const head = 'السلام عليكم ورحمة الله وبركاته،\nالفاضل/ة ' + c.name + ' المحترم/ة،\n';
  const tail = '\nشكرًا لثقتكم بعطور سانفوير — حيث العظمة هي الجوهر الوحيد.';
  if (o.status === 'delivered') return head + 'يسعدنا أن طلبكم رقم ' + o.code + ' قد وصلكم. نأمل أن ينال عطركم إعجابكم، وسنكون سعداء بسماع رأيكم.' + tail;
  if (o.status === 'shipped') return head + 'تم تسليم طلبكم رقم ' + o.code + ' إلى شركة التوصيل' + (o.courierCode ? ' (كود التتبع: ' + o.courierCode + ')' : '') + '، وسيتواصل معكم المندوب قريبًا.\n' + items + '\n' + pay + '\nنرجو إبقاء هاتفكم متاحًا.' + tail;
  return head + 'تم استلام طلبكم رقم ' + o.code + ' وهو الآن قيد التجهيز:\n' + items + '\n' + pay + '\nسيصلكم تأكيد الشحن فور تسليمه لشركة التوصيل.' + tail;
}
function orderDetail(id) {
  const o = S.orders[id]; if (!o) return;
  const next = (C.TRANSITIONS[o.status] || []).filter(s => s !== 'confirmed' && C.canOp(role(), { type: 'order_status', p: { status: s } })), c = o.customer, rk = C.customerRisk(S, c.phone);
  const m = $('#modal');
  m.innerHTML = '<div class="sheet"><div class="row spread"><h2>' + esc(o.code) + '</h2>' + stBadge(o.status) + '</div>' +
    '<div class="card"><b>' + esc(c.name) + '</b> · <a href="tel:' + esc(c.phone) + '" dir="ltr">' + esc(c.phone) + '</a>' + (c.phone2 ? ' · <a href="tel:' + esc(c.phone2) + '" dir="ltr">' + esc(c.phone2) + '</a>' : '') + '<small class="d">' + esc(c.city) + (c.area ? ' / ' + esc(c.area) : '') + ' — ' + esc(c.address || '') + '<br>' + o.date + ' · ' + esc(o.channel) + (o.campaign ? ' · حملة: ' + esc(o.campaign) : '') + ' · ' + esc(PAYS[o.payMethod] || '') + ' · ' + esc((S.users[o.by] || {}).name || '') + (o.note ? '<br>' + esc(o.note) : '') + '</small>' + (rk.level === 'warn' || rk.level === 'high' ? '<div class="alert ' + (rk.level === 'high' ? 'err' : 'warn') + '" style="margin-top:8px">' + esc(rk.msg) + '</div>' : '') + '</div>' +
    '<div class="row spread card"><span>كود شركة التوصيل: <b dir="ltr">' + (o.courierCode ? esc(o.courierCode) : '—') + '</b></span>' + (C.can(role(), 'order_edit') ? '<button class="btn sm" data-a="ccode" data-id="' + o.id + '">' + (o.courierCode ? 'تعديل' : 'إضافة') + '</button>' : '') + '</div>' +
    '<div class="tw"><table>' + o.items.map(i => '<tr><td>' + esc(i.name) + (i.gift ? ' <span class="pill">هدية 🎁</span>' : '') + (i.bundle ? ' <span class="pill">' + esc(i.bundle) + '</span>' : '') + '</td><td class="n">' + i.qty + ' × ' + num(i.price) + '</td><td class="n">' + num(i.qty * i.price) + '</td></tr>').join('') + '</table></div>' +
    '<div class="sum"><span>المنتجات</span><span>' + lyd(o.itemsTotal) + '</span></div>' + (o.discount ? '<div class="sum"><span>خصم' + (o.discountPct ? ' ' + num(o.discountPct) + '%' : '') + '</span><span>- ' + lyd(o.discount) + '</span></div>' : '') + (o.deliveryFee ? '<div class="sum"><span>توصيل</span><span>' + lyd(o.deliveryFee) + '</span></div>' : '') +
    '<div class="sum big"><span>الإجمالي</span><span>' + lyd(o.total) + ' <small class="d" dir="ltr">' + usdv(o.total) + '</small></span></div><div class="sum"><span>المدفوع</span><span>' + lyd(o.paid) + '</span></div><div class="sum"><span>المتبقي</span><span>' + lyd(o.total - o.paid) + '</span></div>' +
    (seesCost() && o.cogs ? '<div class="sum"><span>التكلفة</span><span>' + lyd(o.cogs) + '</span></div><div class="sum"><span>الربح المتوقع</span><span>' + lyd(o.total - o.cogs - o.courierCost) + '</span></div>' : '') +
    '<h3>تجهيز وإرسال</h3><div class="row"><button class="btn sm" data-a="delivery" data-id="' + o.id + '">تجهيز للتوصيل (نسخ)</button><button class="btn sm" data-a="bag" data-id="' + o.id + '">ورقة الكيس</button><button class="btn sm" data-a="wa" data-id="' + o.id + '">رسالة واتساب</button><button class="btn sm" data-a="print" data-id="' + o.id + '">فاتورة</button></div>' +
    '<h3>السجل</h3>' + o.history.map(h => '<small class="d">' + h.date + ' — ' + C.STATUS[h.status] + ' — ' + esc((S.users[h.by] || {}).name || '') + (h.note ? ' (' + esc(h.note) + ')' : '') + '</small>').join('') +
    '<div class="row" style="margin-top:14px">' + next.map(s => '<button class="btn ' + (s === 'rejected' || s === 'cancelled' || s === 'returned' ? 'red' : 'pri') + '" data-a="status" data-id="' + o.id + '" data-s="' + s + '">' + NEXT_LABEL[s] + '</button>').join('') +
    (C.can(role(), 'payment') && o.total - o.paid > 0 && o.status !== 'cancelled' && o.status !== 'rejected' ? '<button class="btn" data-a="pay" data-id="' + o.id + '">تسجيل دفعة</button>' : '') + '<button class="btn" data-a="close">إغلاق</button></div></div>';
  m.hidden = false;
}
function setStatus(id, s) {
  if (s === 'rejected') {
    return modal('رفض العميل للطلب', '<label>خسارة التوصيل (اتركه 0 إن لم توجد)<input name="loss" inputmode="decimal" value="0"></label><label>السبب<input name="note"></label>', f => { const v = fd(f), l = fnum(v.loss, 0); if (!(l >= 0)) { toast('قيمة غير صحيحة', 1); return false; } if (!commit('order_status', { orderId: id, status: s, lossFee: l, note: v.note })) return false; });
  }
  const label = { shipped: 'تسليم الطلب للمندوب (سيُخصم من المخزون)', delivered: 'تأكيد أن العميل استلم الطلب', cancelled: 'إلغاء الطلب', returned: 'تسجيل الطلب كمرتجع وإعادته للمخزون' }[s];
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

// ---------- تجهيز التوصيل: نسخ بترتيب تطبيق شركة التوصيل ----------
const plain = m => String(Math.round(m) / 1000).replace(/\.0+$/, '');
function deliveryRows(o) {
  const c = o.customer, pcs = o.items.reduce((a, i) => a + i.qty, 0), due = o.total - o.paid;
  return [
    ['المستلم', c.name], ['تليفون المستلم 1', c.phone], ['تليفون المستلم 2', c.phone2 || ''], ['المدينة', c.city], ['المنطقة', c.area || ''], ['العنوان', c.address || ''],
    ['سعر المنتج', plain(o.itemsTotal - (o.discount || 0))],
    ['هل يستلم المندوب مبلغًا من المستلم؟', due > 0 ? 'نعم' : 'لا'],
    ['محتوى الطلب', o.items.map(i => i.name + ' × ' + i.qty + (i.gift ? ' (هدية)' : '')).join(' + ')],
    ['رقم الفاتورة', o.code], ['ملاحظات الطلب', o.note || ''], ['عدد القطع', String(pcs)],
    ['سعر التوصيل يُخصم من', o.deliveryFee > 0 ? 'المستلم' : 'الراسل']
  ];
}
function copyText(t) {
  const done = () => toast('تم النسخ');
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
  fallbackCopy(t, done);
}
function fallbackCopy(t, done) { const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('تعذّر النسخ', 1); } a.remove(); }
function deliveryModal(id) {
  const o = S.orders[id]; if (!o) return;
  const rows = deliveryRows(o), m = $('#modal'); window.__dRows = rows;
  m.innerHTML = '<div class="sheet"><h2>تجهيز للتوصيل · ' + esc(o.code) + '</h2><p class="hint">انسخ كل حقل والصقه في الحقل المقابل له في تطبيق الشركة، بنفس الترتيب.</p>' +
    rows.map((r, i) => '<div class="card row spread" style="margin-bottom:6px"><div class="grow"><small class="d">' + esc(r[0]) + '</small><b dir="auto">' + (r[1] ? esc(r[1]) : '—') + '</b></div>' + (r[1] ? '<button class="btn sm" data-a="cp" data-i="' + i + '">نسخ</button>' : '') + '</div>').join('') +
    '<div class="sum"><span>المطلوب تحصيله من العميل كاملًا</span><span>' + lyd(o.total - o.paid) + '</span></div>' +
    '<div class="row" style="margin-top:12px"><button class="btn pri" data-a="cpAll">نسخ الكل</button><button class="btn" data-a="order" data-id="' + o.id + '">رجوع</button></div></div>';
  m.hidden = false;
}
function printBag(id) {
  const o = S.orders[id], c = o.customer;
  $('#printArea').innerHTML = '<div style="text-align:center;direction:rtl;line-height:1.9"><img src="logo-navy.png" style="height:60px"><div style="font-size:42px;font-weight:700;direction:ltr;margin:6px 0">' + esc(o.courierCode || '______________') + '</div><div style="font-size:24px">' + esc(c.name) + '</div><div style="font-size:20px">' + esc(c.city) + (c.area ? ' / ' + esc(c.area) : '') + '</div><div style="font-size:22px;direction:ltr">' + esc(c.phone) + (c.phone2 ? ' — ' + esc(c.phone2) : '') + '</div><div style="font-size:18px;margin-top:8px">' + o.items.map(i => esc(i.name) + ' × ' + i.qty + (i.gift ? ' (هدية)' : '')).join(' + ') + '</div><div style="font-size:18px;margin-top:6px">المطلوب: <b>' + num(o.total - o.paid) + ' د.ل</b> · ' + esc(o.code) + '</div></div>';
  window.print();
}
function printOrder(id) {
  const o = S.orders[id], c = o.customer;
  $('#printArea').innerHTML = '<div style="direction:rtl"><div style="text-align:center"><img src="logo-navy.png" style="height:70px"><div style="font-size:24px;letter-spacing:.2em;font-weight:600;color:#112663">SANVOIR</div><div style="color:#555">عطور سانفوير</div></div><h2 style="margin:14px 0 4px">فاتورة ' + esc(o.code) + '</h2><p>' + o.date + '<br>العميل: ' + esc(c.name) + ' — ' + esc(c.phone) + '<br>العنوان: ' + esc(c.city) + ' ' + esc(c.area || '') + ' ' + esc(c.address || '') + '</p><table style="width:100%;border-collapse:collapse"><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>المجموع</th></tr>' +
    o.items.map(i => '<tr><td>' + esc(i.name) + (i.gift ? ' (هدية)' : '') + '</td><td>' + i.qty + '</td><td>' + (i.gift ? 'مجانًا' : num(i.price)) + '</td><td>' + num(i.qty * i.price) + '</td></tr>').join('') + '</table><p>' + (o.discount ? 'خصم: ' + num(o.discount) + ' — ' : '') + 'توصيل: ' + num(o.deliveryFee) + '</p><h3>الإجمالي: ' + num(o.total) + ' د.ل — المتبقي: ' + num(o.total - o.paid) + ' د.ل</h3><p style="text-align:center;color:#555;margin-top:24px">شكرًا لثقتكم بعطور سانفوير<br><i>Where greatness is the only essence</i></p></div>';
  window.print();
}
function pgStock() {
  const r = role(), cost = seesCost(), t = ui.stab, lowMap = {}; C.lowStock(S, today()).forEach(x => { lowMap[x.type + ':' + x.id] = x; });
  let h = '<div class="row spread"><h2>المخزون</h2><div class="row">' + (C.can(r, 'material_upsert') ? '<button class="btn sm" data-a="editMat">+ مادة خام</button>' : '') + (C.can(r, 'product_upsert') ? '<button class="btn sm" data-a="editProd">+ منتج</button>' : '') + '</div></div>' +
    '<div class="chips">' + [['mat', 'المواد الخام'], ['prod', 'المنتجات الجاهزة']].concat([['mov', 'الحركة']]).map(x => '<button class="chip ' + (t === x[0] ? 'on' : '') + '" data-a="stab" data-id="' + x[0] + '">' + x[1] + '</button>').join('') + '</div>';
  if (t === 'mat') {
    const ms = Object.values(S.materials).filter(m => m.active !== false);
    h += ms.length ? '<div class="tw"><table><tr><th>المادة</th><th class="n">الرصيد</th>' + (cost ? '<th class="n">تكلفة/وحدة</th><th class="n">القيمة</th>' : '') + '<th></th></tr>' + ms.map(m => {
      const lw = lowMap['material:' + m.id], low = !!lw;
      return '<tr><td>' + esc(m.name) + '<small class="d">' + C.MAT_CATS[m.cat] + (lw ? ' · <span class="low">' + lw.why + '</span>' : '') + '</small></td><td class="n ' + (low || m.qty < 0 ? 'low' : '') + '">' + qty(m.qty, m.unit) + '</td>' + (cost ? '<td class="n">' + (m.qty > 0 ? num(Math.round(m.value / m.qty * 1000), 4) : '—') + '</td><td class="n">' + num(m.value) + '</td>' : '') +
        '<td class="n">' + (C.can(r, 'purchase') ? '<button class="btn sm" data-a="buy" data-id="' + m.id + '">شراء</button> ' : '') + (C.can(r, 'adjust') ? '<button class="btn sm" data-a="adj" data-t="material" data-id="' + m.id + '">تسوية</button> ' : '') + (C.can(r, 'material_upsert') ? '<button class="btn sm" data-a="editMat" data-id="' + m.id + '">تعديل</button>' : '') + '</td></tr>';
    }).join('') + '</table></div>' : '<div class="empty">أضف المواد الخام: كحول، زيوت عطرية، زجاجات، بوكسات، ستيكر</div>';
  } else if (t === 'prod') {
    const ps = Object.values(S.products).filter(p => p.active !== false);
    h += ps.length ? '<div class="tw"><table><tr><th>المنتج</th><th class="n">السعر</th>' + (cost ? '<th class="n">التكلفة</th><th class="n">الهامش</th>' : '') + '<th class="n">المخزون</th><th></th></tr>' + ps.map(p => {
      const rc = p.stock > 0 ? Math.round(p.value / p.stock) : C.recipeCost(S, p), mg = p.price > 0 ? Math.round((p.price - rc) / p.price * 100) : 0;
      const lwp = lowMap['product:' + p.id];
      return '<tr><td>' + esc(p.name) + '<small class="d">' + p.sizeMl + ' مل' + (lwp ? ' · <span class="low">' + lwp.why + '</span>' : '') + '</small></td><td class="n">' + num(p.price) + '</td>' + (cost ? '<td class="n">' + num(rc) + '</td><td class="n ' + (mg < 30 ? 'low' : '') + '">' + mg + '%</td>' : '') + '<td class="n">' + p.stock + '</td><td class="n">' + (C.can(r, 'production') && p.recipe.length ? '<button class="btn sm" data-a="prod" data-id="' + p.id + '">تعبئة</button> ' : '') + (C.can(r, 'adjust') ? '<button class="btn sm" data-a="adj" data-t="product" data-id="' + p.id + '">تسوية</button> ' : '') + (C.can(r, 'product_upsert') ? '<button class="btn sm" data-a="editProd" data-id="' + p.id + '">تعديل</button>' : '') + '</td></tr>';
    }).join('') + '</table></div>' : '<div class="empty">أضف منتجًا: اسم العطر والزيت وعدد الزجاجات من العبوة، والباقي يُحسب تلقائيًا</div>';
  } else {
    const mv = S.movements.slice().sort((a, b) => b.ts - a.ts).slice(0, 120), K = { purchase: 'شراء', consume: 'استهلاك', produce: 'إنتاج', ship: 'شحن', restock: 'إرجاع', adjust: 'تسوية', opening: 'رصيد افتتاحي', gift: 'هدية' };
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
  modal('شراء: ' + m.name, '<label>الكمية (' + C.UNITS[m.unit] + ')<input name="qty" inputmode="decimal"></label><div class="g2"><label>إجمالي السعر<input name="amt" inputmode="decimal"></label><label>العملة<select name="cur"><option value="LYD">دينار</option><option value="USD">دولار</option></select></label></div><label>سعر الصرف<input name="rate" inputmode="decimal" value="' + (S.settings.rate / 1000 || '') + '"></label><p class="hint">يُستخدم سعر الصرف عند الشراء بالدولار وتُسجَّل التكلفة بالدينار.</p><label>المورد<input name="sup" list="sups" autocomplete="off"></label><datalist id="sups">' + [...new Set(Object.values(S.debts).map(d => d.party).concat(S.movements.filter(x => x.kind === 'purchase' && x.note).map(x => x.note)))].map(n => '<option value="' + esc(n) + '">').join('') + '</datalist><div class="g2"><label>المدفوع الآن (اتركه فارغًا إن دفعت كامل المبلغ)<input name="paid" inputmode="decimal"></label><label>موعد سداد الباقي<input name="due" type="date"></label></div><p class="hint">إن دفعت جزءًا فقط يُسجَّل الباقي تلقائيًا دينًا عليك للمورد في «الديون».</p>', f => {
    const v = fd(f), paid = v.paid.trim() === '' ? undefined : C.toM(v.paid), amt = C.toM(v.amt);
    const pl = { materialId: id, qty: C.toM(v.qty), amt, currency: v.cur, rate: C.toM(v.rate), supplier: v.sup.trim() };
    if (paid !== undefined) { pl.paid = paid; if (paid < amt && v.due) pl.due = v.due; }
    if (!commit('purchase', pl)) return false;
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
// ---------- المصروفات والمسحوبات ----------
function pgExp() {
  const r = role(), wOK = r === 'owner' || r === 'accountant', tab = wOK && ui.etab === 'wd' ? 'wd' : 'exp';
  const tabs = wOK ? '<div class="chips">' + [['exp', 'مصروفات العمل'], ['wd', 'المسحوبات الشخصية']].map(x => '<button class="chip ' + (tab === x[0] ? 'on' : '') + '" data-a="etab" data-id="' + x[0] + '">' + x[1] + '</button>').join('') + '</div>' : '';
  const [f, t] = range(ui.period), inR = d => (!f || d >= f) && (!t || d <= t);
  if (tab === 'wd') {
    const list = S.withdrawals.filter(w => inR(w.date)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts)), by = {};
    list.forEach(w => { by[w.cat] = (by[w.cat] || 0) + w.lyd; });
    const tot = list.reduce((a, w) => a + w.lyd, 0);
    return backBar('المصروفات والمسحوبات') + tabs + periodChips() + '<div class="row spread"><span></span>' + (C.can(r, 'withdrawal') ? '<button class="btn pri" data-a="newWd">+ مسحوب شخصي</button>' : '') + '</div>' +
      '<div class="kpis">' + kpi('إجمالي المسحوبات', lyd(tot), usdv(tot), 'gold') + '</div>' +
      (list.length ? '<h3>حسب النوع</h3><div class="tw"><table>' + Object.keys(by).sort((a, b) => by[b] - by[a]).map(c => '<tr><td>' + C.WD_CATS[c] + '</td><td class="n">' + num(by[c]) + '</td></tr>').join('') + '</table></div>' +
        '<h3>السجل</h3><div class="tw"><table><tr><th>التاريخ</th><th>النوع</th><th class="n">المبلغ</th></tr>' + list.map(w => '<tr><td>' + w.date + '</td><td>' + C.WD_CATS[w.cat] + '<small class="d">' + esc(w.note || '') + '</small></td><td class="n">' + num(w.lyd) + (w.cur === 'USD' ? '<small class="d">$' + num(w.orig) + '</small>' : '') + '</td></tr>').join('') + '</table></div>' : '<div class="empty">لا توجد مسحوبات في هذه الفترة</div>') +
      help('<b>المسحوبات الشخصية</b> تخرج من أموال المشروع لكنها لا تُحسب مصروفًا على البراند ولا تنقص صافي ربحه. تظهر في التقارير بسطر مستقل: صافي الربح ← المسحوبات ← المتبقي.');
  }
  let list = S.expenses.filter(e => inR(e.date)).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (r === 'ads') list = list.filter(e => C.AD_CATS.includes(e.cat));
  const adSum = list.filter(e => C.AD_CATS.includes(e.cat)).reduce((a, e) => a + e.lyd, 0), tot = list.reduce((a, e) => a + e.lyd, 0);
  return backBar('المصروفات والمسحوبات') + tabs + periodChips() + '<div class="row spread"><span></span>' + (C.can(r, 'expense') ? '<button class="btn pri" data-a="newExp">+ مصروف</button>' : '') + '</div>' +
    '<div class="kpis">' + kpi('الإجمالي', lyd(tot), usdv(tot), 'gold') + kpi('إعلانات ومشاهير', lyd(adSum), usdv(adSum)) + '</div>' +
    (list.length ? '<div class="tw"><table><tr><th>التاريخ</th><th>النوع</th><th class="n">المبلغ</th></tr>' + list.map(e => '<tr><td>' + e.date + '</td><td>' + C.EXP_CATS[e.cat] + '<small class="d">' + esc(e.campaign ? 'حملة: ' + e.campaign + (e.note ? ' · ' : '') : '') + esc(e.note || '') + (e.auto ? ' · تلقائي' : '') + '</small></td><td class="n">' + num(e.lyd) + (e.cur === 'USD' ? '<small class="d">$' + num(e.orig) + '</small>' : '') + '</td></tr>').join('') + '</table></div>' : '<div class="empty">لا توجد مصروفات في هذه الفترة</div>') +
    help('شراء المواد الخام والتغليف يُسجَّل من «المخزون» ويدخل التكلفة عند التعبئة والبيع، فلا يُسجَّل هنا. الهدايا تُسجَّل داخل الطلب.');
}
const moneyFields = '<div class="g2 keep"><label>المبلغ<input name="amt" inputmode="decimal"></label><label>العملة<select name="cur"><option value="LYD">دينار</option><option value="USD">دولار</option></select></label></div><label>سعر الصرف (للدولار)<input name="rate" inputmode="decimal" value="__RATE__"></label>';
const rateVal = () => (S.settings.rate / 1000 || '');
function expModal() {
  const ads = role() === 'ads', cats = Object.keys(C.EXP_CATS).filter(k => k !== 'delivery_loss' && k !== 'gift' && (!ads || C.AD_CATS.includes(k)));
  modal('مصروف جديد', '<label>النوع<select name="cat">' + cats.map(k => '<option value="' + k + '">' + C.EXP_CATS[k] + '</option>').join('') + '</select></label>' + moneyFields.replace('__RATE__', rateVal()) +
    '<label>الحملة الإعلانية (للإعلانات فقط)<input name="camp" list="camps" autocomplete="off" placeholder="اسم الحملة"></label><datalist id="camps">' + campaignNames().map(n => '<option value="' + esc(n) + '">').join('') + '</datalist><label>تفاصيل<input name="note"></label><label>التاريخ<input name="date" type="date" value="' + today() + '"></label>', f => {
    const v = fd(f);
    if (!commit('expense', { cat: v.cat, amt: C.toM(v.amt), currency: v.cur, rate: C.toM(v.rate), campaign: C.AD_CATS.includes(v.cat) ? v.camp.trim() : '', note: v.note.trim() }, v.date || today())) return false;
  });
}
function wdModal() {
  modal('مسحوب شخصي', '<label>النوع<select name="cat">' + opt(C.WD_CATS) + '</select></label>' + moneyFields.replace('__RATE__', rateVal()) + '<label>تفاصيل<input name="note"></label><label>التاريخ<input name="date" type="date" value="' + today() + '"></label>', f => {
    const v = fd(f);
    if (!commit('withdrawal', { cat: v.cat, amt: C.toM(v.amt), currency: v.cur, rate: C.toM(v.rate), note: v.note.trim() }, v.date || today())) return false;
  }, 'تسجيل المسحوب');
}

// ---------- التقارير ----------
function campTable(list, cost) {
  if (!list.length) return '<div class="empty">لا توجد حملات مسجّلة. اكتب اسم الحملة في «مصدر الطلب» عند إنشاء الطلب وفي مصروف الإعلان لتظهر هنا.</div>';
  return '<div class="tw"><table><tr><th>الحملة</th><th class="n">إنفاق</th><th class="n">طلبات</th><th class="n">مستلم</th><th class="n">تكلفة الطلب</th>' + (cost ? '<th class="n">العائد</th>' : '') + '</tr>' +
    list.map(c => '<tr><td>' + esc(c.name) + '<small class="d">رفض ' + c.rejected + '</small></td><td class="n">' + num(c.spend) + '</td><td class="n">' + c.created + '</td><td class="n">' + c.delivered + '</td><td class="n">' + (c.created ? num(c.cpo) : '—') + '</td>' + (cost ? '<td class="n ' + (c.profit < 0 ? 'low' : 'ok') + '">' + (c.spend ? c.roas.toFixed(2) + '×' : '—') + '</td>' : '') + '</tr>').join('') + '</table></div>';
}
function pgRep() {
  const r = role();
  if (r === 'ads') { const [f0, t0] = range(ui.period), x = C.report(S, f0, t0); return backBar('التقارير') + periodChips() + campTable(x.byCampaign, false); }
  if (!seesCost()) return backBar('التقارير') + '<div class="empty">غير متاح لصلاحيتك</div>';
  const [f, t] = range(ui.period), x = C.report(S, f, t), row = (l, v, b) => '<div class="sum' + (b ? ' big' : '') + '"><span>' + l + '</span><span>' + lyd(v) + ' <small class="d" dir="ltr">' + usdv(v) + '</small></span></div>';
  const own = r === 'owner' || r === 'accountant';
  let h = backBar('التقارير') + periodChips() + '<div class="card"><h3 style="margin-top:0">الأرباح والخسائر</h3>' + row('الإيراد (طلبات مستلمة)', x.revenue) + row('تكلفة البضاعة المباعة', -x.cogsSold) + (x.giftLinesCost ? row('هدايا ضمن الطلبات', -x.giftLinesCost) : '') + row('مجمل الربح', x.gross, 1) +
    Object.keys(x.byCat).map(c => row(C.EXP_CATS[c], -x.byCat[c])).join('') + (x.shrink ? row('فاقد وتسويات', -x.shrink) : '') + row('صافي ربح البراند', x.net, 1) +
    (own ? row('مسحوباتي الشخصية', -x.wdTotal) + row('المتبقي في المشروع', x.remainder, 1) : '') + '</div>';
  if (own && x.wdTotal) h += '<div class="card"><div class="sum"><span>كل ما خرج من المشروع (مصروفات + مسحوبات)</span><span>' + lyd(x.outAll) + '</span></div></div>';
  h += '<div class="kpis">' + kpi('طلبات جديدة', x.created) + kpi('مستلمة', x.delivered) + kpi('نسبة الرفض', Math.round(x.rejectRate * 100) + '%', x.rejected + ' مرفوض', x.rejectRate > .3 ? 'neg' : '') + kpi('متوسط الطلب', x.delivered ? lyd(x.avgOrder) : '—') + '</div>';
  if (x.discountTotal || x.giftCost) h += '<div class="card"><h3 style="margin-top:0">الخصومات والهدايا</h3>' + (x.discountTotal ? '<div class="sum"><span>خصومات مُعطاة (' + x.discountOrders + ' طلب)</span><span>' + lyd(x.discountTotal) + '</span></div>' : '') + (x.giftCost ? '<div class="sum"><span>هدايا (' + x.giftCount + ' زجاجة، بسعر التكلفة)</span><span>' + lyd(x.giftCost) + '</span></div>' : '') + '<small class="d">الخصومات مخصومة أصلًا من الإيراد، والهدايا داخل التكلفة، فتُعرض للمعرفة فقط.</small></div>';
  const gr = C.giftRows(S).filter(g => (!f || g.date >= f) && (!t || g.date <= t));
  if (gr.length) { const by = {}; gr.forEach(g => { const b = by[g.to] || (by[g.to] = { to: g.to, n: 0, cost: 0 }); b.n += g.qty; b.cost += g.cost; }); h += '<h3>الهدايا حسب المستلم</h3><div class="tw"><table>' + Object.values(by).sort((a, b) => b.cost - a.cost).map(b => '<tr><td>' + esc(b.to) + '</td><td class="n">' + b.n + '</td><td class="n">' + num(b.cost) + '</td></tr>').join('') + '</table></div>'; }
  h += '<h3>كفاءة الإعلانات</h3><div class="card"><div class="sum"><span>الإنفاق الإعلاني</span><span>' + lyd(x.adSpend) + '</span></div><div class="sum"><span>تكلفة الطلب الجديد</span><span>' + (x.created ? lyd(x.costPerOrder) : '—') + '</span></div><div class="sum"><span>تكلفة الطلب المستلم</span><span>' + (x.delivered ? lyd(x.costPerDelivered) : '—') + '</span></div><div class="sum"><span>العائد على الإعلان</span><span>' + (x.adSpend ? x.roas.toFixed(2) + '×' : '—') + '</span></div></div>';
  h += '<h3>نتائج الحملات</h3>' + campTable(x.byCampaign, true);
  if (x.byProduct.length) h += '<h3>أرباح كل عطر</h3><div class="tw"><table><tr><th>العطر</th><th class="n">مباع</th><th class="n">إيراد</th><th class="n">ربح</th></tr>' + x.byProduct.map(p => '<tr><td>' + esc(p.name) + '</td><td class="n">' + p.qty + '</td><td class="n">' + num(p.revenue) + '</td><td class="n ' + (p.profit < 0 ? 'low' : '') + '">' + num(p.profit) + '</td></tr>').join('') + '</table></div><p class="hint">أرباح العطور قبل الخصم والتوصيل والمصروفات.</p>';
  if (x.byCity.length) h += '<h3>أفضل المدن</h3><div class="tw"><table><tr><th>المدينة</th><th class="n">مستلم</th><th class="n">مرفوض</th><th class="n">إيراد</th></tr>' + x.byCity.slice(0, 10).map(c => '<tr><td>' + esc(c.city) + '</td><td class="n">' + c.delivered + '</td><td class="n ' + (c.rejected > c.delivered ? 'low' : '') + '">' + c.rejected + '</td><td class="n">' + num(c.revenue) + '</td></tr>').join('') + '</table></div>';
  if (x.topCustomers.length) h += '<h3>أفضل العملاء</h3><div class="tw"><table>' + x.topCustomers.map(c => '<tr><td>' + esc(c.name) + '<small class="d" dir="ltr">' + esc(c.phone) + '</small></td><td class="n">' + c.n + ' طلب</td><td class="n">' + num(c.spent) + '</td></tr>').join('') + '</table></div>';
  if (x.commissions.length) h += '<h3>عمولات الموظفين المستحقة</h3><div class="tw"><table><tr><th>الموظف</th><th class="n">طلبات</th><th class="n">العمولة</th></tr>' + x.commissions.map(c => '<tr><td>' + esc(c.name) + '</td><td class="n">' + c.orders + '</td><td class="n">' + num(c.amount) + '</td></tr>').join('') + '</table></div><p class="hint">العمولات للمعرفة، ولم تُخصم من صافي الربح أعلاه.</p>';
  h += '<div class="card"><div class="sum"><span>قيمة المواد الخام</span><span>' + lyd(x.matValue) + '</span></div><div class="sum"><span>قيمة المنتجات الجاهزة</span><span>' + lyd(x.fgValue) + '</span></div><div class="sum"><span>طلبات مستلمة لم تُحصَّل</span><span>' + lyd(x.receivables) + '</span></div><div class="sum"><span>طلبات مع المندوب</span><span>' + lyd(x.inTransit) + '</span></div></div>';
  return h + '<h3>تصدير إلى ملف</h3><div class="row">' + Object.keys(C.views(S)).filter(k => k !== 'المسحوبات' || own).map(k => '<button class="btn sm" data-a="csv" data-id="' + esc(k) + '">' + esc(k) + '</button>').join('') + '</div>';
}
function toCSV(rows) { return '﻿' + rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n'); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
// ---------- العملاء ----------
function custList(q) {
  q = C.normDigits(q || '').toLowerCase().trim();
  let list = Object.values(C.customers(S)).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  if (q) list = list.filter(c => (c.name + ' ' + c.phone + ' ' + c.phone2 + ' ' + c.city).toLowerCase().includes(q));
  if (!list.length) return '<div class="empty">' + (q ? 'لا نتائج' : 'لا يوجد عملاء بعد. يظهر العميل هنا تلقائيًا عند أول طلب له.') + '</div>';
  return list.slice(0, 120).map(c => '<div class="card tap" data-a="cust" data-id="' + c.key + '"><div class="row spread"><b>' + esc(c.name) + '</b>' + (c.rejected + c.returned ? '<span class="pill red">رفض/إرجاع ' + (c.rejected + c.returned) + '</span>' : c.delivered > 1 ? '<span class="pill">عميل متكرر</span>' : '') + '</div><div class="row spread"><small class="d" dir="ltr">' + esc(c.phone) + '</small><small class="d">' + esc(c.city) + ' · ' + c.n + ' طلب · ' + c.delivered + ' مستلم</small></div></div>').join('');
}
function pgCust() {
  if (ui.custKey) return custDetail(ui.custKey);
  const all = Object.values(C.customers(S)), rep = all.filter(c => c.delivered > 1).length, bad = all.filter(c => c.rejected + c.returned > 0).length;
  return backBar('العملاء') + '<div class="kpis">' + kpi('عدد العملاء', all.length) + kpi('عملاء متكررون', rep) + kpi('سبق أن رفضوا', bad, '', bad ? 'neg' : '') + '</div>' +
    '<div class="search"><svg viewBox="0 0 24 24">' + ICON.search + '</svg><input id="cq" placeholder="ابحث بالاسم أو الهاتف أو المدينة" value="' + esc(ui.cq || '') + '" autocomplete="off"></div><div id="clist">' + custList(ui.cq) + '</div>' +
    help('العميل يُعرَّف برقم هاتفه. عند إدخال رقم سبق أن رفض طلبًا يظهر تحذير في شاشة «طلب جديد».');
}
function bindCust() { const q = $('#cq'); if (q) q.oninput = () => { ui.cq = q.value; $('#clist').innerHTML = custList(q.value); }; }
function custDetail(key) {
  const c = C.customers(S)[key];
  if (!c) { ui.custKey = ''; return pgCust(); }
  const os = c.orders.map(id => S.orders[id]).sort((a, b) => (a.date < b.date ? 1 : -1)), risk = C.customerRisk(S, c.phone), wa = C.normDigits(c.phone) ? 'https://wa.me/' + intlPhone(c.phone) : '';
  return '<div class="row" style="margin-bottom:6px"><button class="btn sm" data-a="custBack">‹ العملاء</button></div><h2>' + esc(c.name) + '</h2>' +
    (risk.level === 'high' || risk.level === 'warn' ? '<div class="alert ' + (risk.level === 'high' ? 'err' : 'warn') + '">' + esc(risk.msg) + '</div>' : '') +
    '<div class="card"><div class="sum"><span>الهاتف</span><a href="tel:' + esc(c.phone) + '" dir="ltr">' + esc(c.phone) + '</a></div>' + (c.phone2 ? '<div class="sum"><span>هاتف ثانٍ</span><a href="tel:' + esc(c.phone2) + '" dir="ltr">' + esc(c.phone2) + '</a></div>' : '') +
    '<div class="sum"><span>العنوان</span><span>' + esc([c.city, c.area, c.address].filter(Boolean).join(' — ')) + '</span></div>' + (wa ? '<div class="row" style="margin-top:8px"><a class="btn sm" href="' + wa + '" target="_blank" rel="noopener">واتساب</a></div>' : '') + '</div>' +
    '<div class="kpis">' + kpi('الطلبات', c.n) + kpi('مستلمة', c.delivered) + kpi('رفض/إرجاع', c.rejected + c.returned, '', c.rejected + c.returned ? 'neg' : '') + (seesCost() ? kpi('إجمالي مشترياته', lyd(c.spent), '', 'gold') : '') + '</div>' +
    '<h3>طلباته</h3>' + os.map(o => '<div class="card tap" data-a="order" data-id="' + o.id + '"><div class="row spread"><b>' + esc(o.code) + '</b>' + stBadge(o.status) + '</div><div class="row spread"><small class="d">' + o.date + ' · ' + o.items.map(i => esc(i.name) + '×' + i.qty).join('، ') + '</small><b>' + lyd(o.total) + '</b></div></div>').join('');
}

// ---------- الديون ----------
const DEBT_KINDS = { customer: 'عميل', courier: 'شركة توصيل', supplier: 'مورد', printer: 'مطبعة', personal: 'سلفة / قرض شخصي', other: 'أخرى' };
function pgDebts() {
  const di = C.debtInfo(S, today()), dir = ui.ddir === 'out' ? 'out' : 'in', r = role(), x = C.report(S, '', '');
  const list = di.list.filter(d => d.dir === dir).sort((a, b) => (a.rem > 0 ? 0 : 1) - (b.rem > 0 ? 0 : 1) || (a.due || '9') .localeCompare(b.due || '9'));
  const open = list.filter(d => d.rem > 0), closed = list.filter(d => d.rem <= 0);
  const card = d => '<div class="card tap" data-a="debt" data-id="' + d.id + '"><div class="row spread"><b>' + esc(d.party) + '</b><span class="pill' + (d.overdue ? ' red' : '') + '">' + (d.rem <= 0 ? 'مسدَّد' : d.overdue ? 'متأخر' : d.soon ? 'يستحق قريبًا' : DEBT_KINDS[d.kind] || '') + '</span></div><div class="row spread"><small class="d">' + (DEBT_KINDS[d.kind] || '') + (d.due ? ' · استحقاق ' + d.due : '') + (d.note ? ' · ' + esc(d.note) : '') + '</small><b>' + lyd(d.rem) + '</b></div></div>';
  return backBar('الديون') + '<div class="kpis">' + kpi('لنا عند الآخرين', lyd(di.owedToUs), usdv(di.owedToUs), 'pos') + kpi('علينا للآخرين', lyd(di.weOwe), usdv(di.weOwe), di.weOwe ? 'neg' : '') + '</div>' +
    '<div class="chips">' + [['in', 'لنا'], ['out', 'علينا']].map(c => '<button class="chip ' + (dir === c[0] ? 'on' : '') + '" data-a="ddir" data-id="' + c[0] + '">' + c[1] + '</button>').join('') + '</div>' +
    (C.can(r, 'debt_add') ? '<div class="row spread" style="margin-bottom:8px"><span></span><button class="btn pri" data-a="newDebt">+ دين جديد</button></div>' : '') +
    (dir === 'in' && x.receivables ? '<div class="card"><div class="row spread"><b>طلبات مستلمة لم تُحصَّل (عند شركة التوصيل أو العملاء)</b><b>' + lyd(x.receivables) + '</b></div><small class="d">تُحسب تلقائيًا من الطلبات. سجّل الدفعة من داخل الطلب عند التحصيل.</small></div>' : '') +
    (open.length ? open.map(card).join('') : '<div class="empty">لا توجد ديون مفتوحة</div>') + (closed.length ? '<h3>مسدَّدة</h3>' + closed.slice(0, 20).map(card).join('') : '') +
    help('الشراء بدفعة جزئية من «المخزون ← شراء» ينشئ دينًا للمورد تلقائيًا. اضغط أي دين لتسجيل دفعة أو رؤية سجله.');
}
function debtModal() {
  modal('دين جديد', '<div class="g2 keep"><label>الاتجاه<select name="dir"><option value="in"' + (ui.ddir !== 'out' ? ' selected' : '') + '>لنا عند طرف</option><option value="out"' + (ui.ddir === 'out' ? ' selected' : '') + '>علينا لطرف</option></select></label><label>النوع<select name="kind">' + opt(DEBT_KINDS, 'customer') + '</select></label></div>' +
    '<label>اسم الطرف<input name="party" autocomplete="off"></label>' + moneyFields.replace('__RATE__', rateVal()) + '<div class="g2 keep"><label>تاريخ الاستحقاق (اختياري)<input name="due" type="date"></label><label>تاريخ الدين<input name="date" type="date" value="' + today() + '"></label></div><label>ملاحظة<input name="note"></label>', f => {
    const v = fd(f);
    if (!commit('debt_add', { id: C.uid(), dir: v.dir, kind: v.kind, party: v.party.trim(), amt: C.toM(v.amt), currency: v.cur, rate: C.toM(v.rate), due: v.due || '', note: v.note.trim() }, v.date || today())) return false;
  }, 'حفظ الدين');
}
function debtDetail(id) {
  const d = S.debts[id]; if (!d) return;
  const rem = d.lyd - d.paid, m = $('#modal');
  m.innerHTML = '<div class="sheet"><div class="row spread"><h2>' + esc(d.party) + '</h2><span class="pill">' + (d.dir === 'in' ? 'لنا' : 'علينا') + '</span></div>' +
    '<div class="sum"><span>الإجمالي</span><span>' + lyd(d.lyd) + '</span></div><div class="sum"><span>المسدَّد</span><span>' + lyd(d.paid) + '</span></div><div class="sum big"><span>المتبقي</span><span>' + lyd(rem) + '</span></div>' +
    '<small class="d">' + (DEBT_KINDS[d.kind] || '') + ' · ' + d.date + (d.due ? ' · استحقاق ' + d.due : '') + (d.note ? ' · ' + esc(d.note) : '') + '</small>' +
    (d.payments.length ? '<h3>الدفعات</h3>' + d.payments.map(p => '<div class="sum"><span>' + p.date + (p.note ? ' · ' + esc(p.note) : '') + '</span><span>' + lyd(p.lyd) + '</span></div>').join('') : '') +
    '<div class="row" style="margin-top:14px">' + (rem > 0 && C.can(role(), 'debt_pay') ? '<button class="btn pri" data-a="payDebt" data-id="' + d.id + '">تسجيل دفعة</button>' : '') + '<button class="btn" data-a="close">إغلاق</button></div></div>';
  m.hidden = false;
}
function debtPayModal(id) {
  const d = S.debts[id], rem = d.lyd - d.paid;
  modal('دفعة: ' + d.party, '<p class="hint">المتبقي ' + num(rem) + ' د.ل</p><div class="g2 keep"><label>المبلغ<input name="amt" inputmode="decimal" value="' + rem / 1000 + '"></label><label>العملة<select name="cur"><option value="LYD">دينار</option><option value="USD">دولار</option></select></label></div><label>سعر الصرف (للدولار)<input name="rate" inputmode="decimal" value="' + rateVal() + '"></label><label>ملاحظة<input name="note"></label><label>التاريخ<input name="date" type="date" value="' + today() + '"></label>', f => {
    const v = fd(f);
    if (!commit('debt_pay', { debtId: id, amt: C.toM(v.amt), currency: v.cur, rate: C.toM(v.rate), note: v.note.trim() }, v.date || today())) return false;
  }, 'تسجيل الدفعة');
}
// ---------- الإعدادات ----------
function pgSet() {
  const r = role(), cfg = LS.get('api', null), own = r === 'owner', cost = seesCost();
  let h = backBar('الإعدادات') + '<div class="card"><b>' + esc(USER.name) + '</b> · ' + C.ROLES[r] + '<div class="row" style="margin-top:8px"><button class="btn" data-a="logout">تسجيل الخروج</button><button class="btn" data-a="helpSheet">دليل سريع</button></div></div>';
  h += '<div class="card"><b>المزامنة مع جوجل شيت</b><p class="hint">' + (cfg ? 'مرتبط. كل عملية تُحفظ على الجهاز أولًا ثم تُرفع عند توفر الإنترنت.' : 'غير مرتبط: البيانات محفوظة على هذا الجهاز فقط.') + '</p><div class="row"><button class="btn" data-a="syncNow">مزامنة الآن</button><button class="btn" data-a="connect">' + (cfg ? 'تغيير الربط' : 'ربط بجوجل شيت') + '</button></div></div>';
  if (own) {
    h += '<div class="card"><div class="row spread"><b>سعر الصرف</b><button class="btn sm" data-a="rate">تعديل</button></div><p class="hint">' + num(S.settings.rate) + ' دينار لكل دولار. يُطبَّق على العمليات الجديدة فقط، والقديمة تحتفظ بسعرها.</p></div>';
    h += '<div class="card"><div class="row spread"><b>الهدف الشهري</b><button class="btn sm" data-a="goal">تعديل</button></div><p class="hint">' + (S.settings.goalOrders ? S.settings.goalOrders + ' طلب مستلم في الشهر' : 'لم يُحدَّد بعد') + '</p></div>';
    h += '<div class="card"><div class="row spread"><b>الفريق</b><button class="btn sm" data-a="user">+ مستخدم</button></div>' + Object.values(S.users).map(u => '<div class="sum"><span>' + esc(u.name) + ' · ' + C.ROLES[u.role] + (u.commission && u.commission.value > 0 ? ' · عمولة ' + (u.commission.type === 'pct' ? num(u.commission.value) + '%' : num(u.commission.value) + ' د.ل') : '') + (u.active === false ? ' (موقوف)' : '') + '</span><button class="btn sm" data-a="user" data-id="' + u.id + '">تعديل</button></div>').join('') + '</div>';
  }
  if (C.can(r, 'bundle_upsert')) {
    const bs = Object.values(S.bundles);
    h += '<div class="card"><div class="row spread"><b>الباقات</b><button class="btn sm" data-a="bundle">+ باقة</button></div><p class="hint">عطران أو أكثر بسعر واحد. تظهر في شاشة «طلب جديد».</p>' + (bs.length ? bs.map(b => '<div class="sum"><span>' + esc(b.name) + ' · ' + num(b.price) + ' د.ل' + (b.active ? '' : ' (موقوفة)') + '<small class="d">' + b.items.map(i => esc((S.products[i.productId] || {}).name || '؟') + '×' + i.qty).join('، ') + '</small></span><button class="btn sm" data-a="bundle" data-id="' + b.id + '">تعديل</button></div>').join('') : '') + '</div>';
  }
  if (cost) {
    const log = OPS.filter(o => o.type !== 'void' && !S.voided.has(o.id) && !['user_upsert', 'settings_set'].includes(o.type)).sort((a, b) => b.ts - a.ts).slice(0, 30);
    h += '<div class="card"><b>آخر العمليات</b><p class="hint">إلغاء عملية يعكس أثرها بالكامل ويبقى سجلها محفوظًا.</p>' + log.map(o => '<div class="sum"><span>' + esc(describe(o)) + '</span>' + (C.can(r, 'void') ? '<button class="btn sm red" data-a="void" data-id="' + o.id + '">إلغاء</button>' : '') + '</div>').join('') + '</div>';
    h += '<div class="card"><b>نسخة احتياطية</b><div class="row" style="margin-top:8px"><button class="btn" data-a="backup">تنزيل نسخة</button>' + (own ? '<label class="btn" style="margin:0">استعادة<input type="file" id="restore" accept=".json" hidden></label>' : '') + '</div></div>';
  }
  const rej = OPS.filter(o => o._r);
  if (rej.length) h += '<div class="card"><b>عمليات رفضها الخادم</b>' + rej.map(o => '<div class="alert err">' + esc(describe(o)) + ' — ' + esc(o._r) + '</div>').join('') + '</div>';
  return h + '<p class="hint" style="text-align:center">الإصدار ' + C.VERSION + ' · جهاز ' + DEV + ' · ' + S.opsCount + ' عملية</p>';
}
function describe(o) {
  const p = o.p, u = (S.users[o.by] || {}).name || '', pn = id => (S.products[id] || {}).name || '';
  const t = {
    user_upsert: 'مستخدم: ' + p.name, settings_set: 'إعدادات', material_upsert: 'مادة: ' + p.name, product_upsert: 'منتج: ' + p.name, purchase: 'شراء ' + ((S.materials[p.materialId] || {}).name || ''), gift: 'هدية ' + p.qty + '× ' + pn(p.productId) + ' إلى ' + p.to,
    production: 'تعبئة ' + p.units + ' × ' + pn(p.productId), order_create: 'طلب ' + p.code, order_edit: 'تعديل طلب ' + ((S.orders[p.orderId] || {}).code || ''), order_status: 'حالة ' + ((S.orders[p.orderId] || {}).code || '') + ' ← ' + C.STATUS[p.status],
    payment: 'دفعة ' + num(p.amt), expense: 'مصروف ' + C.EXP_CATS[p.cat] + ' ' + num(p.amt), withdrawal: 'مسحوب ' + C.WD_CATS[p.cat] + ' ' + num(p.amt), coupon_upsert: 'كود خصم ' + p.code, bundle_upsert: 'باقة: ' + p.name,
    debt_add: 'دين: ' + p.party + ' ' + num(p.amt), debt_pay: 'دفعة دين ' + ((S.debts[p.debtId] || {}).party || '') + ' ' + num(p.amt), adjust: 'تسوية: ' + (p.reason || ''), void: 'إلغاء عملية'
  }[o.type] || o.type;
  return o.date + ' · ' + t + ' · ' + u;
}
function userModal(id) {
  const u = S.users[id] || {}, cm = u.commission || { type: 'pct', value: 0 };
  modal(id ? 'تعديل مستخدم' : 'مستخدم جديد', '<label>الاسم<input name="name" value="' + esc(u.name || '') + '"></label><label>الدور<select name="role">' + opt(C.ROLES, u.role || 'sales') + '</select></label><label>رمز سري جديد' + (id ? ' (اتركه فارغًا للإبقاء)' : '') + '<input name="pin" type="password" inputmode="numeric"></label>' +
    '<div class="sec"><h3>عمولة على الطلبات المستلمة</h3><div class="g2 keep"><label>النوع<select name="ct"><option value="pct"' + (cm.type === 'pct' ? ' selected' : '') + '>نسبة %</option><option value="amt"' + (cm.type === 'amt' ? ' selected' : '') + '>مبلغ لكل طلب</option></select></label><label>القيمة (0 = بلا عمولة)<input name="cv" inputmode="decimal" value="' + (cm.value ? cm.value / 1000 : 0) + '"></label></div></div>' +
    (id ? '<label>الحالة<select name="active"><option value="1"' + (u.active !== false ? ' selected' : '') + '>فعّال</option><option value="0"' + (u.active === false ? ' selected' : '') + '>موقوف</option></select></label>' : ''), f => {
    const v = fd(f), pin = C.normDigits(v.pin), cv = C.toM(v.cv || '0');
    if (!v.name.trim()) { toast('اكتب الاسم', 1); return false; }
    if (!id && !/^\d{4,}$/.test(pin)) { toast('الرمز السري 4 أرقام على الأقل', 1); return false; }
    if (pin && !/^\d{4,}$/.test(pin)) { toast('الرمز السري 4 أرقام على الأقل', 1); return false; }
    if (!(cv >= 0) || (v.ct === 'pct' && cv > 100000)) { toast('قيمة العمولة غير صحيحة', 1); return false; }
    const rec = Object.assign({}, u, { id: id || C.uid(), name: v.name.trim(), role: v.role, active: id ? v.active === '1' : true, commission: { type: v.ct, value: cv } });
    if (pin) { rec.salt = C.uid().slice(0, 8); rec.hash = C.hashPin(pin, rec.salt); }
    if (id === USER.id && (rec.role !== 'owner' || rec.active === false)) { toast('لا يمكنك تقليل صلاحيتك أو إيقاف نفسك', 1); return false; }
    if (!commit('user_upsert', rec)) return false;
  });
}
function goalModal() {
  modal('الهدف الشهري', '<label>عدد الطلبات المستلمة المطلوب في الشهر<input name="g" inputmode="numeric" value="' + (S.settings.goalOrders || '') + '"></label>', f => {
    const g = Number(C.normDigits(f.g.value)) || 0;
    if (g < 0 || !Number.isInteger(g)) { toast('رقم غير صحيح', 1); return false; }
    if (!commit('settings_set', { goalOrders: g })) return false;
  });
}
function bundleModal(id) {
  const b = S.bundles[id] || { items: [], active: true }, prods = Object.values(S.products).filter(p => p.active !== false);
  if (!prods.length) return toast('أضف المنتجات أولًا', 1);
  const row = it => '<div class="line" style="grid-template-columns:2fr 70px auto"><label>العطر<select name="bp">' + prods.map(p => '<option value="' + p.id + '"' + (it && it.productId === p.id ? ' selected' : '') + '>' + esc(p.name) + ' — ' + num(p.price) + '</option>').join('') + '</select></label><label>العدد<input name="bq" inputmode="numeric" value="' + (it ? it.qty : 1) + '"></label><button type="button" class="x" data-a="rmLine">×</button></div>';
  modal(id ? 'تعديل باقة' : 'باقة جديدة', '<label>اسم الباقة<input name="name" value="' + esc(b.name || '') + '" placeholder="مثال: باقة الثنائي"></label><label>سعر الباقة (د.ل)<input name="price" inputmode="decimal" value="' + (b.price ? b.price / 1000 : '') + '"></label><h3>محتويات الباقة</h3><div id="lines">' + (b.items.length ? b.items.map(row).join('') : row(null) + row(null)) + '</div><button type="button" class="btn sm" id="addB">+ عطر</button>' +
    (id ? '<label style="margin-top:10px">الحالة<select name="active"><option value="1"' + (b.active ? ' selected' : '') + '>فعّالة</option><option value="0"' + (!b.active ? ' selected' : '') + '>موقوفة</option></select></label>' : ''), f => {
    const v = fd(f), items = $$('.line', f).map(l => ({ productId: $('[name=bp]', l).value, qty: Number(C.normDigits($('[name=bq]', l).value)) }));
    if (!commit('bundle_upsert', { id: id || C.uid(), name: v.name.trim(), price: C.toM(v.price), items, active: id ? v.active === '1' : true })) return false;
  });
  $('#addB').onclick = () => $('#lines').insertAdjacentHTML('beforeend', row(null));
}
function helpSheet() {
  const m = $('#modal');
  m.innerHTML = '<div class="sheet"><h2>دليل سريع</h2>' +
    '<div class="help"><b>طلب جديد:</b> زر + الذهبي في الشريط. كل شيء في شاشة واحدة: العميل، المنتجات (مع خيار «هدية»)، الخصم، التوصيل، مصدر الطلب.</div>' +
    '<div class="help"><b>بعد الطلب:</b> افتح الطلب ← «تجهيز للتوصيل» لنسخ البيانات بترتيب تطبيق الشركة، «ورقة الكيس» للطباعة، «واتساب» لرسالة جاهزة للعميل.</div>' +
    '<div class="help"><b>الحالات:</b> جديد ← مع المندوب (يُخصم من المخزون) ← مستلم (يُحسب الإيراد). وبدائل: مرفوض، مرتجع، ملغي.</div>' +
    '<div class="help"><b>المخزون:</b> سجّل المواد وشراءها، ثم المنتج بتركيبته، ثم «تعبئة» لتحويل المواد إلى زجاجات جاهزة.</div>' +
    '<div class="help"><b>المزيد:</b> العملاء، الديون، المصروفات والمسحوبات، التقارير، الإعدادات.</div>' +
    '<div class="row" style="margin-top:12px"><button class="btn pri" data-a="close">فهمت</button></div></div>';
  m.hidden = false;
}
// ---------- الأوامر والتشغيل ----------
const A = {
  tab: t => { ui.tab = t.dataset.id; ui.custKey = ''; ui.gq = ''; render(); window.scrollTo(0, 0); },
  period: t => { ui.period = t.dataset.id; render(); },
  ostatus: t => { ui.ostatus = t.dataset.id; render(); },
  stab: t => { ui.stab = t.dataset.id; render(); },
  etab: t => { ui.etab = t.dataset.id; render(); },
  ddir: t => { ui.ddir = t.dataset.id; render(); },
  goOrders: t => { ui.tab = 'orders'; ui.ostatus = t.dataset.s || 'all'; render(); },
  goStock: t => { ui.tab = 'stock'; ui.stab = t.dataset.t === 'material' ? 'mat' : 'prod'; render(); },
  cust: t => { ui.tab = 'cust'; ui.custKey = t.dataset.id; closeModal(); render(); window.scrollTo(0, 0); },
  custBack: () => { ui.custKey = ''; render(); },
  close: closeModal,
  connect: connectModal, logout,
  syncNow: () => sync(true).then(ok => { toast(ok ? 'تمت المزامنة' : 'تعذرت المزامنة: ' + lastErr, !ok); render(); }),
  newOrder, order: t => orderDetail(t.dataset.id), status: t => setStatus(t.dataset.id, t.dataset.s), pay: t => payModal(t.dataset.id), ccode: t => courierModal(t.dataset.id), print: t => printOrder(t.dataset.id),
  delivery: t => deliveryModal(t.dataset.id), bag: t => printBag(t.dataset.id),
  wa: t => { const o = S.orders[t.dataset.id]; if (!o) return; const ph = intlPhone(o.customer.phone); if (!ph) return toast('لا يوجد رقم هاتف', 1); window.open('https://wa.me/' + ph + '?text=' + encodeURIComponent(waText(o)), '_blank'); },
  cp: t => { const r = (window.__dRows || [])[Number(t.dataset.i)]; if (r) copyText(String(r[1])); },
  cpAll: () => copyText((window.__dRows || []).map(r => r[0] + ': ' + r[1]).join('\n')),
  addLine: () => { $('#lines').insertAdjacentHTML('beforeend', lineHtml()); },
  rmLine: t => { const ls = $$('.line'); if (ls.length > 1) { t.closest('.line').remove(); if ($('#otot')) calcOrderForm(); } },
  editMat: t => matModal(t.dataset.id), editProd: t => prodModal(t.dataset.id), advProd: t => prodModalAdv(t.dataset.id || undefined), buy: t => buyModal(t.dataset.id), adj: t => adjModal(t.dataset.t, t.dataset.id), prod: t => produceModal(t.dataset.id),
  newExp: expModal, newWd: wdModal, user: t => userModal(t.dataset.id), goal: goalModal, bundle: t => bundleModal(t.dataset.id), helpSheet,
  newDebt: debtModal, debt: t => debtDetail(t.dataset.id), payDebt: t => debtPayModal(t.dataset.id),
  rate: () => modal('سعر الصرف', '<label>دينار لكل 1 دولار<input name="r" inputmode="decimal" value="' + S.settings.rate / 1000 + '"></label>', f => { const r = C.toM(f.r.value); if (!(r > 0)) { toast('قيمة غير صحيحة', 1); return false; } if (!commit('settings_set', { rate: r })) return false; }),
  void: t => askConfirm('سيتم عكس أثر هذه العملية بالكامل. متأكد؟', () => commit('void', { target: t.dataset.id })),
  csv: t => { const v = C.views(S)[t.dataset.id]; if (v) download(t.dataset.id + '.csv', toCSV(v)); },
  backup: () => download('backup-' + today() + '.json', JSON.stringify(OPS.map(strip)), 'application/json')
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-a]'); if (!t) return;
  if (t.tagName === 'A' && !t.getAttribute('target')) e.preventDefault();
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

(async function boot() {
  await idbOpen();
  OPS = await idbAll(); recompute();
  const sid = LS.get('session', null); if (sid && S.users[sid] && S.users[sid].active !== false) USER = S.users[sid];
  render(); sync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();
