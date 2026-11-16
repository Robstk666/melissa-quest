// Квест Мелиссы — серверная часть на Google Apps Script.
// Данные лежат в Google Таблице "Квест Мелиссы — данные" в аккаунте владельца.
// Первый запуск: выбрать функцию setup и нажать "Выполнить" (создаст таблицу, семью и квесты).
// Потом: Развернуть → Новое развертывание → Веб-приложение, запуск от моего имени, доступ: все.

var FAMILY_CODE = 'MQXW7DW8ZA';
var TZ = 'Europe/Moscow';
var SEED = [
  ['Убрать со стола после еды', '🍽️', 2, 'day', false],
  ['Уроки вовремя', '📚', 3, 'day', false],
  ['Порядок на рабочем столе', '🧹', 1, 'day', false],
  ['Заправить постель', '🛏️', 1, 'day', false],
  ['Зарядка 5 минут', '🤸', 2, 'day', true],
  ['Пропылесосить дома', '🌀', 5, 'week', false],
  ['Стирка: загрузить, разгрузить, протереть', '🧺', 4, 'week', false],
  ['Развесить и разнести бельё', '👕', 3, 'week', false],
  ['Душ', '🚿', 0, 'care', false]
];

/* ---------- storage: one sheet per table, columns: id | json ---------- */
function ss_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('MQ_SHEET');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var s = SpreadsheetApp.create('Квест Мелиссы — данные');
  p.setProperty('MQ_SHEET', s.getId());
  return s;
}
var CACHE_ = {};
function sheet_(name) {
  var s = ss_();
  return s.getSheetByName(name) || s.insertSheet(name);
}
function rows_(name) {
  if (CACHE_[name]) return CACHE_[name];
  var v = sheet_(name).getDataRange().getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) if (v[i][0] !== '' && v[i][1] !== '') out.push(JSON.parse(v[i][1]));
  CACHE_[name] = out;
  return out;
}
function save_(name, rows) {
  var sh = sheet_(name);
  sh.clearContents();
  if (rows.length) sh.getRange(1, 1, rows.length, 2).setValues(rows.map(function (r) { return [r.id, JSON.stringify(r)]; }));
  CACHE_[name] = rows;
}
function uid_() { return Utilities.getUuid(); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function shift_(d, n) { var t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function hash_(pin, salt) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return b.map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join('');
}
function fail_(code) { throw new Error('MQ:' + code); }

/* ---------- helpers ---------- */
function fam_(code) {
  var c = String(code || '').trim().toUpperCase();
  var f = rows_('family').filter(function (x) { return x.code === c; })[0];
  if (!f) { Utilities.sleep(300); fail_('bad_code'); }
  return f;
}
function saveFam_(f) { save_('family', rows_('family').map(function (x) { return x.id === f.id ? f : x; })); }
function adult_(f, role, pin) {
  var h = role === 'mom' ? f.mom_pin : role === 'dad' ? f.dad_pin : null;
  if (!h || pin == null || hash_(String(pin), h.salt) !== h.hash) { Utilities.sleep(300); fail_('bad_pin'); }
}
function clip_(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; }
function msg_(f, from, body, sys) {
  var m = rows_('msg').slice();
  m.push({ id: uid_(), family_id: f.id, from_role: from, body: body, sys: !!sys, created_at: new Date().toISOString() });
  save_('msg', m);
}

/* ---------- API (same contract as the old Supabase functions) ---------- */
function mq_state(a) {
  var f = fam_(a.p_code);
  var tasks = rows_('task').filter(function (t) { return t.family_id === f.id; });
  var byId = {}; tasks.forEach(function (t) { byId[t.id] = t; });
  var from = shift_(today_(), -60);
  var done = rows_('done').filter(function (d) { return d.family_id === f.id && d.season === f.season && d.day >= from && byId[d.task_id]; })
    .sort(function (x, y) { return x.created_at < y.created_at ? -1 : 1; });
  var points = 0;
  rows_('done').forEach(function (d) { if (d.family_id === f.id && d.season === f.season && d.status === 'approved') points += d.points; });
  var msgs = rows_('msg').filter(function (m) { return m.family_id === f.id; })
    .sort(function (x, y) { return x.created_at < y.created_at ? 1 : -1; }).slice(0, 40);
  return {
    family: { child_name: f.child_name, goal_title: f.goal_title, target: f.target, start_date: f.start_date, days: f.days,
      season: f.season, avatar: f.avatar, theme: f.theme, mom_has_pin: !!f.mom_pin, dad_has_pin: !!f.dad_pin },
    tasks: tasks.filter(function (t) { return t.active; }).sort(function (x, y) { return x.sort - y.sort || (x.created_at < y.created_at ? -1 : 1); })
      .map(function (t) { return { id: t.id, title: t.title, icon: t.icon, points: t.points, kind: t.kind, timer: t.timer }; }),
    done: done.map(function (d) { var t = byId[d.task_id]; return { id: d.id, task_id: d.task_id, day: d.day, status: d.status, points: d.points,
      by: d.decided_by || null, title: t.title, icon: t.icon, tp: t.points, kind: t.kind }; }),
    msgs: msgs.map(function (m) { return { id: m.id, from: m.from_role, body: m.body, sys: m.sys, at: m.created_at }; }),
    points: points
  };
}
function mq_set_pin(a) {
  var f = fam_(a.p_code);
  if (a.p_role !== 'mom' && a.p_role !== 'dad') fail_('bad_role');
  if (!/^[0-9]{4}$/.test(String(a.p_pin || ''))) fail_('pin_format');
  var k = a.p_role + '_pin';
  if (f[k]) fail_('pin_exists');
  var salt = uid_();
  f[k] = { salt: salt, hash: hash_(String(a.p_pin), salt) };
  saveFam_(f);
  return mq_state(a);
}
function mq_check_pin(a) { var f = fam_(a.p_code); adult_(f, a.p_role, a.p_pin); return true; }
function mq_mark(a) {
  var f = fam_(a.p_code);
  var t = rows_('task').filter(function (x) { return x.id === a.p_task && x.family_id === f.id && x.active; })[0];
  if (!t) fail_('bad_task');
  var td = today_();
  if (a.p_day !== td && a.p_day !== shift_(td, -1) && a.p_day !== shift_(td, 1)) fail_('bad_day');
  var all = rows_('done').slice();
  var ex = all.filter(function (d) { return d.task_id === t.id && d.day === a.p_day; })[0];
  if (ex) {
    if (ex.status === 'rejected') { ex.status = 'pending'; ex.decided_by = null; ex.decided_at = null; save_('done', all); }
  } else {
    all.push({ id: uid_(), family_id: f.id, task_id: t.id, day: a.p_day, status: t.kind === 'care' ? 'approved' : 'pending',
      points: 0, season: f.season, decided_by: null, created_at: new Date().toISOString(), decided_at: null });
    save_('done', all);
  }
  return mq_state(a);
}
function mq_decide(a) {
  var f = fam_(a.p_code); adult_(f, a.p_role, a.p_pin);
  var all = rows_('done').slice();
  var d = all.filter(function (x) { return x.id === a.p_done && x.family_id === f.id && x.status === 'pending'; })[0];
  if (!d) return mq_state(a);
  var t = rows_('task').filter(function (x) { return x.id === d.task_id; })[0];
  d.status = a.p_ok ? 'approved' : 'rejected';
  d.points = a.p_ok ? t.points : 0;
  d.decided_by = a.p_role; d.decided_at = new Date().toISOString();
  save_('done', all);
  if (a.p_ok) msg_(f, a.p_role, (a.p_role === 'mom' ? 'Мама подтвердила: ' : 'Папа подтвердил: ') + t.title + '. +' + t.points, true);
  else msg_(f, a.p_role, 'Давай доделаем: ' + t.title, false);
  return mq_state(a);
}
function mq_task_add(a) {
  var f = fam_(a.p_code); adult_(f, a.p_role, a.p_pin);
  var title = clip_(a.p_title, 60);
  if (['day', 'week', 'care'].indexOf(a.p_kind) < 0 || !title) fail_('bad_task');
  var pts = a.p_kind === 'care' ? 0 : Math.max(1, Math.min(10, parseInt(a.p_points, 10) || 1));
  var all = rows_('task').slice();
  all.push({ id: uid_(), family_id: f.id, title: title, icon: clip_(a.p_icon, 8) || '⭐', points: pts, kind: a.p_kind,
    timer: false, active: true, sort: 100, created_at: new Date().toISOString() });
  save_('task', all);
  return mq_state(a);
}
function mq_task_hide(a) {
  var f = fam_(a.p_code); adult_(f, a.p_role, a.p_pin);
  var all = rows_('task').slice();
  all.forEach(function (t) { if (t.id === a.p_task && t.family_id === f.id) t.active = false; });
  save_('task', all);
  return mq_state(a);
}
function mq_say(a) {
  var f = fam_(a.p_code);
  if (a.p_role !== 'child') adult_(f, a.p_role, a.p_pin);
  var body = clip_(a.p_body, 200);
  if (!body) fail_('empty');
  msg_(f, a.p_role, body, false);
  return mq_state(a);
}
function mq_profile(a) {
  var f = fam_(a.p_code);
  if (['cat', 'fox', 'bunny', 'robot'].indexOf(a.p_avatar) >= 0) f.avatar = a.p_avatar;
  if (['pixel', 'glass'].indexOf(a.p_theme) >= 0) f.theme = a.p_theme;
  saveFam_(f);
  return mq_state(a);
}
function mq_settings(a) {
  var f = fam_(a.p_code); adult_(f, a.p_role, a.p_pin);
  var g = clip_(a.p_goal, 40); if (g) f.goal_title = g;
  if (a.p_target != null) f.target = Math.max(10, Math.min(5000, parseInt(a.p_target, 10) || f.target));
  if (a.p_days != null) f.days = Math.max(1, Math.min(365, parseInt(a.p_days, 10) || f.days));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(a.p_start || ''))) f.start_date = a.p_start;
  saveFam_(f);
  return mq_state(a);
}

var API = { mq_state: mq_state, mq_set_pin: mq_set_pin, mq_check_pin: mq_check_pin, mq_mark: mq_mark, mq_decide: mq_decide,
  mq_task_add: mq_task_add, mq_task_hide: mq_task_hide, mq_say: mq_say, mq_profile: mq_profile, mq_settings: mq_settings };

function handle_(body) {
  var out;
  try {
    var req = JSON.parse(body || '{}');
    var fn = API[req.fn];
    if (!fn) fail_('bad_fn');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { out = { result: fn(req.args || {}) }; } finally { lock.releaseLock(); }
  } catch (e) {
    var m = String(e && e.message || e);
    out = { error: m.indexOf('MQ:') === 0 ? m.slice(3) : 'server' };
    if (m.indexOf('MQ:') !== 0) console.error(m);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) { return handle_(e && e.postData && e.postData.contents); }
function doGet(e) { return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'melissa-quest' })).setMimeType(ContentService.MimeType.JSON); }

/* ---------- one-time setup: run from the editor ---------- */
function setup() {
  var fams = rows_('family').slice();
  var f = fams.filter(function (x) { return x.code === FAMILY_CODE; })[0];
  if (!f) {
    f = { id: uid_(), code: FAMILY_CODE, child_name: 'Мелисса', goal_title: 'Свой телефон', target: 250, start_date: today_(),
      days: 30, season: 1, avatar: 'cat', theme: 'glass', mom_pin: null, dad_pin: null, created_at: new Date().toISOString() };
    fams.push(f); save_('family', fams);
  }
  var tasks = rows_('task').slice();
  if (!tasks.some(function (t) { return t.family_id === f.id; })) {
    SEED.forEach(function (s, i) {
      tasks.push({ id: uid_(), family_id: f.id, title: s[0], icon: s[1], points: s[2], kind: s[3], timer: s[4], active: true,
        sort: i + 1, created_at: new Date().toISOString() });
    });
    save_('task', tasks);
  }
  sheet_('done'); sheet_('msg');
  var def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('Лист1');
  if (def && ss_().getSheets().length > 1) ss_().deleteSheet(def);
  Logger.log('Готово. Таблица: ' + ss_().getUrl() + ' Семейный код: ' + FAMILY_CODE);
}
