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
  setChip('chipOg', state.og && OG_OPTS.find(o => o.key === state.og).label, '출발');
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

/* ═══ 탭 ═══ */
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabbar button').forEach(x => { x.classList.remove('on'); x.removeAttribute('aria-current'); });
  b.classList.add('on'); b.setAttribute('aria-current', 'page');
  stage.dataset.tab = b.dataset.tab;
  if (b.dataset.tab !== 'plan') springTo('half');
}));
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
let vParsedResult = null;
function showEcho(text) {
  const got = parseSpeech(text);
  vParsedResult = got;
  $('vHeard').textContent = '“' + text + '”';
  const missing = [];
  if (!got.dl && !state.dl) missing.push('마감');
  if (!got.og && !state.og) missing.push('출발지');
  $('vParsed').innerHTML = got.cond.length
    ? '반영: <b>' + got.cond.join(' · ') + '</b>' + (missing.length ? '<br>' + missing.join('·') + '은 못 들었어요 — 칩으로 골라 주세요' : '')
    : '조건을 못 알아들었어요. 칩으로 골라 주세요.';
  $('vInput').hidden = true;
  vs.classList.add('show');
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
$('vApply').addEventListener('click', () => {
  if (!vParsedResult && !$('vInput').hidden) vParsedResult = parseSpeech($('vInput').value || '');
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

/* ═══ 초기화 ═══ */
chipText();
