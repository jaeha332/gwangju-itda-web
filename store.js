/* 광주잇다 사장님 — store.html 전용 상태 머신
   화면: s0 부팅 → s1 가게 찾기 → s2 인증 수단 → s3a 사업자 / s3b 파일럿 코드 / s3c 문자 → s4 결과 → s5 관리 → (s6 만료 게이트 오버레이)
   원칙: 서버·사용자 텍스트는 전부 textContent/createElement, 실패는 반드시 말한다(침묵 금지),
        사업자번호·성함·전화는 localStorage/console에 절대 남기지 않는다. */
'use strict';

const qs = new URLSearchParams(location.search);
const NET_MSG = '서버에 연결할 수 없어요. 잠시 후 다시 눌러 주세요.';
const OWNER_KEY = 'itda_owner';
const DRAFT_KEY = 'itda_owner_draft';
const PHOTO_HOSTS = new Set(['firebasestorage.googleapis.com', 'storage.googleapis.com']);
const $ = id => document.getElementById(id);

/* ─── 서버 주소: ?server= → localStorage.itda_server → API가 직접 서빙(/store) → localhost ─── */
function resolveServer() {
  const p = qs.get('server');
  if (p) { lsSet('itda_server', p); return p.replace(/\/+$/, ''); }
  const ls = lsGet('itda_server');
  if (ls) return ls.replace(/\/+$/, '');
  // API가 직접 서빙(/store)하거나, 공개 배포에서 같은 서버가 /app/store.html 을 내려준 경우 → 그 출처가 곧 API
  if (/^https?:$/.test(location.protocol)) {
    const h = location.hostname;
    if (/\/store\/?$/.test(location.pathname)) return location.origin;
    if (/\.github\.io$/.test(h)) return 'https://gwangju-itda-api.onrender.com';   // Pages는 정적 — API는 공개 배포 서버
    if (h && h !== 'localhost' && h !== '127.0.0.1') return location.origin;
  }
  return 'http://localhost:8000';
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }
function lsJSON(k) { try { return JSON.parse(lsGet(k)); } catch { return null; } }
const SERVER = resolveServer();
// 앱(index.html)에서 들어왔으면 돌아갈 길을 남긴다 — 폰에는 주소창이 없다
if (qs.get('from') === 'app') { try { const b = document.getElementById('backApp'); if (b) { b.hidden = false; b.style.display = 'block'; } } catch (e) {} }
const SERVER_ORIGIN = (() => { try { return new URL(SERVER).origin; } catch { return ''; } })();

/* ─── 공용 fetch: JSON, 8초 타임아웃, 실패는 {ok:false, reason} ─── */
async function api(path, body, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const opt = { signal: ctrl.signal, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(SERVER + path, opt);
    let d = null;
    try { d = await r.json(); } catch {}
    if (d && typeof d === 'object') {
      if (!r.ok && d.ok === undefined) d.ok = false;
      if (!d.ok && !d.reason) {                       // FastAPI 422 등의 detail을 사람 말로
        d.reason = typeof d.detail === 'string' ? d.detail
          : Array.isArray(d.detail) ? '입력 형식이 맞지 않아요. 다시 확인해 주세요.'
          : '요청이 처리되지 않았어요 (HTTP ' + r.status + ')';
      }
      return d;
    }
    return { ok: false, http: r.status,
      reason: r.ok ? '서버 응답을 읽을 수 없어요.' : '서버 오류가 났어요 (HTTP ' + r.status + ')' };
  } catch {
    return { ok: false, reason: NET_MSG, net: true };
  } finally { clearTimeout(t); }
}

/* ─── DOM 도우미 ─── */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hide', s.id !== id));
  document.body.dataset.screen = id;
  $('hdSub').textContent = id === 's5' ? '우리 가게 정보만 고칠 수 있어요' : '회원가입 없음 · 우리 가게만 찾으면 됩니다';
  window.scrollTo(0, 0);
}
function flash(id, msg, kind) {             // 실패도 반드시 말한다 — 에러는 남기고 성공만 8초 뒤 사라짐
  const e = $(id); if (!e) return;
  clearTimeout(e._t);
  if (!msg) { e.style.display = 'none'; e.textContent = ''; return; }
  e.textContent = msg;
  e.className = 'flash ' + (kind || 'ok');
  e.style.display = 'block';
  if (kind !== 'err') e._t = setTimeout(() => { e.style.display = 'none'; }, 8000);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; if (label) btn.textContent = label; }
  else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
}
const digits = s => String(s || '').replace(/[^0-9]/g, '');
const won = n => { const d = digits(n); return d ? Number(d).toLocaleString('ko-KR') + '원' : ''; };
function hhmm(s) {                               // "9:00" → "09:00", 그 외는 그대로/빈값
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : '';
}
const toMin = t => { const m = /^(\d{2}):(\d{2})$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function todayISO() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function safePhotoUrl(u) {                       // 서버 오리진 또는 허용 호스트만 썸네일 허용
  try {
    const url = new URL(String(u || ''), SERVER);
    if (!/^https?:$/.test(url.protocol)) return '';
    if (url.origin === SERVER_ORIGIN || PHOTO_HOSTS.has(url.hostname)) return url.href;
  } catch {}
  return '';
}
function safeLink(u) { try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } }

/* ─── 상태 ─── */
const S = {
  code: null, store: null, method: null, expires_min: 30,
  caps: { photo: false, ocr: false, hours_nlu: false, methods: null }, capsLoaded: false,
  sel: null, pendingToken: null, pendingStore: null,
  timer: null, gateAt: 0, draftTimer: null, serverSnap: null, photoKind: 'menu', resendTimer: null,
};
const METHOD_LABEL = { biz: '사업자 인증', biz_phone: '사업자 인증', code: '파일럿 코드', sms: '문자 인증' };

function readOwner() { const o = lsJSON(OWNER_KEY); return o && typeof o === 'object' ? o : null; }
function saveOwner(o) { lsSet(OWNER_KEY, JSON.stringify(o)); }       // code·store_id·name·method·issued_at만 — 개인정보 없음
function clearOwner() { lsDel(OWNER_KEY); }

/* ═══ S0 부팅 ═══ */
async function loadCaps() {
  const d = await api('/owner/capabilities');
  S.caps = d.ok
    ? { photo: !!d.photo, ocr: !!d.ocr, hours_nlu: !!d.hours_nlu, photo_backend: d.photo_backend || '',
        methods: Array.isArray(d.methods) && d.methods.length ? d.methods : null }
    : { photo: false, ocr: false, hours_nlu: false, methods: null };
  S.capsLoaded = true;
  if (S.store) applyCaps();
}
async function boot() {
  const capsP = loadCaps();
  const qcode = (qs.get('code') || '').trim();
  const saved = readOwner();
  const code = qcode || (saved && (saved.code || saved.token)) || '';   // token: 구 마이페이지 저장 형식 호환
  if (code) {
    go('s0');
    const r = await openSession(code, { remember: true, method: saved && saved.method });
    if (!r.ok) {
      go('s1');
      if (r.net) flash('s1Msg', NET_MSG + ' (저장된 관리 번호는 그대로 두었어요)', 'err');
      else { clearOwner(); flash('s1Msg', '관리 번호가 더 이상 유효하지 않아요. 다시 인증해 주세요', 'err'); }
    }
  } else go('s1');
  await capsP;
}

/* 세션 열기 → S5. 실패 시 {ok:false, reason} 반환 */
async function openSession(code, opt = {}) {
  const r = await api('/owner/session', { code });
  if (!r.ok) return r;
  if (!r.store) return { ok: false, reason: '가게 정보를 받지 못했어요. 다시 눌러 주세요.' };
  S.code = code; S.store = r.store; S.expires_min = Number(r.expires_min) > 0 ? Number(r.expires_min) : 30;
  S.method = r.store.method || opt.method || (code.length <= 4 ? 'code' : 'biz');
  if (opt.remember) {
    const prev = readOwner() || {};
    saveOwner({ code, store_id: r.store.id, name: r.store.name, method: S.method, issued_at: prev.issued_at || Date.now() });
  }
  renderManage();
  go('s5');
  startGate();
  return r;
}

/* ═══ S1 가게 찾기 ═══ */
async function doSearch() {
  const q = $('q').value.trim();
  const box = $('hits'); box.textContent = '';
  flash('qMsg', '');
  if (q.length < 2) { flash('qMsg', '두 글자 이상 넣어 주세요', 'err'); return; }
  busy($('searchBtn'), true, '찾는 중…');
  const d = await api('/stores/search?q=' + encodeURIComponent(q));
  busy($('searchBtn'), false);
  if (!d.ok) { flash('qMsg', d.reason || '검색이 안 됐어요. 다시 눌러 주세요.', 'err'); return; }
  const stores = Array.isArray(d.stores) ? d.stores : [];
  if (!stores.length) {
    flash('qMsg', (d.total ? '광주 ' + Number(d.total).toLocaleString('ko-KR') + '곳에서 ' : '') + '찾지 못했어요. 다른 말로 다시 찾아 보세요.', 'err');
    return;
  }
  stores.forEach(s => {
    const b = el('button', 'hit'); b.type = 'button';
    const nm = el('div', 'nm', s.name);
    if (s.claimed) { nm.appendChild(document.createTextNode(' ')); nm.appendChild(el('span', 'badge gray', '이미 등록된 가게')); }
    b.appendChild(nm);
    b.appendChild(el('div', 'ct', [s.category, s.zone].filter(Boolean).join(' · ')));
    if (s.addr) b.appendChild(el('div', 'ad', s.addr));
    b.addEventListener('click', () => pickStore(s));
    box.appendChild(b);
  });
}
$('searchBtn').addEventListener('click', doSearch);
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
$('toCode').addEventListener('click', () => { flash('codeMsg', ''); go('s3b'); setTimeout(() => $('pcode').focus(), 50); });

/* ═══ S2 인증 수단 ═══ */
async function getMethods() {
  if (S.caps.methods) return S.caps.methods;
  const d = await api('/owner/methods');
  if (d.ok && Array.isArray(d.methods) && d.methods.length) return d.methods;
  return [{ id: 'code', label: '종이로 받은 4자리 코드', desc: '저희가 가게에 전해 드린 코드로 바로 열어요', fallback: true }];
}
async function pickStore(s) {
  S.sel = s;
  $('s2Name').textContent = s.name || '';
  $('s2Addr').textContent = [s.category, s.zone, s.addr].filter(Boolean).join(' · ');
  flash('s2Note', s.claimed ? '다른 분이 먼저 등록했어요. 본인 가게면 사업자등록 인증으로 다시 받을 수 있어요' : '', 'info');
  flash('s2Msg', '');
  const box = $('methods'); box.textContent = '';
  const methods = await getMethods();
  if (methods.length === 1 && methods[0].id === 'code') {      // 코드만 가능하면 바로 코드 화면
    if (methods[0].fallback) flash('codeMsg', '지금은 서버에 연결되지 않아 종이 코드로만 열 수 있어요', 'err');
    go('s3b'); return;
  }
  methods.forEach(m => {
    const b = el('button', 'method'); b.type = 'button'; b.dataset.method = m.id;
    b.appendChild(el('div', 'nm', m.label || m.id));
    if (m.desc) b.appendChild(el('div', 'ds', m.desc));
    b.addEventListener('click', () => chooseMethod(m.id));
    box.appendChild(b);
  });
  go('s2');
}
function chooseMethod(id) {
  S.method = id;
  if (id === 'biz' || id === 'biz_phone') {
    $('s3aName').textContent = S.sel ? S.sel.name : '';
    $('phoneRow').classList.toggle('hide', id !== 'biz_phone');
    ['bno', 'pnm', 'sdt', 'phone'].forEach(i => { $(i).value = ''; });
    flash('bizMsg', ''); go('s3a'); setTimeout(() => $('bno').focus(), 50);
  } else if (id === 'sms') {
    $('s3cName').textContent = S.sel ? S.sel.name : '';
    $('smsStep2').classList.add('hide'); $('smsCode').value = '';
    busy($('smsSend'), false); flash('smsMsg', ''); go('s3c');
  } else { flash('codeMsg', ''); go('s3b'); setTimeout(() => $('pcode').focus(), 50); }
}
$('s2Back').addEventListener('click', () => go('s1'));
$('s3aBack').addEventListener('click', () => { $('bno').value = ''; go(S.sel ? 's2' : 's1'); });
$('s3cBack').addEventListener('click', () => go(S.sel ? 's2' : 's1'));

/* ═══ S3a 사업자등록 (+전화) ═══ */
$('bno').addEventListener('input', () => {                 // 표시는 000-00-00000, 전송은 숫자 10자리
  const d = digits($('bno').value).slice(0, 10);
  $('bno').value = d.length > 5 ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5)
    : d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d;
});
function validDate8(s) {
  if (!/^\d{8}$/.test(s)) return false;
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  if (y < 1900 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getMonth() === m - 1 && dt.getDate() === d && dt <= new Date();
}
$('bizSubmit').addEventListener('click', async () => {
  flash('bizMsg', '');
  if (!S.sel) { flash('bizMsg', '먼저 가게를 골라 주세요', 'err'); go('s1'); return; }
  const b_no = digits($('bno').value), p_nm = $('pnm').value.trim(), start_dt = digits($('sdt').value);
  const withPhone = S.method === 'biz_phone';
  const phone = digits($('phone').value);
  if (b_no.length !== 10) { flash('bizMsg', '사업자등록번호는 숫자 10자리예요. 다시 확인해 주세요.', 'err'); $('bno').focus(); return; }
  if (p_nm.length < 2) { flash('bizMsg', '대표자 성함을 두 글자 이상 넣어 주세요.', 'err'); $('pnm').focus(); return; }
  if (!validDate8(start_dt)) { flash('bizMsg', '개업일은 8자리 숫자예요. 예: 20150301', 'err'); $('sdt').focus(); return; }
  if (withPhone && (phone.length < 9 || phone.length > 11)) { flash('bizMsg', '가게 전화번호를 지역번호부터 넣어 주세요. 예: 062-234-7731', 'err'); $('phone').focus(); return; }
  const body = { store_key: S.sel.key, b_no, p_nm, start_dt };
  if (withPhone) body.phone = phone;
  busy($('bizSubmit'), true, '국세청에 확인 중…');
  const r = await api('/owner/claim/biz', body, 20000);
  busy($('bizSubmit'), false);
  $('bno').value = '';                                        // 제출 후 사업자번호는 화면에서도 지운다
  handleClaim(r);
});
const PENDING_HINT = {
  phone_mismatch: '입력하신 가게 전화가 공개된 번호와 달라요. 담당자가 확인한 뒤 알려 드릴게요. 종이 코드를 받으셨다면 코드로 바로 열 수 있어요.',
  no_public_phone: '이 가게는 공개된 전화번호가 없어서 사람이 확인해요. 확인되면 관리 번호를 전해 드려요.',
  no_phone_given: '전화번호 없이 접수돼서 사람이 확인해요. 전화번호와 함께 다시 인증하면 바로 열릴 수 있어요.',
};
function handleClaim(r) {
  if (!r.ok) { flash(S.method === 'sms' ? 'smsMsg' : 'bizMsg', r.reason || '인증에 실패했어요. 입력 내용을 다시 확인해 주세요.', 'err'); return; }
  if (r.pending) {
    $('s4ok').classList.add('hide'); $('s4pending').classList.remove('hide');
    flash('s4pServer', r.message || '', 'info');
    $('s4pHint').textContent = PENDING_HINT[r.reason_code] || '';
    $('pnm').value = ''; $('phone').value = '';
    go('s4'); return;
  }
  if (!r.token || !r.store) { flash('bizMsg', '인증은 됐는데 관리 번호를 받지 못했어요. 다시 눌러 주세요.', 'err'); return; }
  S.pendingToken = r.token; S.pendingStore = r.store;
  $('pnm').value = ''; $('phone').value = '';
  saveOwner({ code: r.token, store_id: r.store.id, name: r.store.name, method: S.method, issued_at: Date.now() });
  $('s4ok').classList.remove('hide'); $('s4pending').classList.add('hide');
  $('s4Title').textContent = (r.store.name || '우리 가게') + ' 관리가 열렸어요';
  flash('s4Msg', ''); go('s4');
}
$('startManage').addEventListener('click', async () => {
  busy($('startManage'), true, '여는 중…');
  const r = await openSession(S.pendingToken, { remember: true, method: S.method });
  busy($('startManage'), false);
  if (!r.ok) flash('s4Msg', r.reason || '가게를 열지 못했어요. 다시 눌러 주세요.', 'err');
});
$('s4pCode').addEventListener('click', () => { flash('codeMsg', ''); go('s3b'); });
$('s4pHome').addEventListener('click', () => go('s1'));

/* ═══ S3b 파일럿 코드 ═══ */
async function enterCode() {
  const code = digits($('pcode').value);
  flash('codeMsg', '');
  if (code.length !== 4) { flash('codeMsg', '숫자 4자리를 넣어 주세요', 'err'); return; }
  busy($('codeEnter'), true, '여는 중…');
  const r = await openSession(code, { remember: $('remember').checked, method: 'code' });
  busy($('codeEnter'), false);
  if (!r.ok) flash('codeMsg', r.reason || '없는 코드예요. 안내장의 숫자를 확인해 주세요.', 'err');
}
$('codeEnter').addEventListener('click', enterCode);
$('pcode').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); enterCode(); } });
$('toSearch').addEventListener('click', () => go('s1'));

/* ═══ S3c 문자 인증 ═══ */
function startResend() {
  clearInterval(S.resendTimer);
  let left = 60; const b = $('smsResend');
  b.disabled = true; b.textContent = '다시 보내기 (60초)';
  S.resendTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(S.resendTimer); b.disabled = false; b.textContent = '다시 보내기'; }
    else b.textContent = '다시 보내기 (' + left + '초)';
  }, 1000);
}
async function smsRequest(btn) {
  if (!S.sel) { go('s1'); return; }
  flash('smsMsg', '');
  busy(btn, true, '보내는 중…');
  const r = await api('/owner/claim/sms/request', { store_key: S.sel.key });
  busy(btn, false);
  if (!r.ok) { flash('smsMsg', r.reason || '문자를 보내지 못했어요. 다시 눌러 주세요.', 'err'); return; }
  $('smsStep2').classList.remove('hide'); $('smsSend').classList.add('hide');
  flash('smsMsg', (r.sent_to || '가게 전화') + '로 보냈어요 — 5분 안에 넣어 주세요');
  startResend(); setTimeout(() => $('smsCode').focus(), 50);
}
$('smsSend').addEventListener('click', () => smsRequest($('smsSend')));
$('smsResend').addEventListener('click', () => smsRequest($('smsResend')));
$('smsVerify').addEventListener('click', async () => {
  const code = digits($('smsCode').value);
  if (code.length !== 6) { flash('smsMsg', '인증번호 6자리를 넣어 주세요', 'err'); return; }
  busy($('smsVerify'), true, '확인 중…');
  const r = await api('/owner/claim/sms/verify', { store_key: S.sel.key, code });
  busy($('smsVerify'), false);
  handleClaim(r);
});

/* ═══ S5 관리 ═══ */
function renderManage() {
  const st = S.store;
  renderHeader();
  renderSeat(!!st.seat_open, st.seat_left_min);
  const h = hoursFromStore(st); applyHours(h);
  const rep = st.rep_menu || {};
  $('repName').value = rep.name || ''; $('repP1').value = digits(rep.price); $('repP2').value = digits(rep.price_2p);
  renderMenu(Array.isArray(st.menu) && st.menu.length ? st.menu : [{}, {}]);
  if (!Array.isArray(st.photos)) st.photos = [];
  renderPhotos();
  applyCaps();
  renderPreview();
  loadPrograms();
  loadReservations();
  $('logoutConfirm').classList.add('hide');
  S.serverSnap = formSnapshot();
  checkDraft();
}
function renderHeader() {
  const st = S.store;
  $('storeName').textContent = st.name || '';
  $('storeMeta').textContent = st.category || '';
  $('methodBadge').textContent = METHOD_LABEL[S.method] || METHOD_LABEL[st.method] || '사장님 확인';
  const v = Number(st.today_views);
  $('viewsLine').classList.toggle('hide', !(v > 0));
  if (v > 0) $('viewsLine').textContent = '오늘 방문객 일정 화면에 ' + v.toLocaleString('ko-KR') + '번 보였어요';   // /views = 화면 노출 수. 방문·매출이 아니다
}
function applyCaps() {
  $('photoCard').classList.toggle('hide', !S.caps.photo);
  $('nluBox').classList.toggle('hide', !S.caps.hours_nlu);
  const menuPhotos = (S.store && S.store.photos || []).filter(p => p.kind === 'menu');
  $('ocrCard').classList.toggle('hide', !(S.caps.ocr && menuPhotos.length));
  $('ocrPick').classList.toggle('hide', menuPhotos.length < 2);
  const sel = $('ocrPhoto'); sel.textContent = '';
  menuPhotos.forEach((p, i) => { const o = el('option', '', '메뉴판 사진 ' + (i + 1)); o.value = String(p.id); sel.appendChild(o); });
  if (menuPhotos.length) sel.value = String(menuPhotos[menuPhotos.length - 1].id);
  document.querySelectorAll('#menuRows .mrow').forEach(syncRowPhotoSelect);
}

/* (2) 자리 있어요 */
function renderSeat(on, leftMin) {
  const b = $('seatBtn');
  b.classList.toggle('on', on); b.dataset.on = on ? '1' : '';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.textContent = on ? '방문객에게 표시 중' + (leftMin ? ' · ' + leftMin + '분 남음' : '') + ' (누르면 끄기)' : '지금 자리 있어요';
}
$('seatBtn').addEventListener('click', async () => {
  const next = !$('seatBtn').dataset.on;
  busy($('seatBtn'), true, '저장 중…');
  const r = await api('/owner/seat', { code: S.code, on: next });
  busy($('seatBtn'), false);
  if (!r.ok) { flash('seatMsg', r.reason || '저장이 안 됐어요. 다시 눌러 주세요.', 'err'); return; }
  const mins = Number(r.until_min) || 30;
  renderSeat(next, next ? mins : 0);
  S.store.seat_open = next; S.store.seat_left_min = next ? mins : 0;
  renderPreview();
  flash('seatMsg', next ? mins + '분 동안 방문객에게 표시됩니다' : '표시를 껐습니다');
});

/* (3) 영업시간 */
function isClosedToday(c) {
  if (c === true) return true;
  const t = todayISO();
  if (typeof c === 'string') return c === t;
  if (Array.isArray(c)) return c.includes(t);
  return false;
}
const DAY_KO = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
function readClosedDays() { return Array.from(document.querySelectorAll('#closedDays input:checked')).map(i => i.value); }
function setClosedDays(days) { const s = new Set(Array.isArray(days) ? days : []); document.querySelectorAll('#closedDays input').forEach(i => { i.checked = s.has(i.value); }); }
function closedDaysText(days) { const d = (Array.isArray(days) ? days : []).map(x => DAY_KO[x]).filter(Boolean); return d.length ? '매주 ' + d.join('·') + '요일 쉬어요' : ''; }
function hoursFromStore(st) {
  const w = (Array.isArray(st.windows) ? st.windows : []).map(x => ({ open: hhmm(x && x.open), close: hhmm(x && x.close) })).filter(x => x.open && x.close);
  const h = { open: hhmm(st.open) || (w[0] ? w[0].open : ''), close: hhmm(st.close) || (w.length ? w[w.length - 1].close : ''),
    brkOn: false, brkStart: '', brkEnd: '', closedToday: isClosedToday(st.closed_on),
    closedDays: Array.isArray(st.closed_days) ? st.closed_days.slice() : [] };
  if (w.length >= 2) { h.open = w[0].open; h.close = w[w.length - 1].close; h.brkOn = true; h.brkStart = w[0].close; h.brkEnd = w[1].open; }
  return h;
}
function applyHours(h) {
  $('open').value = h.open || ''; $('close').value = h.close || '';
  $('brkOn').checked = !!h.brkOn; $('brkStart').value = h.brkStart || ''; $('brkEnd').value = h.brkEnd || '';
  $('closedToday').checked = !!h.closedToday;
  setClosedDays(h.closedDays || []);
  syncHoursUI();
}
function readHours() {
  return { open: $('open').value, close: $('close').value, brkOn: $('brkOn').checked,
    brkStart: $('brkStart').value, brkEnd: $('brkEnd').value, closedToday: $('closedToday').checked, closedDays: readClosedDays() };
}
function syncHoursUI() {
  const closed = $('closedToday').checked;
  $('brkRows').classList.toggle('hide', !$('brkOn').checked);
  $('closedWarn').classList.toggle('hide', !closed);
  ['open', 'close', 'brkStart', 'brkEnd', 'brkOn'].forEach(i => { $(i).disabled = closed; });
  hoursLiveNote();
}
function hoursLiveNote() {
  const h = readHours(); flash('hoursNote', '');
  if (h.closedToday) return;
  const o = toMin(h.open), c = toMin(h.close);
  if (o !== null && c !== null && c <= o) flash('hoursNote', '닫는 시간이 여는 시간보다 빨라서 자정 넘어 영업으로 저장돼요', 'info');
}
$('brkOn').addEventListener('change', syncHoursUI);
$('closedDays').addEventListener('change', () => { hoursLiveNote(); scheduleDraft(); });
$('closedToday').addEventListener('change', syncHoursUI);
$('open').addEventListener('change', hoursLiveNote);
$('close').addEventListener('change', hoursLiveNote);
function buildHours(h) {                          // → {err} | {open, close, windows, closed_today, overnight}
  if (h.closedToday) {
    const w = (h.open && h.close) ? (h.brkOn && h.brkStart && h.brkEnd
      ? [{ open: h.open, close: h.brkStart }, { open: h.brkEnd, close: h.close }] : [{ open: h.open, close: h.close }]) : [];
    return { open: h.open || '', close: h.close || '', windows: w, closed_today: true };
  }
  if (!h.open || !h.close) return { err: '여는 시간과 닫는 시간을 모두 넣어 주세요' };
  const o = toMin(h.open), c = toMin(h.close);
  const overnight = c <= o;
  if (!h.brkOn) return { open: h.open, close: h.close, windows: [{ open: h.open, close: h.close }], closed_today: false, overnight };
  if (!h.brkStart || !h.brkEnd) return { err: '쉬는 시간의 시작과 끝을 모두 넣어 주세요' };
  const bs = toMin(h.brkStart), be = toMin(h.brkEnd);
  if (be <= bs) return { err: '쉬는 시간은 시작이 끝보다 빨라야 해요' };
  if (!overnight && (bs <= o || be >= c)) return { err: '쉬는 시간은 여는 시간과 닫는 시간 사이여야 해요' };
  return { open: h.open, close: h.close, windows: [{ open: h.open, close: h.brkStart }, { open: h.brkEnd, close: h.close }], closed_today: false, overnight };
}
$('saveHours').addEventListener('click', async () => {
  flash('hoursMsg', '');
  const h = readHours(); const b = buildHours(h);
  if (b.err) { flash('hoursMsg', b.err, 'err'); return; }
  busy($('saveHours'), true, '저장 중…');
  const r = await api('/owner/hours', { code: S.code, open: b.open, close: b.close, windows: b.windows, closed_today: b.closed_today, closed_days: h.closedDays });
  busy($('saveHours'), false);
  if (!r.ok) { flash('hoursMsg', r.reason || '저장이 안 됐어요. 다시 눌러 주세요.', 'err'); return; }
  S.store.open = b.open; S.store.close = b.close;
  S.store.windows = Array.isArray(r.windows) ? r.windows : b.windows;
  S.store.closed_on = r.closed_on !== undefined ? r.closed_on : (b.closed_today ? todayISO() : null);
  S.store.closed_today = b.closed_today;
  S.store.closed_days = Array.isArray(r.closed_days) ? r.closed_days : h.closedDays;
  if (r.checked_at) S.store.checked_at = r.checked_at;
  S.serverSnap.hours = readHours(); saveDraft();
  renderPreview();
  flash('hoursMsg', b.closed_today ? '오늘은 방문객 일정에서 빠져요 — 내일 다시 켜 주세요'
    : '저장됐어요 — 방문객 일정에 확인 배지가 붙어요' + (h.closedDays.length ? ' · ' + closedDaysText(h.closedDays) : '') + (b.overnight ? ' (자정 넘어 영업으로 저장)' : ''));
});
$('nluBtn').addEventListener('click', async () => {
  const text = $('nluText').value.trim();
  if (text.length < 2) { flash('hoursMsg', '예) 11시부터 9시, 3~5시 쉬어요 처럼 적어 주세요', 'err'); return; }
  busy($('nluBtn'), true, '읽는 중…');
  const r = await api('/owner/hours/nlu', { text }, 20000);
  busy($('nluBtn'), false);
  if (!r.ok) { flash('hoursMsg', r.reason || '시간을 읽지 못했어요. 칸에 직접 넣어 주세요.', 'err'); return; }
  const w = (Array.isArray(r.windows) ? r.windows : []).map(x => ({ open: hhmm(x && x.open), close: hhmm(x && x.close) })).filter(x => x.open && x.close);
  if (!w.length && !r.closed_today) { flash('hoursMsg', '시간을 읽지 못했어요. 칸에 직접 넣어 주세요.', 'err'); return; }
  applyHours({ open: w[0] ? w[0].open : '', close: w.length ? w[w.length - 1].close : '', brkOn: w.length >= 2,
    brkStart: w.length >= 2 ? w[0].close : '', brkEnd: w.length >= 2 ? w[1].open : '', closedToday: !!r.closed_today });
  scheduleDraft();
  flash('hoursMsg', '시간 칸에 채웠어요 — 맞는지 보고 저장을 눌러 주세요', 'info');
});

/* (4)(5) 대표 메뉴 · 메뉴 목록 */
function readRep() { return { name: $('repName').value.trim(), price: digits($('repP1').value), price_2p: digits($('repP2').value) }; }
function readMenuRows() {
  return [...document.querySelectorAll('#menuRows .mrow')].map(r => ({
    name: r.querySelector('.mi-name').value.trim(), price: digits(r.querySelector('.mi-price').value),
    photo: r.querySelector('.mi-photo') ? r.querySelector('.mi-photo').value : '' })).filter(i => i.name || i.price);
}
function renderMenu(items) {
  $('menuRows').textContent = '';
  items.forEach(it => addMenuRow(it && it.name || '', it && it.price || '', it && it.photo || ''));
}
function syncRowPhotoSelect(row) {
  const menuPhotos = (S.store && S.store.photos || []).filter(p => p.kind === 'menu');
  const sel = row.querySelector('.mi-photo');
  const cur = sel.value || sel.dataset.want || '';
  sel.textContent = '';
  const none = el('option', '', '사진 없음'); none.value = ''; sel.appendChild(none);
  menuPhotos.forEach((p, i) => { const o = el('option', '', '메뉴판 ' + (i + 1)); o.value = String(p.id); sel.appendChild(o); });
  sel.value = menuPhotos.some(p => String(p.id) === cur) ? cur : '';
  row.classList.toggle('with-photo', menuPhotos.length > 0);
  sel.classList.toggle('hide', !menuPhotos.length);
}
function addMenuRow(name, price, photo) {
  const row = el('div', 'mrow');
  const a = el('input', 'mi-name'); a.type = 'text'; a.placeholder = '메뉴 이름'; a.value = name || ''; a.setAttribute('aria-label', '메뉴 이름');
  const b = el('input', 'mi-price'); b.type = 'tel'; b.inputMode = 'numeric'; b.placeholder = '가격'; b.value = digits(price); b.setAttribute('aria-label', '가격');
  const sel = el('select', 'mi-photo'); sel.dataset.want = photo ? String(photo) : ''; sel.setAttribute('aria-label', '메뉴 사진');
  const del = el('button', 'del', '이 줄 지우기'); del.type = 'button';
  del.addEventListener('click', () => { row.remove(); scheduleDraft(); });
  row.append(a, b, sel, del);
  $('menuRows').appendChild(row);
  syncRowPhotoSelect(row);
  return row;
}
$('addRow').addEventListener('click', () => { const r = addMenuRow('', '', ''); r.querySelector('.mi-name').focus(); });
$('saveMenu').addEventListener('click', async () => {
  flash('menuMsg', '');
  const items = readMenuRows().filter(i => i.name).map(i => { const o = { name: i.name, price: i.price }; if (i.photo) o.photo = i.photo; return o; });
  const rep = readRep();
  if (rep.name && !rep.price) { flash('menuMsg', '대표 메뉴의 1인 가격을 넣어 주세요', 'err'); return; }
  busy($('saveMenu'), true, '저장 중…');
  const r = await api('/owner/menu', { code: S.code, items, rep_menu: rep.name ? rep : null });
  busy($('saveMenu'), false);
  if (!r.ok) { flash('menuMsg', r.reason || '저장이 안 됐어요. 다시 눌러 주세요.', 'err'); return; }
  S.store.menu = items; S.store.rep_menu = rep.name ? rep : null;
  S.serverSnap.menu = readMenuRows(); S.serverSnap.rep_menu = rep; saveDraft();
  renderPreview();
  flash('menuMsg', '메뉴 ' + (Number(r.count) >= 0 ? r.count : items.length) + '개가 저장됐어요' + (rep.name ? ' (대표 메뉴 포함)' : ''));
});

/* (6) 사진 */
document.querySelectorAll('.kind button').forEach(b => b.addEventListener('click', () => {
  S.photoKind = b.dataset.kind;
  document.querySelectorAll('.kind button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
}));
$('photoBtn').addEventListener('click', () => $('photoFile').click());
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {} }
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
    im.src = url;
  });
}
async function shrinkImage(file) {                 // 긴 변 ≤1280, JPEG 0.85→0.6 단계로 ≤300KB
  const bmp = await loadBitmap(file);
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const sc = Math.min(1, 1280 / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * sc)); c.height = Math.max(1, Math.round(h0 * sc));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  let q = 0.85, blob = null;
  for (;;) {
    blob = await new Promise(res => c.toBlob(res, 'image/jpeg', q));
    if (!blob) throw new Error('canvas');
    if (blob.size <= 300 * 1024 || q <= 0.6) break;
    q = Math.max(0.6, +(q - 0.05).toFixed(2));
  }
  return blob;
}
const blobB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(new Error('read')); fr.readAsDataURL(blob); });
$('photoFile').addEventListener('change', async () => {
  const f = $('photoFile').files && $('photoFile').files[0];
  $('photoFile').value = '';
  if (!f) return;
  flash('photoMsg', '');
  if (!/^image\//.test(f.type)) { flash('photoMsg', '사진 파일만 올릴 수 있어요', 'err'); return; }
  const pv = $('photoPreview');
  let blob;
  try {
    blob = await shrinkImage(f);
    pv.src = URL.createObjectURL(blob); pv.classList.remove('hide');
  } catch { flash('photoMsg', '사진을 읽지 못했어요. 다른 사진으로 다시 해 보세요.', 'err'); return; }
  busy($('photoBtn'), true, '올리는 중…'); flash('photoMsg', '올리는 중… 잠시만요', 'info');
  let r;
  try { r = await api('/owner/photo', { code: S.code, kind: S.photoKind, image_b64: await blobB64(blob) }, 40000); }
  catch { r = { ok: false, reason: '사진을 준비하지 못했어요. 다시 해 보세요.' }; }
  busy($('photoBtn'), false);
  if (!r.ok) { flash('photoMsg', r.reason || '사진이 올라가지 않았어요. 다시 눌러 주세요.', 'err'); return; }
  pv.classList.add('hide'); if (pv.src) { URL.revokeObjectURL(pv.src); pv.removeAttribute('src'); }
  S.store.photos.push({ id: r.id, url: r.url, kind: S.photoKind });
  renderPhotos(); applyCaps(); renderPreview();
  flash('photoMsg', (S.photoKind === 'menu' ? '메뉴판 사진' : '가게 사진') + '이 올라갔어요' + (S.photoKind === 'menu' && S.caps.ocr ? ' — 아래에서 AI로 메뉴를 읽을 수 있어요' : ''));
});
function renderPhotos() {
  const box = $('thumbs'); box.textContent = '';
  (S.store.photos || []).forEach(p => {
    const t = el('div', 'thumb');
    const u = safePhotoUrl(p.url);
    if (u) { const im = el('img'); im.src = u; im.alt = p.kind === 'menu' ? '메뉴판 사진' : '가게 사진'; im.loading = 'lazy'; t.appendChild(im); }
    else t.appendChild(el('div', 'k', '(미리보기 불가)'));
    t.appendChild(el('div', 'k', p.kind === 'menu' ? '메뉴판' : '가게 사진'));
    const d = el('button', 'del', '지우기'); d.type = 'button';
    d.addEventListener('click', async () => {
      busy(d, true, '지우는 중…');
      const r = await api('/owner/photo/delete', { code: S.code, id: p.id });
      busy(d, false);
      if (!r.ok) { flash('photoMsg', r.reason || '사진을 지우지 못했어요. 다시 눌러 주세요.', 'err'); return; }
      S.store.photos = S.store.photos.filter(x => x.id !== p.id);
      renderPhotos(); applyCaps(); renderPreview(); flash('photoMsg', '사진을 지웠어요');
    });
    t.appendChild(d); box.appendChild(t);
  });
}

/* (7) AI 초안 — 저장 전까지 아무것도 반영되지 않는다 */
function confLabel(c) {
  if (typeof c === 'string') { const s = c.toLowerCase(); if (/high|hi|확실/.test(s)) return ['확실', 'hi']; if (/low|낮/.test(s)) return ['낮음', 'lo']; return ['보통', '']; }
  const n = Number(c); if (!isFinite(n)) return ['보통', ''];
  return n >= 0.8 ? ['확실', 'hi'] : n >= 0.5 ? ['보통', ''] : ['낮음', 'lo'];
}
$('ocrBtn').addEventListener('click', async () => {
  const menuPhotos = (S.store.photos || []).filter(p => p.kind === 'menu');
  if (!menuPhotos.length) { flash('ocrMsg', '먼저 메뉴판 사진을 올려 주세요', 'err'); return; }
  const pid = menuPhotos.length > 1 ? $('ocrPhoto').value : String(menuPhotos[menuPhotos.length - 1].id);
  const photo = menuPhotos.find(p => String(p.id) === pid) || menuPhotos[menuPhotos.length - 1];
  flash('ocrMsg', '읽는 중… 10초쯤 걸려요', 'info');
  busy($('ocrBtn'), true, '읽는 중…');
  const r = await api('/owner/menu/ocr', { code: S.code, photo_id: photo.id }, 45000);
  busy($('ocrBtn'), false);
  if (!r.ok) { flash('ocrMsg', r.reason || '메뉴를 읽지 못했어요 — 사진을 더 가까이 찍어 주세요', 'err'); return; }
  const items = Array.isArray(r.items) ? r.items.filter(i => i && (i.name || i.price)) : [];
  if (!items.length) { flash('ocrMsg', '메뉴를 읽지 못했어요 — 사진을 더 가까이 찍어 주세요', 'err'); return; }
  const box = $('ocrRows'); box.textContent = '';
  items.forEach(it => {
    const row = el('div', 'mrow with-photo');
    const a = el('input', 'mi-name'); a.type = 'text'; a.value = String(it.name || ''); a.placeholder = '메뉴 이름'; a.setAttribute('aria-label', '메뉴 이름');
    const b = el('input', 'mi-price'); b.type = 'tel'; b.inputMode = 'numeric'; b.value = digits(it.price); b.placeholder = '가격'; b.setAttribute('aria-label', '가격');
    const [lab, cls] = confLabel(it.confidence);
    const c = el('div', 'conf ' + cls, lab);
    const d = el('button', 'del', '이 줄 지우기'); d.type = 'button'; d.addEventListener('click', () => row.remove());
    row.append(a, b, c, d); box.appendChild(row);
  });
  $('ocrDraft').classList.remove('hide');
  flash('ocrMsg', items.length + '줄을 읽었어요' + (r.notes ? ' — ' + String(r.notes) : '') + '. 확인 후 넣기를 눌러 주세요', 'info');
});
$('ocrApply').addEventListener('click', () => {
  const rows = [...document.querySelectorAll('#ocrRows .mrow')].map(r => ({ name: r.querySelector('.mi-name').value.trim(), price: digits(r.querySelector('.mi-price').value) })).filter(i => i.name);
  if (!rows.length) { flash('ocrMsg', '넣을 줄이 없어요', 'err'); return; }
  // 비어 있는 자리표시 줄은 치우고 초안을 붙인다
  document.querySelectorAll('#menuRows .mrow').forEach(r => { if (!r.querySelector('.mi-name').value.trim() && !r.querySelector('.mi-price').value.trim()) r.remove(); });
  rows.forEach(i => addMenuRow(i.name, i.price, ''));
  $('ocrDraft').classList.add('hide'); $('ocrRows').textContent = '';
  flash('ocrMsg', '');
  scheduleDraft();
  flash('menuMsg', '초안 ' + rows.length + '줄을 메뉴 목록에 넣었어요 — 아직 저장 전이에요. 확인 후 메뉴 저장을 눌러 주세요', 'info');
  $('menuRows').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('ocrDrop').addEventListener('click', () => { $('ocrDraft').classList.add('hide'); $('ocrRows').textContent = ''; flash('ocrMsg', '초안을 버렸어요'); });

/* (8) 방문객 미리보기 */
function hoursText(st) {
  if (st.closed_today || isClosedToday(st.closed_on)) return '오늘 휴무';
  const w = (Array.isArray(st.windows) ? st.windows : []).map(x => ({ open: hhmm(x && x.open), close: hhmm(x && x.close) })).filter(x => x.open && x.close);
  if (w.length) return w.map(x => x.open + '~' + x.close).join(', ');
  const o = hhmm(st.open), c = hhmm(st.close);
  return o && c ? o + '~' + c : '';
}
function checkedBadge(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) { const m = /(\d{2})-(\d{2})/.exec(String(ts).slice(5)); return m ? '사장님이 ' + m[1] + '-' + m[2] + '에 직접 확인' : ''; }
  const p = n => String(n).padStart(2, '0');
  return '사장님이 ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '에 직접 확인';
}
function renderPreview() {
  const st = S.store; if (!st) return;
  $('pvName').textContent = st.name || '';
  const tags = $('pvTags'); tags.textContent = '';
  const cb = checkedBadge(st.checked_at);
  if (cb) tags.appendChild(el('span', 'badge', cb));
  if (st.seat_open) tags.appendChild(el('span', 'badge seat', '지금 자리 있어요'));
  if (!cb && !st.seat_open) tags.appendChild(el('span', 'ln', '영업시간을 저장하면 확인 배지가 붙어요'));
  const ht = hoursText(st);
  const cdt = closedDaysText(st.closed_days);
  $('pvHours').textContent = (ht || '영업시간 미확인') + (cdt ? ' · ' + cdt : '');
  const rep = st.rep_menu;
  let mt = '';
  if (rep && rep.name) mt = rep.name + (rep.price ? ' ' + won(rep.price) : '') + (rep.price_2p ? ' · 2인 ' + won(rep.price_2p) : '');
  else mt = (st.menu || []).filter(m => m && m.name).slice(0, 2).map(m => m.name + (m.price ? ' ' + won(m.price) : '')).join(' · ');
  $('pvMenu').textContent = mt;
  const img = $('pvImg');
  const first = (st.photos || []).map(p => safePhotoUrl(p.url)).find(Boolean);
  if (first) { img.src = first; img.classList.remove('hide'); } else { img.classList.add('hide'); img.removeAttribute('src'); }
}

/* (2b) 들어온 예약 — 방문객 일정의 예약(server/booking.py). 목록이 비면 카드를 숨긴다. 관리 토큰·파일럿 코드 둘 다 code로 */
async function loadReservations() {
  $('resvCard').classList.add('hide');
  if (!S.code) return;
  const r = await api('/owner/reservations?code=' + encodeURIComponent(S.code) + '&limit=20');
  const items = r.ok && Array.isArray(r.reservations) ? r.reservations.filter(x => x && x.status !== 'expired' && x.status !== 'cancelled') : [];
  if (!items.length || !S.store) return;
  const STATUS = { pending: '예약 대기(결제 전)', paid: '결제됨 · 테스트', confirmed: '예약됨' };
  const box = $('resvList'); box.textContent = '';
  items.forEach(x => {
    const d = el('div', 'resv');
    d.appendChild(el('div', 't', (x.date || '') + ' ' + (x.time || '') + ' · ' + (Number(x.party) || 1) + '명'));
    d.appendChild(el('div', 'o', [STATUS[x.status] || x.status, x.amount ? won(x.amount) : ''].filter(Boolean).join(' · ')));
    box.appendChild(d);
  });
  $('resvCard').classList.remove('hide');
}

/* (9) 지원사업 — 응답이 없거나 비어 있으면 카드 자체를 숨긴다 */
async function loadPrograms() {
  $('progCard').classList.add('hide');
  const r = await api('/owner/programs?category=' + encodeURIComponent(S.store.category || ''));
  const items = r.ok && Array.isArray(r.items) ? r.items.filter(i => i && i.title) : [];
  if (!items.length || !S.store) return;
  const box = $('progList'); box.textContent = '';
  items.slice(0, 5).forEach(i => {
    const u = safeLink(i.url);
    const a = el(u ? 'a' : 'div', 'prog');
    if (u) { a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.appendChild(el('div', 't', i.title));
    a.appendChild(el('div', 'o', [i.org, i.period, i.source].filter(Boolean).join(' · ')));
    box.appendChild(a);
  });
  $('progCard').classList.remove('hide');
}

/* (10) 로그아웃 — 인라인 확인 */
$('logout').addEventListener('click', () => { $('logoutConfirm').classList.remove('hide'); $('logoutConfirm').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('logoutNo').addEventListener('click', () => $('logoutConfirm').classList.add('hide'));
$('logoutYes').addEventListener('click', () => {
  clearOwner(); lsDel(DRAFT_KEY);
  clearInterval(S.timer); S.timer = null; S.code = null; S.store = null; S.serverSnap = null;
  $('gate6').classList.add('hide'); $('logoutConfirm').classList.add('hide');
  $('q').value = ''; $('hits').textContent = '';
  go('s1'); flash('s1Msg', '이 폰에서 로그아웃했어요. 입력한 가게 정보는 서버에 그대로 있어요.');
});

/* ═══ S6 만료 게이트 — reload 없음, DOM 유지 ═══ */
function startGate() {
  clearInterval(S.timer);
  const ttl = Number(qs.get('ttl'));
  S.gateAt = Date.now() + (ttl > 0 ? ttl * 1000 : S.expires_min * 60 * 1000);
  tickGate(); S.timer = setInterval(tickGate, 1000);
}
function tickGate() {
  const left = S.gateAt - Date.now();
  if (left <= 0) {
    clearInterval(S.timer); S.timer = null;
    $('timer').textContent = '잠겼어요 — 다시 열기를 눌러 주세요';
    $('gateMsg').style.display = 'none'; $('reauth').classList.add('hide');
    $('gate6').classList.remove('hide'); $('reopen').focus();
    return;
  }
  $('timer').textContent = (left < 60000 ? Math.ceil(left / 1000) + '초' : Math.ceil(left / 60000) + '분') + ' 뒤 잠깁니다(입력한 내용은 남아요)';
}
$('reopen').addEventListener('click', async () => {
  busy($('reopen'), true, '여는 중…');
  const r = await api('/owner/session', { code: S.code });
  busy($('reopen'), false);
  if (!r.ok || !r.store) {
    flash('gateMsg', r.reason || '다시 열지 못했어요.', 'err');
    if (!r.net) $('reauth').classList.remove('hide');
    return;
  }
  // 입력칸은 건드리지 않고 서버 쪽 값만 갱신한다
  S.store = Object.assign({}, S.store, { seat_open: r.store.seat_open, seat_left_min: r.store.seat_left_min,
    today_views: r.store.today_views, photos: Array.isArray(r.store.photos) ? r.store.photos : S.store.photos, checked_at: r.store.checked_at || S.store.checked_at });
  S.expires_min = Number(r.expires_min) > 0 ? Number(r.expires_min) : S.expires_min;
  renderHeader(); renderSeat(!!S.store.seat_open, S.store.seat_left_min); renderPhotos(); applyCaps(); renderPreview();
  $('gate6').classList.add('hide');
  startGate();
});
$('reauth').addEventListener('click', () => {
  clearOwner(); $('gate6').classList.add('hide'); S.code = null; S.store = null;
  go('s1'); flash('s1Msg', '관리 번호가 더 이상 유효하지 않아요. 다시 인증해 주세요', 'err');
});

/* ═══ 초안 자동 저장(500ms) — 사업자번호·성함·전화는 절대 포함하지 않는다 ═══ */
function formSnapshot() { return { hours: readHours(), menu: readMenuRows(), rep_menu: readRep() }; }
function scheduleDraft() { clearTimeout(S.draftTimer); S.draftTimer = setTimeout(saveDraft, 500); }
function saveDraft() {
  if (!S.store || !S.serverSnap) return;
  const snap = formSnapshot();
  if (JSON.stringify(snap) === JSON.stringify(S.serverSnap)) { lsDel(DRAFT_KEY); return; }
  lsSet(DRAFT_KEY, JSON.stringify({ store_id: S.store.id, hours: snap.hours, menu: snap.menu, rep_menu: snap.rep_menu, ts: Date.now() }));
}
function applySnapshot(d) {
  if (d.hours) applyHours(d.hours);
  if (Array.isArray(d.menu)) renderMenu(d.menu.length ? d.menu : [{}, {}]);
  if (d.rep_menu) { $('repName').value = d.rep_menu.name || ''; $('repP1').value = digits(d.rep_menu.price); $('repP2').value = digits(d.rep_menu.price_2p); }
}
function checkDraft() {
  const banner = $('draftBanner'); banner.classList.add('hide');
  const d = lsJSON(DRAFT_KEY);
  if (!d || typeof d !== 'object') return;
  if (String(d.store_id) !== String(S.store.id)) { lsDel(DRAFT_KEY); return; }
  const cur = { hours: d.hours, menu: Array.isArray(d.menu) ? d.menu : [], rep_menu: d.rep_menu };
  if (JSON.stringify(cur) === JSON.stringify(S.serverSnap)) { lsDel(DRAFT_KEY); return; }
  banner.classList.remove('hide');
}
$('draftLoad').addEventListener('click', () => {
  const d = lsJSON(DRAFT_KEY);
  if (d) applySnapshot(d);
  $('draftBanner').classList.add('hide');
  flash('hoursMsg', '지난번 입력을 불러왔어요 — 저장을 눌러야 방문객에게 반영돼요', 'info');
  saveDraft();
});
$('draftDrop').addEventListener('click', () => { lsDel(DRAFT_KEY); $('draftBanner').classList.add('hide'); });
$('s5').addEventListener('input', e => { if (e.target.closest('#ocrRows')) return; scheduleDraft(); });
$('s5').addEventListener('change', e => { if (e.target.closest('#ocrRows') || e.target.id === 'photoFile') return; scheduleDraft(); });

/* ═══ 시작 ═══ */
boot();
