// 광주잇다 — 지도+글래스 시트 구조. 계산은 engine.js(폰 안), 서버는 실시간 정보만.
'use strict';
const qs = new URLSearchParams(location.search);
const SERVER = qs.get('server') || 'http://localhost:8000';
const $ = id => document.getElementById(id);
const stage = $('stage'), sheet = $('sheet');

/* ═══ 상태 ═══ */
const state = {
  dl: null,            // {label, deadline:'HH:MM', ret?:presetKey}
  og: null,            // preset key
  cp: '',              // '' | senior | child
  extraPrefs: [],      // ['indoor'] | ['late']
  appliedEvent: null, dismissedEvent: null,
  prevItinerary: null, last: null, mergedById: null,
};

/* ═══ 시간 유틸 (시연: ?now=14:00 고정 지원) ═══ */
function nowDate(offsetMin = 0) {
  const q = qs.get('now');
  const base = q ? new Date('2026-01-01T' + q + ':00') : new Date();
  return new Date(base.getTime() + offsetMin * 60000);
}
const hm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
function fmt12(hhmm) {                       // "14:07" → "2:07"
  let [h, m] = hhmm.split(':').map(Number);
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0');
}
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/* ═══ 칩 + 픽커 ═══ */
const DL_OPTS = [
  { label: '2시간', rel: 120 }, { label: '3시간', rel: 180 },
  { label: '6:20 기차', deadline: '18:20', ret: 'songjeong' },
  { label: '저녁 9시', deadline: '21:00' }, { label: '다른 시간', grid: true },
];
const OG_OPTS = [
  { key: 'acc', label: '문화전당' }, { key: 'chungjang', label: '충장로' },
  { key: 'champions', label: '챔피언스필드' }, { key: 'songjeong', label: '광주송정역' },
];
const CP_OPTS = [
  { key: '', label: '혼자·성인' },
  { key: 'senior', label: '천천히 (어르신·거동 불편)' },
  { key: 'child', label: '아이와' },
];

function chipText() {
  setChip('chipDl', state.dl && state.dl.label, '마감');
  // 권역 카드는 픽커 목록 밖의 프리셋(동명동·양림동)도 넣는다 — PRESETS 이름으로 폴백
  setChip('chipOg', state.og && ((OG_OPTS.find(o => o.key === state.og) || {}).label
    || (PRESETS[state.og] && PRESETS[state.og].name)), '출발');
  setChip('chipCp', state.cp !== null && CP_OPTS.find(o => o.key === state.cp) && state.cp !== ''
    ? CP_OPTS.find(o => o.key === state.cp).label.split(' ')[0] : (state.cp === '' ? '혼자' : '동행'), '동행');
}
function setChip(id, text, fallback) {
  const el = $(id);
  el.innerHTML = (text || fallback) + ' <svg><use href="#i-chev"/></svg>';
  el.classList.toggle('set', !!text || (id === 'chipCp'));
  el.setAttribute('aria-pressed', String(!!text));
}

function openPicker(title, opts, onPick) {
  $('pickerTitle').textContent = title;
  const box = $('pickerOpts');
  box.innerHTML = '';
  opts.forEach(o => {
    const b = document.createElement('button');
    b.className = 'opt' + (o.on ? ' on' : '');
    b.textContent = o.label;
    b.addEventListener('click', () => { closePicker(); onPick(o); });
    box.appendChild(b);
  });
  $('picker').classList.add('open');
}
function closePicker(){ $('picker').classList.remove('open'); }
$('pickerScrim').addEventListener('click', closePicker);

$('chipDl').addEventListener('click', () => openPicker('언제까지?',
  DL_OPTS.map(o => ({ ...o, on: state.dl && state.dl.label === o.label })), o => {
    if (o.grid) { openTimeGrid(); return; }
    state.dl = { label: o.label, deadline: o.deadline || hm(nowDate(o.rel)), ret: o.ret };
    afterCondChange();
  }));
function openTimeGrid() {
  const opts = [];
  const start = nowDate(60); start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
  for (let i = 0; i < 8; i++) {
    const d = new Date(start.getTime() + i * 30 * 60000);
    if (d.getHours() >= 23) break;
    const t = hm(d);
    opts.push({ label: '오후 ' + fmt12(t), deadline: t });
  }
  openPicker('몇 시까지?', opts, o => {
    state.dl = { label: o.label, deadline: o.deadline };
    afterCondChange();
  });
}
$('chipOg').addEventListener('click', () => openPicker('어디서 출발?',
  OG_OPTS.map(o => ({ ...o, on: state.og === o.key })), o => { state.og = o.key; afterCondChange(); }));
$('chipCp').addEventListener('click', () => openPicker('함께 가는 분?',
  CP_OPTS.map(o => ({ ...o, on: state.cp === o.key })), o => { state.cp = o.key; afterCondChange(); }));

function afterCondChange() {
  chipText();
  state.extraPrefs = []; state.appliedEvent = null;   // 조건이 바뀌면 이벤트 반영도 초기화(상태 오염 방지)
  if (stage.classList.contains('state-result')) run(); // 결과 보던 중이면 자동 재계산
}

/* ═══ 서버(있으면) ═══ */
async function serverGet(path, ms = 1200) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(SERVER + path, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* ═══ 계산 ═══ */
$('go').addEventListener('click', () => {
  if (!state.dl || !state.og) {          // alert 금지 — 빈 칩이 스스로 알려준다
    if (!state.dl) nudge('chipDl');
    if (!state.og) nudge('chipOg');
    return;
  }
  startCompute();
});
function nudge(id){ const el = $(id); el.classList.remove('miss'); void el.offsetWidth; el.classList.add('miss'); }

function startCompute() {
  bumpPlans();
  setState('compute'); springTo('half');
  $('log1').textContent = '영업시간 확인';
  $('log2').textContent = '이동시간 검증' + (state.dl.ret ? ' · 송정역 복귀 기준' : '');
  $('log3').textContent = '순서 조합';
  const items = [...document.querySelectorAll('#log li')];
  items.forEach(li => li.className = '');
  let i = 0;
  (function step(){
    if (i > 0) items[i - 1].className = 'done';
    if (i === items.length) { run(); return; }
    items[i].className = 'on'; i++;
    setTimeout(step, 650);
  })();
}

async function run() {
  const live = await serverGet('/live');
  let cands = CANDIDATES;
  if (live && live.new_stores && live.new_stores.length) {
    // 자가 온보딩으로 22곳 밖에서 등록된 가게 — 실제 후보 목록에 합류
    const have = new Set(cands.map(c => c.id));
    cands = cands.concat(live.new_stores.filter(s => !have.has(s.id)));
  }
  if (live && live.updates)               // 사장님 입력: 미확인 가게가 후보로 (차별점 ①)
    cands = cands.map(c => live.updates[c.id] ? Object.assign({}, c, live.updates[c.id]) : c);
  if (live && live.open_now && live.open_now.length) {
    const set = new Set(live.open_now);
    cands = cands.map(c => set.has(c.id) ? Object.assign({}, c, { seat_open: true }) : c);
  }
  state.filteredOut = 0;
  if (state.extraPrefs.includes('indoor')) {
    const before = cands.length;
    cands = cands.filter(c => c.indoor !== false);
    state.filteredOut = before - cands.length;         // 영수증에 그대로 적는다
  }
  const nowMin = state.extraPrefs.includes('late') ? 15 : 0;

  const out = Engine.plan({
    now: hm(nowDate(nowMin)), deadline: state.dl.deadline,
    origin: PRESETS[state.og],
    return_to: state.dl.ret ? PRESETS[state.dl.ret] : undefined,
    companion: state.cp || null,
    candidates: cands, zone_table: ZONE_TABLE,
  });
  state.mergedById = Object.fromEntries(cands.map(c => [c.id, c]));
  state.prevItinerary = state.last ? state.last.itinerary : null;
  state.last = out;
  render(out, live && live.event);
}

/* ═══ 렌더 ═══ */
let countTimer = null;
function render(out, event) {
  setState('result');
  history.pushState({ v: 'result' }, '');              // 안드로이드 뒤로가기 = 처음으로

  // 마감 캡슐 — 카운트다운
  clearInterval(countTimer);
  const tick = () => {
    const left = toMin(state.dl.deadline) - toMin(hm(nowDate(state.extraPrefs.includes('late') ? 15 : 0)));
    $('count').textContent = left > 0
      ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' 남음' : '마감';
  };
  tick(); countTimer = setInterval(tick, 30000);
  $('deadNote').textContent = state.dl.label + (state.dl.ret ? ' · 송정역 도착 기준' : '')
    + (state.appliedEvent === 'bus_delay' ? ' · 지연 반영' : '')
    + (state.appliedEvent === 'rain' ? ' · 실내 위주' : '');

  const its = out.itinerary;
  // 지금 하실 일
  if (its.length) {
    const f = its[0];
    $('nowline').innerHTML = '지금: <b>' + f.name + (f.travel_mode === 'bus' ? '까지 버스 ' : '까지 걸어서 ')
      + f.travel_min + '분</b> · ' + fmt12(f.arrive) + ' 도착';
    $('nowline').hidden = false;
  } else $('nowline').hidden = true;

  // 잇는 실 타임라인
  const tl = $('thread'); tl.innerHTML = '';
  its.forEach((c, i) => {
    if (i > 0) {
      const mv = document.createElement('li');
      mv.innerHTML = '<span class="move"><svg><use href="#i-' + (c.travel_mode === 'bus' ? 'bus' : 'walk')
        + '"/></svg>' + (c.travel_mode === 'bus' ? '버스 약 ' : '걸어서 ') + c.travel_min + '분'
        + (state.cp === 'senior' ? ' · 천천히 기준' : '') + '</span>';
      tl.appendChild(mv);
    }
    const li = document.createElement('li');
    const tags = [];
    if (c.barrier_free) tags.push('<span class="tag">무장애</span>');
    const m = state.mergedById[c.id] || {};
    if (m.seat_open) tags.push('<span class="tag seat">지금 자리 있어요</span>');
    if (c.trust === 'owner') tags.push('<span class="tag owner">사장님 확인' + dateTag(c.checked_at) + '</span>');
    else if (c.trust === 'field') tags.push('<span class="tag">' + dateTag(c.checked_at, '현장 확인') + '</span>');
    else if (c.trust === 'api') tags.push('<span class="tag">공공정보 확인</span>');
    li.innerHTML = '<span class="node">' + (i + 1) + '</span>'
      + '<div class="stop"><div class="t"><span class="name">' + c.name + '</span>'
      + '<span class="time">' + fmt12(c.arrive) + '~' + fmt12(c.depart) + '</span></div>'
      + '<div class="tags">' + tags.join('') + '</div></div>';
    tl.appendChild(li);
  });
  $('emptyMsg').hidden = its.length > 0;
  if (!its.length) $('emptyMsg').textContent = '조건에 맞는 곳을 찾지 못했어요. 아래 영수증에서 이유를 보세요.';

  // 검증 영수증
  const d = out.receipt.dropped;
  const excluded = d.closed + d.unreachable + d.time_over;
  $('rNums').textContent = '확인 ' + out.receipt.checked + ' · 통과 ' + out.receipt.passed + ' · 제외 ' + excluded;
  $('rDetail').innerHTML =
    '영업시간 밖 ' + d.closed + ' · 이동 불가 ' + d.unreachable + ' · 시간 부족 ' + d.time_over
    + (state.filteredOut ? '<br>비 예보로 실외 <b>' + state.filteredOut + '곳</b>을 먼저 제외했어요' : '')
    + (out.relax_suggestions.length ? '<br><span class="relax">' + out.relax_suggestions.join(' · ') + '</span>' : '');

  renderMaybe(out.maybe);
  drawRoute(its);
  renderEvent(event);
  pollLive();
  renderStats();
  loadWhy(out);
}

/* LLM 출구 — 계산 '결과'를 근거로 이유 한 줄. 서버가 사실 검사 통과시킨 문장만 표시 */
async function loadWhy(out) {
  const el = $('aiWhy');
  el.hidden = true;
  if (!out.itinerary.length) return;
  const snapshot = state.last;
  const d = await serverPost('/explain', {
    stops: out.itinerary.map(c => ({ name: c.name, arrive: c.arrive, depart: c.depart,
      travel_min: c.travel_min, travel_mode: c.travel_mode })),
    deadline: state.dl.deadline, companion: state.cp || null, ret: !!state.dl.ret,
  }, 9000);
  // 응답이 늦게 와도 그 사이 재계산됐으면 버린다(스테일 문장 금지)
  if (d && d.ok && state.last === snapshot && stage.classList.contains('state-result')) {
    el.innerHTML = '<b>AI</b> ' + esc(d.reason);
    el.hidden = false;
  }
}
function dateTag(iso, prefix) {
  // owner: '사장님 확인 8/31' / field: '현장 확인 8/26' — 날짜 없으면 라벨만
  if (!iso) return prefix || '';
  const [, m, dd] = iso.split('-');
  const d = Number(m) + '/' + Number(dd);
  return prefix ? prefix + ' ' + d : ' ' + d;
}

function renderMaybe(ids) {
  const box = $('maybeList'); box.innerHTML = '';
  ids.forEach(id => {
    const c = (state.mergedById && state.mergedById[id]) || CANDIDATES.find(x => x.id === id);
    if (!c) return;
    const div = document.createElement('div');
    div.className = 'mcard';
    div.innerHTML = '<div><div class="nm">' + c.name + '</div><div class="ct">' + (c.category || '') + '</div></div>'
      + (c.phone ? '<a class="call" href="tel:' + c.phone.replace(/-/g, '') + '"><svg><use href="#i-phone"/></svg>전화</a>' : '');
    box.appendChild(div);
  });
  if (!ids.length) box.innerHTML = '<div class="empty">지금은 전부 확인된 곳이에요.</div>';
}

/* ═══ 조건 다시 / 뒤로가기 ═══ */
function showStart() {
  setState('start'); springTo('peek');
  clearInterval(countTimer);
  state.extraPrefs = []; state.appliedEvent = null; state.dismissedEvent = null;
  $('event').classList.remove('show', 'applied');
  if (window.__routeShow) window.__routeShow(false);
}
$('again').addEventListener('click', () => { history.back(); });
window.addEventListener('popstate', () => {
  if (stage.classList.contains('state-result')) showStart();
});
function setState(s){ stage.classList.remove('state-start','state-compute','state-result'); stage.classList.add('state-' + s); }

/* ═══ 탭 (홈이 시작 — 일정은 plan 탭에서만) ═══ */
function switchTab(name) {
  document.querySelectorAll('.tabbar button').forEach(x => {
    const on = x.dataset.tab === name;
    x.classList.toggle('on', on);
    if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
  });
  stage.dataset.tab = name;
  if (name === 'home') loadHome();          // 자리 있어요 블록 최신화
}
document.querySelectorAll('.tabbar button').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('optSenior').addEventListener('change', e => document.documentElement.classList.toggle('senior', e.target.checked));

/* ═══ 이벤트 카드 (제안 → 승인 → diff → 되돌리기) ═══ */
const ev = $('event');
function renderEvent(event) {
  if (!event || !event.active) { if (!ev.classList.contains('applied')) ev.classList.remove('show'); return; }
  if (state.dismissedEvent === event.type || state.appliedEvent === event.type) return;
  ev.classList.remove('applied');
  ev.dataset.type = event.type;
  $('evText').textContent = event.type === 'rain'
    ? '비 예보가 잡혔어요. 실내 위주로 다시 짤까요?' : '버스가 15분 늦고 있어요';
  $('evNo').textContent = '그대로';
  ev.classList.add('show');
}
$('evYes').addEventListener('click', async () => {
  const type = ev.dataset.type;
  state.extraPrefs = type === 'rain' ? ['indoor'] : ['late'];
  state.appliedEvent = type; state.dismissedEvent = null;
  await run();
  ev.classList.add('show', 'applied');
  $('evText').textContent = type === 'rain' ? '실내 위주로 다시 짰어요' : '지연을 반영해 다시 짰어요';
  $('evDiff').textContent = '바뀐 점: ' + diffLine(state.prevItinerary, state.last.itinerary, type);
  $('evNo').textContent = '되돌리기';
  setTimeout(() => { if (ev.classList.contains('applied')) ev.classList.remove('show'); }, 6000);
});
$('evNo').addEventListener('click', async () => {
  if (ev.classList.contains('applied')) {              // 되돌리기
    state.extraPrefs = []; state.appliedEvent = null;
    state.dismissedEvent = ev.dataset.type;
    ev.classList.remove('show', 'applied');
    await run();
  } else {
    state.dismissedEvent = ev.dataset.type;            // 다시 안 뜬다 (좀비 차단)
    ev.classList.remove('show');
  }
});
function diffLine(prev, cur, type) {
  if (!prev || !prev.length) return type === 'rain' ? '실외 후보를 뺐어요' : '시간을 늦춰 다시 검증했어요';
  const pIds = prev.map(x => x.id).join(), cIds = cur.map(x => x.id).join();
  if (pIds === cIds) {
    const shift = toMin(cur[0].arrive) - toMin(prev[0].arrive);
    return '순서는 그대로, 시간이 ' + shift + '분씩 뒤로';
  }
  const removed = prev.filter(p => !cur.some(c => c.id === p.id)).map(x => x.name);
  const added = cur.filter(c => !prev.some(p => p.id === c.id)).map(x => x.name);
  if (removed.length || added.length)
    return (removed.length ? removed[0] + ' 대신 ' : '') + (added.length ? added[0] + '이(가) 들어갔어요' : '일부가 빠졌어요');
  return '순서를 다시 짰어요';
}
let liveTimer = null;
function pollLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(async () => {
    const live = await serverGet('/live');
    if (live && stage.classList.contains('state-result')) renderEvent(live.event);
  }, 5000);
}

/* ═══ 음성 입력 — 듣기 → 에코 확인 → 반영 ═══ */
const vs = $('vsheet');
function parseSpeech(text) {
  const got = { cond: [] };
  const mH = text.match(/(\d{1,2})\s*시간/);
  if (mH) { got.dl = { label: mH[1] + '시간', deadline: hm(nowDate(Number(mH[1]) * 60)) }; got.cond.push(mH[1] + '시간'); }
  if (/기차|케이티엑스|KTX|열차/i.test(text)) { got.dl = DL_OPTS[2] && { label: '6:20 기차', deadline: '18:20', ret: 'songjeong' }; got.cond.push('6:20 기차'); }
  const mT = text.match(/(저녁|오후)?\s*(\d{1,2})\s*시(?!간)/);
  if (mT && !got.dl) {
    let h = Number(mT[2]); if ((mT[1] || h <= 9) && h < 12) h += 12;
    got.dl = { label: '오후 ' + fmt12(h + ':00') , deadline: String(h).padStart(2, '0') + ':00' };
    got.cond.push(got.dl.label + '까지');
  }
  for (const [re, key, label] of [
    [/문화전당|국립아시아/, 'acc', '문화전당'], [/충장로/, 'chungjang', '충장로'],
    [/야구장|챔피언스/, 'champions', '챔피언스필드'], [/송정/, 'songjeong', '광주송정역'],
  ]) if (re.test(text)) { got.og = key; got.cond.push(label + ' 출발'); break; }
  if (/어르신|부모님|할머니|할아버지|천천히/.test(text)) { got.cp = 'senior'; got.cond.push('천천히'); }
  else if (/아이|애기|아기/.test(text)) { got.cp = 'child'; got.cond.push('아이와'); }
  if (/실내|비\s?오/.test(text)) { got.indoor = true; got.cond.push('실내 위주'); }
  return got;
}
/* LLM 입구 — 서버 /nlu(Claude, 키는 서버에만)가 우선, 실패·미구성이면 기존 정규식 폴백 */
async function parseWithAI(text) {
  const d = await serverPost('/nlu', { text }, 8000);
  if (!d || !d.ok) return null;
  const got = { cond: [], ai: true };
  if (d.train) {
    got.dl = { label: '6:20 기차', deadline: '18:20', ret: 'songjeong' };
    got.cond.push('6:20 기차');
  } else if (d.rel_minutes) {
    const lbl = d.rel_minutes % 60 === 0 ? (d.rel_minutes / 60) + '시간' : d.rel_minutes + '분';
    got.dl = { label: lbl, deadline: hm(nowDate(d.rel_minutes)) };
    got.cond.push(lbl);
  } else if (d.deadline) {
    got.dl = { label: '오후 ' + fmt12(d.deadline), deadline: d.deadline };
    got.cond.push(got.dl.label + '까지');
  }
  if (d.origin && PRESETS[d.origin]) {
    got.og = d.origin;
    got.cond.push(PRESETS[d.origin].name + ' 출발');
  }
  if (d.companion === 'senior') { got.cp = 'senior'; got.cond.push('천천히'); }
  else if (d.companion === 'child') { got.cp = 'child'; got.cond.push('아이와'); }
  if (d.indoor) { got.indoor = true; got.cond.push('실내 위주'); }
  return got.cond.length ? got : null;    // AI가 아무것도 못 뽑으면 정규식에게 기회
}

let vParsedResult = null;
async function showEcho(text) {
  $('vHeard').textContent = '“' + text + '”';
  $('vParsed').textContent = '알아듣는 중…';
  $('vInput').hidden = true;
  vs.classList.add('show');
  const got = (await parseWithAI(text)) || parseSpeech(text);
  vParsedResult = got;
  const missing = [];
  if (!got.dl && !state.dl) missing.push('마감');
  if (!got.og && !state.og) missing.push('출발지');
  $('vParsed').innerHTML = got.cond.length
    ? (got.ai ? 'AI 반영: ' : '반영: ') + '<b>' + got.cond.join(' · ') + '</b>'
      + (missing.length ? '<br>' + missing.join('·') + '은 못 들었어요 — 칩으로 골라 주세요' : '')
    : '조건을 못 알아들었어요. 칩으로 골라 주세요.';
}
$('voice').addEventListener('click', async () => {
  try {
    const S = Capacitor.Plugins.SpeechRecognition;
    await S.requestPermissions();
    const res = await S.start({ language: 'ko-KR', maxResults: 1, partialResults: false, popup: true });
    showEcho((res.matches && res.matches[0]) || '');
  } catch {
    // 폴백: 시트 안 텍스트 입력 (prompt 금지)
    $('vHeard').textContent = '말로 입력이 어려운 환경이에요';
    $('vParsed').textContent = '아래에 적어 주세요';
    $('vInput').hidden = false; $('vInput').value = '';
    vParsedResult = null;
    vs.classList.add('show');
    setTimeout(() => $('vInput').focus(), 350);
  }
});
$('vApply').addEventListener('click', async () => {
  if (!vParsedResult && !$('vInput').hidden) {
    const t = $('vInput').value || '';
    vParsedResult = (await parseWithAI(t)) || parseSpeech(t);
  }
  const g = vParsedResult || {};
  if (g.dl) state.dl = g.dl;
  if (g.og) state.og = g.og;
  if (g.cp !== undefined) state.cp = g.cp;
  if (g.indoor) state.extraPrefs = ['indoor'];
  chipText(); vs.classList.remove('show');
  if (state.dl && state.og) startCompute();
});
$('vRetry').addEventListener('click', () => { vs.classList.remove('show'); $('voice').click(); });

/* ═══ 시트 스프링 (Fluid Interfaces — 속도 이어받기·투영·러버밴드·중단) ═══ */
let snapState = 'peek';
function currentSnap(){ return snapState; }
const sheetH = () => sheet.getBoundingClientRect().height;
const snapY = { peek: () => sheetH() - 156, half: () => sheetH() * .50, full: () => sheetH() * .07 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let curY = null, springRaf = null;
function setY(y){ curY = y; sheet.style.transform = `translateY(${y}px)`; }
function stopSpring(){ if (springRaf) cancelAnimationFrame(springRaf); springRaf = null; }
function settle(name){
  snapState = name; stopSpring(); curY = null;
  sheet.classList.remove('drag','half','full');
  if (name !== 'peek') sheet.classList.add(name);
  sheet.style.transform = '';
}
function springTo(name, v = 0){
  if (reduceMotion){ settle(name); return; }
  const target = snapY[name]();
  let y = curY ?? (sheet.getBoundingClientRect().top - sheet.parentElement.getBoundingClientRect().top);
  sheet.classList.add('drag');
  const flick = Math.abs(v) > 350;
  const response = flick ? .3 : .35, zeta = flick ? .8 : 1;
  const w0 = 2 * Math.PI / response;
  let vel = v, last = performance.now();
  stopSpring();
  (function step(now){
    const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
    vel += (-w0 * w0 * (y - target) - 2 * zeta * w0 * vel) * dt;
    y += vel * dt;
    if (Math.abs(y - target) < .5 && Math.abs(vel) < 20){ settle(name); return; }
    setY(y); springRaf = requestAnimationFrame(step);
  })(last);
}
function project(v, d = 0.998){ return (v / 1000) * d / (1 - d); }
function rubberband(over, dim, c = 0.55){ return (over * dim * c) / (dim + c * Math.abs(over)); }

let dragStartY = 0, grabOffset = 0, dragging = false, dragMoved = false;
const hist = [];
sheet.addEventListener('pointerdown', e => {
  if (e.target.closest('button, details, a, input, label') && !e.target.closest('.grip')) return;
  if (e.target.closest('.sheet-body') && snapState === 'full') return;
  stopSpring();
  dragging = true; dragStartY = e.clientY;
  grabOffset = sheet.getBoundingClientRect().top - sheet.parentElement.getBoundingClientRect().top;
  hist.length = 0; hist.push({ t: performance.now(), y: e.clientY });
  sheet.classList.add('drag');
  try { sheet.setPointerCapture(e.pointerId); } catch {}
});
sheet.addEventListener('pointermove', e => {
  if (!dragging) return;
  const dy = e.clientY - dragStartY;
  if (Math.abs(dy) > 10) dragMoved = true;
  hist.push({ t: performance.now(), y: e.clientY });
  while (hist.length > 2 && hist[hist.length - 1].t - hist[0].t > 100) hist.shift();
  let y = grabOffset + dy;
  const top = snapY.full(), bottom = snapY.peek();
  if (y < top) y = top + rubberband(y - top, sheetH());
  if (y > bottom) y = bottom + rubberband(y - bottom, sheetH());
  setY(y);
});
sheet.addEventListener('pointerup', () => {
  if (!dragging) return; dragging = false;
  const a = hist[0], b = hist[hist.length - 1];
  const v = (b && a && b.t > a.t) ? (b.y - a.y) / (b.t - a.t) * 1000 : 0;
  const projected = (curY ?? grabOffset) + project(v);
  let best = 'peek', dist = Infinity;
  for (const name of ['peek', 'half', 'full']) {
    const d = Math.abs(snapY[name]() - projected);
    if (d < dist){ dist = d; best = name; }
  }
  springTo(best, v);
});
$('grip').addEventListener('click', () => {
  if (dragMoved) { dragMoved = false; return; }
  const order = ['peek', 'half', 'full'];
  springTo(order[(order.indexOf(snapState) + 1) % 3]);
});

/* ═══ 카카오맵 — 등록 도메인에서 로드, 결과 상태에서만 경로 표시 ═══ */
(function realMap(){
  // 어떤 도메인에서든 시도 — 카카오 콘솔에 미등록이면 조용히 폴백 유지
  const s = document.createElement('script');
  s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=5d0d9983f1b3ab89c85e0061f12d3e3d&autoload=false';
  s.onload = () => kakao.maps.load(() => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0';
    $('map').prepend(el);
    const map = new kakao.maps.Map(el, {
      center: new kakao.maps.LatLng(35.151, 126.917), level: 6 });
    document.querySelector('#map .fallback').style.display = 'none';
    let overlays = [], line = null;
    window.__routeShow = (on, its) => {
      overlays.forEach(o => o.setMap(null)); overlays = [];
      if (line) { line.setMap(null); line = null; }
      if (!on || !its || !its.length) return;
      const cs = getComputedStyle(document.documentElement);
      const accHex = cs.getPropertyValue('--acc').trim(), paperHex = cs.getPropertyValue('--paper').trim();
      const pts = its.map(c => new kakao.maps.LatLng(c.lat, c.lon));
      line = new kakao.maps.Polyline({ map, path: pts, strokeWeight: 4,
        strokeColor: accHex, strokeOpacity: .85, strokeStyle: 'shortdash' });
      its.forEach((c, i) => {
        const o = new kakao.maps.CustomOverlay({ map, position: pts[i], yAnchor: .5,
          content: `<div style="width:30px;height:30px;border-radius:50%;background:${accHex};
            color:#fff;font:700 14px/30px 'IBM Plex Sans KR';text-align:center;
            box-shadow:0 0 0 3px ${paperHex},0 3px 8px rgba(0,0,0,.3)">${i + 1}</div>` });
        overlays.push(o);
      });
      const bounds = new kakao.maps.LatLngBounds();
      pts.forEach(p => bounds.extend(p));
      map.setBounds(bounds, 40, 40, Math.round(innerHeight * .45), 40);
    };
  });
  s.onerror = () => {};
  document.head.appendChild(s);
})();
function drawRoute(its){ if (window.__routeShow) window.__routeShow(true, its); }

/* ═══ 공용: 이스케이프 + POST ═══ */
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
async function serverPost(path, body, ms = 9000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(SERVER + path, { method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* ═══ 홈 — 빠른 시작 · 자리 있어요 · 권역 ═══ */
document.querySelectorAll('#qStart button').forEach(b => b.addEventListener('click', () => {
  const o = DL_OPTS.find(x => x.label === b.dataset.dl);
  state.dl = { label: o.label, deadline: o.deadline || hm(nowDate(o.rel)), ret: o.ret };
  chipText(); switchTab('plan');
  if (state.og) startCompute();
  else openPicker('어디서 출발?', OG_OPTS.map(x => ({ ...x })),
    x => { state.og = x.key; chipText(); startCompute(); });
}));

function liveStores(live) {
  const m = Object.fromEntries(CANDIDATES.map(c => [c.id, c]));
  if (live && live.new_stores) live.new_stores.forEach(s => { if (!m[s.id]) m[s.id] = s; });
  return m;
}
async function loadHome() {
  const live = await serverGet('/live');
  const all = liveStores(live);
  const open = ((live && live.open_now) || []).map(id => all[id]).filter(Boolean);
  const box = $('seatCards'); box.innerHTML = '';
  open.forEach(c => {
    const b = document.createElement('button');
    b.className = 'hcard';
    b.innerHTML = '<div class="nm">' + esc(c.name) + '</div><div class="ct">'
      + esc(c.category || '') + ' · 지금 자리 있어요</div>';
    b.addEventListener('click', () => switchTab('plan'));
    box.appendChild(b);
  });
  $('seatBlock').hidden = !open.length;
}

/* ═══ 내 주변에서 시작 — 좌표는 이 폰 안에서만(서버 미전송, KISA 면제 유지) ═══ */
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function readPosition() {
  const G = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Geolocation;
  if (G) {                                  // 앱: Capacitor 플러그인(런타임 권한 포함)
    const p = await G.getCurrentPosition({ enableHighAccuracy: false, timeout: 9000 });
    return { lat: p.coords.latitude, lon: p.coords.longitude };
  }
  return new Promise((res, rej) =>          // 웹 폴백
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      rej, { timeout: 9000 }));
}
$('btnNearby').addEventListener('click', async () => {
  const btn = $('btnNearby');
  btn.classList.add('busy');
  try {
    const pos = await readPosition();
    // 권역 중심과의 거리 — 1.2km 안이면 그 권역 소속으로 정확 계산, 밖이면 추측하지 않는다
    let best = null, bestD = Infinity;
    for (const z of ZONES) {
      const d = distM(pos, PRESETS[z.og]);
      if (d < bestD) { bestD = d; best = z; }
    }
    if (bestD > 1200) {
      alertNearby('지금 위치가 서비스 권역(충장로·동명동·양림동) 밖이에요 — 출발지를 골라 주세요');
      switchTab('plan');
      $('chipOg').click();
      return;
    }
    PRESETS.gps = { name: '내 주변 (' + best.name + ')', lat: pos.lat, lon: pos.lon,
                    zone: PRESETS[best.og].zone || best.name };
    state.og = 'gps'; chipText(); switchTab('plan');
    if (state.dl) startCompute();
    else $('chipDl').click();
  } catch {
    alertNearby('위치를 읽지 못했어요(권한 거부 또는 시간 초과) — 출발지를 직접 골라 주세요');
  } finally {
    btn.classList.remove('busy');
  }
});
function alertNearby(msg) {                  // alert 금지 — 카드 밑 한 줄로
  const el = $('qStart').parentElement.querySelector('.qhint');
  el.textContent = msg;
  setTimeout(() => { el.textContent = '문 연 곳과 이동시간을 검증해 일정을 짜 드려요'; }, 6000);
}

const ZONES = [
  { name: '충장로', og: 'chungjang' },
  { name: '동명동', og: 'dongmyeong' },
  { name: '양림동', og: 'yangnim' },
];
ZONES.forEach(z => {
  const n = CANDIDATES.filter(c => c.zone === z.name).length;
  const b = document.createElement('button');
  b.className = 'zcard';
  b.innerHTML = '<div class="zn">' + z.name + '</div><div class="zc">확인된 곳 ' + n + '</div>';
  b.addEventListener('click', () => {
    state.og = z.og; chipText(); switchTab('plan');
    if (state.dl) startCompute();
    else $('chipDl').click();               // 마감부터 — 빈 칩이 스스로 안내
  });
  $('zoneCards').appendChild(b);
});

/* ═══ 행사 — 서버 프록시, 죽으면 사전 캐시 폴백 ═══ */
function fmtFest(f) {
  const d = s => Number(s.slice(4, 6)) + '.' + Number(s.slice(6, 8));
  return d(f.start) + '~' + d(f.end);
}
async function loadFestivals() {
  let d = await serverGet('/festivals', 2500);
  if (!d || !d.ok || !d.items || !d.items.length) {
    try { d = await (await fetch('festivals.json')).json(); } catch { d = null; }
  }
  const items = (d && d.items) || [];
  const hb = $('festCards'); hb.innerHTML = '';
  items.slice(0, 6).forEach(f => {
    const c = document.createElement('button');
    c.className = 'hcard';
    c.innerHTML = '<div class="nm">' + esc(f.title) + '</div><div class="ct">'
      + fmtFest(f) + ' · ' + esc(f.place) + '</div>';
    c.addEventListener('click', () => switchTab('fest'));
    hb.appendChild(c);
  });
  $('festBlock').hidden = !items.length;
  const fl = $('festList'); fl.innerHTML = '';
  items.forEach(f => {
    const div = document.createElement('div');
    div.className = 'mcard'; div.style.borderStyle = 'solid';
    div.innerHTML = '<div><div class="nm">' + esc(f.title) + '</div><div class="ct">'
      + fmtFest(f) + ' · ' + esc(f.place) + '</div></div>';
    fl.appendChild(div);
  });
  if (!items.length)
    fl.innerHTML = '<div class="empty">행사 정보를 불러오지 못했어요.</div>';
}
$('festMore').addEventListener('click', () => switchTab('fest'));

/* ═══ 마이 — 별명(이 폰에만) + 기록 ═══ */
const stats = JSON.parse(localStorage.getItem('itda_stats') || '{"plans":0}');
function bumpPlans() {
  stats.plans++;
  localStorage.setItem('itda_stats', JSON.stringify(stats));
  renderStats();
}
function renderStats() {
  $('stPlans').textContent = stats.plans;
  $('stMaybe').textContent = state.last ? state.last.maybe.length : 0;
}
$('nick').value = localStorage.getItem('itda_nick') || '';
$('nickSave').addEventListener('click', () => {
  localStorage.setItem('itda_nick', $('nick').value.trim());
  $('nickSave').textContent = '저장됨';
  setTimeout(() => { $('nickSave').textContent = '저장'; }, 1200);
});

/* ═══ 사장님 자가 온보딩 — 전부 실동작. 미구성 수단은 서버가 목록에서 뺀다 ═══ */
let ownSel = null;
function ownNote(text, cls) {
  const el = $('ownMsg');
  el.hidden = !text; el.textContent = text || '';
  el.className = 'ownmsg' + (cls ? ' ' + cls : '');
}
async function doOwnSearch() {
  ownNote(''); $('ownMethods').hidden = true; $('ownForm').hidden = true;
  const q = $('ownQ').value.trim();
  if (q.length < 2) { ownNote('두 글자 이상 입력해 주세요', 'err'); return; }
  const d = await serverGet('/stores/search?q=' + encodeURIComponent(q), 4000);
  if (!d) { ownNote('서버에 연결할 수 없어요 — 가게 인증은 서버가 켜져 있을 때 가능해요', 'err'); return; }
  if (!d.ok) { ownNote(d.reason, 'err'); return; }
  const box = $('ownResults'); box.innerHTML = '';
  if (!d.stores.length) { ownNote('광주 동구·남구 ' + d.total + '곳에서 찾지 못했어요', 'err'); return; }
  d.stores.forEach(s => {
    const b = document.createElement('button');
    b.innerHTML = '<span><span class="on">' + esc(s.name) + '</span><br><span class="oa">'
      + esc(s.addr) + '</span></span>' + (s.claimed ? '<span class="odone">등록됨</span>' : '');
    b.addEventListener('click', () => pickStore(s));
    box.appendChild(b);
  });
}
$('ownSearch').addEventListener('click', doOwnSearch);
$('ownQ').addEventListener('keydown', e => { if (e.key === 'Enter') doOwnSearch(); });

async function pickStore(s) {
  ownSel = s; ownNote(''); $('ownForm').hidden = true;
  $('ownResults').innerHTML = ''; $('ownQ').value = s.name;
  const d = await serverGet('/owner/methods', 4000);
  if (!d || !d.ok) { ownNote('서버에 연결할 수 없어요', 'err'); return; }
  const box = $('ownMethods');
  box.hidden = false; box.className = 'olist'; box.innerHTML = '';
  d.methods.forEach(m => {
    const b = document.createElement('button');
    b.innerHTML = '<span><span class="on">' + esc(m.label) + '</span><br><span class="oa">'
      + esc(m.desc) + '</span></span><span class="oa">›</span>';
    b.addEventListener('click', () => showMethodForm(m.id));
    box.appendChild(b);
  });
}

function showMethodForm(mid) {
  const f = $('ownForm'); f.hidden = false; f.innerHTML = ''; ownNote('');
  const mk = (ph, extra) => {
    const i = document.createElement('input');
    i.placeholder = ph; Object.assign(i, extra || {});
    f.appendChild(i); return i;
  };
  const mkBtn = label => {
    const b = document.createElement('button');
    b.className = 'primary';
    b.style.cssText = 'display:block;width:100%;min-height:48px;border-radius:12px;margin-top:10px;'
      + 'background:var(--acc-glass);color:var(--on-acc);font-weight:700;font-size:var(--fs-s)';
    b.textContent = label; f.appendChild(b); return b;
  };
  if (mid === 'sms') {
    ownNote('공개된 가게 전화번호로 인증번호를 보내요');
    const send = mkBtn('인증번호 보내기');
    send.addEventListener('click', async () => {
      send.disabled = true;
      const d = await serverPost('/owner/claim/sms/request', { store_key: ownSel.key });
      send.disabled = false;
      if (!d) { ownNote('서버에 연결할 수 없어요', 'err'); return; }
      if (!d.ok) { ownNote(d.reason, 'err'); return; }
      f.innerHTML = '';
      ownNote(d.sent_to + '로 보냈어요 — 5분 안에 입력해 주세요', 'ok');
      const code = mk('인증번호 6자리', { inputMode: 'numeric', maxLength: 6 });
      mkBtn('확인').addEventListener('click', async () =>
        handleClaim(await serverPost('/owner/claim/sms/verify', { store_key: ownSel.key, code: code.value })));
    });
  } else if (mid === 'biz') {
    const bno = mk('사업자등록번호 10자리', { inputMode: 'numeric' });
    const nm = mk('대표자명');
    const dt = mk('개업일 8자리 (예: 20190301)', { inputMode: 'numeric', maxLength: 8 });
    mkBtn('국세청에서 확인').addEventListener('click', async () =>
      handleClaim(await serverPost('/owner/claim/biz',
        { store_key: ownSel.key, b_no: bno.value, p_nm: nm.value, start_dt: dt.value })));
  } else {
    const code = mk('파일럿 코드 4자리', { inputMode: 'numeric', maxLength: 4 });
    mkBtn('확인').addEventListener('click', async () => {
      const v = await serverPost('/owner/session', { code: code.value });
      if (v && v.ok) handleClaim({ ok: true, token: code.value, store: v.store });
      else ownNote((v && v.reason) || '없는 코드예요', 'err');
    });
  }
}
function handleClaim(v) {
  if (!v) { ownNote('서버에 연결할 수 없어요', 'err'); return; }
  if (!v.ok) { ownNote(v.reason || '인증에 실패했어요', 'err'); return; }
  if (v.pending) {                       // 사업자 확인만으로는 관리권 미발급 — 정직하게 접수 안내
    $('ownForm').hidden = true;
    ownNote(v.message || '접수됐어요 — 가게 소유 확인 후 관리가 열려요', 'ok');
    return;
  }
  localStorage.setItem('itda_owner', JSON.stringify({ token: v.token, name: v.store.name }));
  renderOwner();
}
function renderOwner() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem('itda_owner')); } catch {}
  $('ownDone').hidden = !o;
  $('ownStart').hidden = !!o;
  if (o) {
    $('ownName').textContent = o.name + ' — 인증됨';
    $('ownOpen').href = 'owner.html?code=' + encodeURIComponent(o.token);
  }
}
$('ownOut').addEventListener('click', () => { localStorage.removeItem('itda_owner'); renderOwner(); });

/* ═══ 초기화 ═══ */
chipText();
renderOwner();
renderStats();
loadFestivals();
loadHome();
