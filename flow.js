/* 광주잇다 — 새 화면 흐름 1단계 (청사진 2026-09-03 §3) — 독립 검토 36건 반영판
 * 화면 전환 · GPS 위치 문구 · 알람식 시간 휠 · 교통편/할 일 선택 · 확인 화면 값 연결 · 돌아가는 길 카드(회랑 1개, 앱 내 계산)
 * 아직 없음: 음성 인식(STT) 배선, 실제 카카오맵, 서버 /plan 호출 — 다음 단계 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // 일정 편집 상태의 빈 값(기술설계 §1.1). plan.js(ItdaPlan.emptyEdits)가 먼저 로드되지만, 구판 plan.js여도 앱이 죽지 않게 같은 모양으로 폴백.
  function emptyEdits(intent) {
    if (window.ItdaPlan && typeof ItdaPlan.emptyEdits === 'function') return ItdaPlan.emptyEdits(intent);
    return { v: 1, intent: intent || 'none', rejected: {}, fixed: {}, pick: {}, added: [], removed: [], stay: {}, nextId: 100 };
  }
  const PARAMS = new URLSearchParams(location.search);   // 주소창 파라미터는 화면 전환(#해시)으로 바뀌지 않아 한 번만 읽는다
  const param = (k) => PARAMS.get(k);
  // 숫자로 흩어져 있던 값들. 화면 문구가 아니라 타이밍·범위라 이름을 붙여 모은다.
  const MS = { guard: 450, holdMin: 350, sheetSlide: 220, pick: 180, wheelCommit: 90, voiceHint: 5000, voiceGiveUp: 9000, voiceMax: 12000, flash: 1500, greet: 700, focus: 60, mapDraw: 30 };
  const NET_MS = { corridors: 2500, places: 4000, trains: 5000, taxi: 7000, nlu: 3500, route: 4000, planAi: 4000, weather: 6000 };
  const GEO_OPT = { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 };
  const WATCH_OPT = { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 };   // 위치 감시(설계 §3) — 앱이 앞에 있을 때만 켠다
  const HERE_IN_M = 80, HERE_OUT_M = 150;    // '여기' 판정 히스테리시스: 이 안으로 들어오면 여기 · 이 밖으로 나가면 해제
  const PLACES_R = 1200, ZONE_R = 1000;      // 주변 장소 반경(m): 현재 좌표 / 회랑 동네
  const DAY_START = 5 * 60;                  // 새벽 5시 이전은 '오늘 차'로 보지 않는다
  const LEAVE_ROUND = 5;                     // 나갈 시각은 5분 단위로 내림
  const DONGS_MAX = 5;                       // 최근 고른 동네 보관 개수
  const TEXT_MAX = 200;                      // 글 입력 한 줄 최대 글자
  const BUFFERS = [30, 45];                  // 역 도착 여유 선택지(분) — #buf30·#buf45
  const ALARM_ID = { pre: 101, at: 102, rain: 103 };    // 로컬 알림 id(10분 전·정각·비 예보)
  const PLAN_KEY = 'itda.plan.v1';   // 저장/복원 키(§5-10): plan-ui가 쓰고(persist) flow.js가 시작 시 읽는다(loadSaved)
  const PREFS_KEY = 'itda.prefs.v1';         // 취향(설계 §2) — 온보딩 #scrPrefs·내 정보 #scrMe가 쓰고 일정 생성에 넘긴다
  const TASTE_MAP_URL = 'taste_map.json';    // 취향 매핑표의 앱 번들 사본(data/taste_map.json 복사) — 서버 없이도 읽힌다
  const BUILD_MIN_MS = 600;                  // '짜는 중'을 최소 이만큼은 보여 준다(설계 §6)
  const PROGRESS_KEY = 'itda.progress.v1';   // GPS 진행 상태(당일). 일정 저장 스키마(itda.plan.v1)는 그대로 두고 별도 키에만 쓴다

  // ---------- 상태 ----------
  const state = {
    loc: { status: 'pending', key: null, name: '광주', zone: null, lat: null, lon: null, manual: false }, // status: pending|place|unlisted|outside|manual|failed
    hour: null, minute: null, touchedTime: false,
    dest: null,          // 'songjeong' | 'terminal' | 'none'
    intent: null,        // 'eat' | 'cafe' | 'play' | 'sight' — intents[0]의 거울(기존 코드 호환). 바꿀 땐 setIntents()로만
    intents: [],         // v3 계약: 할 일 다중 선택(고른 순서)
    who: null,           // 'citizen' | 'traveler' | null (localStorage itda.who)
    train: null,         // v3 계약: 고른 차편 {from, dep, arr, to, grade} | null
    trainManual: false,  // 차편 목록 대신 '직접 입력'을 골랐는지 — 진행 표시(짧은 선) 개수가 달라진다
    nearDong: null,      // 서버 /places near.dong(현재 좌표의 동 이름) — 위치 시트 첫 줄
    buffer: 30,          // 역 도착 여유(저희가 잡은 값)
    editing: null, editKey: null,   // 확인 화면 '변경' 흐름
    card: null, stepIdx: 0,
    placesSource: 'bundle', dong: '',
    plan: null, planEdits: emptyEdits('none'), planUndo: [], planConfirmed: false, cardPending: false,   // 일정(기술설계 §1): 생성 결과 · 편집(거절·고정·추가·삭제) · 되돌리기 스택(깊이 1) · '이 일정으로' 눌렀는지 · 카드 계산 중
    progress: { atId: null, nextId: null, visited: [] },   // GPS 진행 판정(설계 §3): 지금 있는 칸 · 다음 칸 · 지나온 칸들. 기기 안에서만 — 서버로 안 보낸다
    prefs: null, tasteMap: null, planAi: null,   // 취향(itda.prefs.v1) · 취향 매핑표 · 마지막 AI 결과 {picks, why, order}
    askPrefs: null,      // 이번에 '말로 지정한' 취향 { food:'western'|null } — 저장하지 않고 이 요청에만 쓴다(내 정보의 취향을 덮어씀)
    inputMode: 'voice', sheetPlace: null,   // 마지막 입력 수단(voice|text) · 지도 시트에서 고른 가게   // 서버 주변 장소 받았는지 · 동 이름(가장 가까운 가게의 행정동)
  };
  let navigating = false;           // 더블탭·손떨림 가드
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const WHO_KEY = 'itda.who', DONGS_KEY = 'itda.dongs';
  const DEV_KEY = 'itda.dev', DEVPOS_KEY = 'itda.devPos', DEVNOW_KEY = 'itda.devNow', DEVSRV_KEY = 'itda.devServer';   // 개발자 모드 스위치 · 시연 고정값(위치·시각·서버, 7b). 위치·SERVER 코드가 먼저 읽어야 해서 여기 둔다
  // 픽토그램 헬퍼(기준 §3 매핑표) — 스프라이트는 index.html 상단 인라인 <symbol id="i-*">
  const IC = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const CAT_IC = { eat: 'utensils', cafe: 'coffee', play: 'sparkles', sight: 'landmark', stay: 'bed' };
  const BADGE = (icon, text, cls) => `<span class="badge${cls ? ' ' + cls : ''}">${icon ? IC(icon) : ''}<span>${esc(text)}</span></span>`;
  function readWho() { try { const w = localStorage.getItem(WHO_KEY); return w === 'citizen' || w === 'traveler' ? w : null; } catch (e) { return null; } }
  function saveWho(w) { state.who = w; try { localStorage.setItem(WHO_KEY, w); } catch (e) {} }
  // 할 일 다중 선택: state.intents가 원본, state.intent는 항상 intents[0]||null. 화면(#doChoices aria-pressed·#btnDoNext)도 여기서 맞춘다.
  function setIntents(arr) {
    const seen = new Set();
    state.intents = (Array.isArray(arr) ? arr : (arr ? [arr] : [])).filter(x => x && INTENTS[x] && !seen.has(x) && seen.add(x));
    state.intent = state.intents[0] || null;
    syncDoChoices();
  }
  function syncDoChoices() {
    const wrap = $('doChoices'); if (!wrap) return;
    wrap.querySelectorAll('.choice').forEach(x => { const on = state.intents.includes(x.dataset.v); x.classList.toggle('sel', on); if (x.classList.contains('multi')) x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    const n = $('btnDoNext'); if (n) n.disabled = !state.intents.length;
  }

  // ---------- 장소 사전 (단말 안에서만 판정, 좌표는 서버로 보내지 않음) ----------
  const PLACES = [
    { key: 'champions', name: '챔피언스필드', lat: 35.1682, lon: 126.8891, zone: null,     r: 700 },
    { key: 'chungjang', name: '충장로',       lat: 35.1487, lon: 126.9166, zone: '충장로', r: 900 },
    { key: 'acc',       name: '문화전당',     lat: 35.1465, lon: 126.9200, zone: '충장로', r: 500 },
    { key: 'dongmyeong',name: '동명동',       lat: 35.1500, lon: 126.9260, zone: '동명동', r: 700 },
    { key: 'yangnim',   name: '양림동',       lat: 35.1385, lon: 126.9130, zone: '양림동', r: 800 },
    { key: 'songjeong', name: '광주송정역',   lat: 35.1394, lon: 126.7930, zone: null,     r: 600 },
    { key: 'terminal',  name: '유스퀘어',     lat: 35.1607, lon: 126.8788, zone: null,     r: 500 },
  ];
  const GWANGJU = { latMin: 35.05, latMax: 35.26, lonMin: 126.65, lonMax: 127.02 };
  const DESTS = { songjeong: { name: '광주송정역', kind: '기차' }, terminal: { name: '유스퀘어', kind: '버스' }, none: { name: '정한 곳 없음', kind: '차' } };
  const INTENTS = { eat: '식사', cafe: '카페', play: '플레이스', sight: '구경' };

  // 회랑 1개 (청사진 §4.1): 충장로 → 광주송정역, 1호선 평동행. 시각은 재가공표 — 당일 앱에서 재확인. 표 밖은 추측하지 않는다.
  const CORRIDORS = {
    '충장로|songjeong': {
      hub: '금남로4가역', hubPos: { lat: 35.14930, lon: 126.91560 }, line: '1호선', dir: '평동', walk_max: 8, buffer: 3, ride: 23,
      weekday: ['18:02','18:09','18:16','18:23','18:30','18:37','18:44','18:51','18:58','19:05','19:12','19:19','19:26'],
      weekend: ['18:07','18:17','18:27','18:37','18:47','18:57','19:07','19:17','19:27'],
      confidence: '시간표 기준 · 오늘 확인 전',
    },
  };
  const INBOUND = { 'champions|충장로': { line: '운림51', dir: '증심사 방면', stop: '챔피언스필드 정류소', alight: '금남로4가역 정류소', alightPos: { lat: 35.14930, lon: 126.91560 }, walk: 5, wait: 15, ride: 15 } };
  // ---------- 0b. 개발자 모드 스위치 · 시연용 내 위치 고정 (여는 곳은 7b) ----------
  const devOn = () => { try { return localStorage.getItem(DEV_KEY) === '1'; } catch (e) { return false; } };
  /* 시연 고정 시각(?now=의 앱 안 버전) — 'HH:MM'. nowMin()·syncWeather가 읽는다.
   * 가짜 시각이면 로컬 알림은 걸지 않는다(지난 시각으로 예약하면 안드로이드가 그 자리에서 울린다). */
  function devNow() {
    if (!devOn()) return null;
    let v = null; try { v = localStorage.getItem(DEVNOW_KEY); } catch (e) {}
    return v && /^\d{1,2}:\d{2}$/.test(v) ? v : null;
  }
  /* 시연 서버 주소(?server=의 앱 안 버전) — APK는 URL을 못 바꾸므로 여기서 고른다.
   * SERVER는 상수라 바꾸면 앱을 다시 시작해야 한다(개발자 모드가 알아서 다시 시작한다). */
  function devServer() {
    if (!devOn()) return null;
    let v = null; try { v = localStorage.getItem(DEVSRV_KEY); } catch (e) {}
    return v && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : null;
  }
  /* 시연 재현성: 개발자 모드에서 위치를 고르면 그 자리가 '지금 내 위치'가 된다.
   * GPS 감시를 켜지 않고, 들어오는 좌표도 무시한다 — 지도의 '내 위치' 버튼이 실제 현재 위치로 돌아가지 않게. */
  function devPos() {
    if (!devOn()) return null;
    try { const d = JSON.parse(localStorage.getItem(DEVPOS_KEY) || 'null'); return d && Number.isFinite(d.lat) && Number.isFinite(d.lon) ? d : null; } catch (e) { return null; }
  }
  function devSetPos(d) {                                  // d가 null이면 고정 해제 → 다시 진짜 GPS
    try { if (d) localStorage.setItem(DEVPOS_KEY, JSON.stringify(d)); else localStorage.removeItem(DEVPOS_KEY); } catch (e) {}
    if (d) { stopWatch(); setPos(d.lat, d.lon, true); } else startWatch();
    renderDev();
  }
  function devPin(d) {                                     // 위치 시트·말로 고른 동네를 시연 고정 위치로 (개발자 모드일 때만)
    if (!devOn() || !d || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) return;
    devSetPos({ name: d.name || '광주', lat: d.lat, lon: d.lon, zone: d.zone || null, key: d.key || null });
    toast(`내 위치를 '${d.name || '고른 곳'}'에 고정했어요`, 2500, 'map-pin');
  }

  // 서버 회랑 번들(/corridors)로 인라인 사본을 덮어쓴다. 서버가 없으면 인라인 그대로(무통신 폴백).
  /* 공개 배포(Render 등)에서는 앱과 API를 같은 서버가 서빙한다 — 주소를 손으로 붙이지 않아도 되게 자기 출처를 쓴다.
     Capacitor(https://localhost)·노트북 개발(localhost:8787 + API 8000)·API 없는 Pages 데모는 지금 규칙 그대로. */
  const PUBLIC_API = 'https://gwangju-itda-api.onrender.com';   // 공개 배포 API. GitHub Pages(정적)는 API가 없어 이 주소를 본다.
  function pageServer() {
    if (!/^https?:$/.test(location.protocol)) return null;
    const h = location.hostname;
    if (!h || h === 'localhost' || h === '127.0.0.1') return null;
    if (/\.github\.io$/.test(h)) return PUBLIC_API;   // Pages는 파일만 준다 — 서버 일(장소·날씨·말 이해·사장님)은 저쪽
    return location.origin;                           // API가 앱을 직접 서빙(Render 등) — 자기 출처가 곧 API
  }
  const SERVER = param('server') || devServer() || pageServer() || 'http://localhost:8000';   // ?server= > 개발자 모드 > 앱을 내려준 서버 > 노트북
  // 서버 호출 공통: 정해진 시간이 지나면 스스로 끊는다. 응답이 200이 아니면 null, 통신 자체가 끊기면 예외 — 호출부가 폴백을 고른다.
  async function getJson(url, ms) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
    try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? await r.json() : null; }
    finally { clearTimeout(t); }
  }
  async function syncCorridors() {
    try {
      const d = await getJson(SERVER + '/corridors', NET_MS.corridors);
      if (!d || !d.ok) return;
      for (const c of d.corridors || []) CORRIDORS[`${c.zone}|${c.dest}`] = { hub: c.hub, hubPos: c.hubPos, line: c.line, dir: c.dir, walk_max: c.walk_max, buffer: c.buffer, ride: c.ride, weekday: c.weekday, weekend: c.weekend, confidence: ({ timetable: '시간표 기준 · 오늘 확인 전', field: '현장 확인', estimate: '추정' }[c.confidence] || c.confidence) + (c.checked_at ? ` (${c.checked_at})` : '') };
      for (const i of d.inbound || []) if (i) INBOUND[`${i.origin}|${i.zone}`] = { line: i.line, dir: i.dir, stop: i.board_stop, alight: i.alight_stop, alightPos: i.alight, walk: i.walk_to_stop_min, wait: i.wait_worst_min, ride: i.ride_min };
      state.corridorSource = 'server';
      console.log('corridors from server', (d.corridors || []).length);
    } catch (e) { state.corridorSource = 'bundle'; }
  }

  // ---------- 홈 하늘 배경 (2026-09-04) ----------
  // 서버 /weather(기상청 초단기예보)가 그림 이름(bg)과 밝기(tone)를 고른다. 앱은 깔기만 한다.
  // 서버가 없거나 느리면 아무것도 안 바꾼다 — 기존 하늘색 그라데이션이 그대로 남는다(무통신 폴백).
  const SKY_BG = ['clear-morning', 'clear-day', 'overcast-day', 'rainy-day', 'sunset', 'night'];
  const SKY_IC = { 'clear-morning': 'sun', 'clear-day': 'sun', 'overcast-day': 'cloud', 'rainy-day': 'cloud-rain', 'sunset': 'cloud-sun', 'night': 'moon' };
  let skyBg = null;
  // 사진 배경을 걷어야 하는 조건 — OS 고대비, 또는 앱이 켠 스위치(reduce-glass·senior). 걷으면 밤의 흰 글씨도 같이 되돌린다(flow.css).
  function syncFlatSky() {
    const h = document.documentElement;
    const flat = h.classList.contains('reduce-glass') || h.classList.contains('senior')
      || (window.matchMedia && matchMedia('(prefers-contrast: more)').matches);
    h.classList.toggle('flat-sky', flat);
  }
  function applySky(bg, tone, label, rain) {
    syncFlatSky();
    const w = $('wxTag');                                                  // 기온·하늘 한 줄은 그림이 그대로여도 갱신한다(25°→27°)
    if (w) {
      // 비 소식이 있으면 같은 줄에 붙인다 — 지금 이미 오는 중이면 시각 대신 '지금'
      const soon = rain ? (rain.in_min <= 0 ? `지금 ${rain.kind}` : `${rain.at} ${rain.kind}`) : '';
      const text = [label, soon].filter(Boolean).join(' · ');
      w.hidden = !text;
      if (text) w.innerHTML = IC(rain ? 'cloud-rain' : (SKY_IC[bg] || 'cloud'), 'ic-s') + `<span>${esc(text)}</span>`;
    }
    if (!SKY_BG.includes(bg) || bg === skyBg) return;                      // 서버가 모르는 이름은 무시(오타·구버전)
    skyBg = bg;
    const h = $('scrHome'); if (!h) return;
    h.style.setProperty('--sky-img', `url("assets/sky/${bg}.webp")`);
    h.dataset.sky = bg;
    h.dataset.tone = tone === 'dark' ? 'dark' : 'light';
  }
  // 어디서 물었는지를 기억한다. 좌표가 바뀌면(위치를 잡았거나 사용자가 동네를 바꿨거나) 그 격자로 다시 묻고,
  // 같은 자리면 10분 안에는 다시 묻지 않는다 — 서버 캐시 주기와 같다.
  let skyKey = null, skyAt = 0;
  const SKY_FRESH = 10 * 60 * 1000;
  async function syncWeather(force) {                                       // force: 앱으로 돌아왔을 때 — 10분 신선도를 건너뛴다(서버 캐시가 받아 준다)
    const forced = param('sky');                                           // 시연·검증용 ?sky=night
    if (forced) { applySky(forced, forced === 'night' ? 'dark' : 'light', null); return; }
    const q = new URLSearchParams();
    let key = 'default';                                                   // 좌표가 없으면 서버가 광주 기본 격자로 답한다
    if (state.loc.lat && state.loc.lon) {
      q.set('lat', state.loc.lat); q.set('lon', state.loc.lon);
      key = state.loc.lat.toFixed(2) + ',' + state.loc.lon.toFixed(2);     // 약 1km 단위 — 위치가 조금 흔들려도 다시 묻지 않는다
    }
    const at = param('now') || devNow(); if (at) { q.set('now', at); key += '@' + at; }   // ?now=19:40 · 개발자 모드 시각 고정이면 배경도 그 시각으로
    if (!force && key === skyKey && Date.now() - skyAt < SKY_FRESH) return;
    skyKey = key; skyAt = Date.now();
    try {
      const d = await getJson(`${SERVER}/weather?${q}`, NET_MS.weather);
      if (d && d.ok) { applySky(d.bg, d.tone, d.label, d.rain); scheduleRainAlert(d.rain); } else skyKey = null;
    } catch (e) { skyKey = null; }                                         // 실패는 기억하지 않는다 — 다음 기회에 그 격자로 다시 묻는다
  }

  // ---------- '곧 비' 알림 ----------
  // 폴링이 아니라 예약이다. 초단기예보가 6시간 앞을 주므로 비 오기 RAIN_LEAD분 전에 로컬 알림을 걸어 둔다.
  // 그래서 앱이 꺼져 있어도 안드로이드가 그 시각에 띄운다 — 백그라운드로 도는 코드도, 서버에 남기는 좌표도 없다.
  const RAIN_LEAD = 30;                                        // 비 오기 몇 분 전에 알릴지
  const RAIN_KEY = 'itda.rainAlert';                           // 같은 비 예보로 두 번 울리지 않게 (앱을 껐다 켜도)
  async function scheduleRainAlert(rain) {
    const LN = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications; if (!LN) return;
    if (param('now') || param('sky') || devNow()) return;      // 시연용 가짜 시각·배경이면 알림은 안 건다(지난 시각으로 예약하면 그 자리에서 울린다)
    const key = rain ? rain.at_iso + '|' + rain.pty : '';
    let seen = ''; try { seen = localStorage.getItem(RAIN_KEY) || ''; } catch (e) {}
    if (key === seen) return;                                  // 같은 예보면 그대로 둔다(이미 걸려 있다)
    try {
      await LN.cancel({ notifications: [{ id: ALARM_ID.rain }] });   // 예보가 바뀌었으면 옛 알림은 먼저 지운다
      try { localStorage.setItem(RAIN_KEY, key); } catch (e) {}
      if (!rain) return;                                       // 비 소식이 없어졌다 — 지우고 끝
      let st = await LN.checkPermissions(); if (st.display !== 'granted') st = await LN.requestPermissions();
      if (st.display !== 'granted') return;                    // 알림을 막아 뒀으면 조용히 넘어간다(배경은 그대로 바뀐다)
      const lead = Math.max(0.2, rain.in_min - RAIN_LEAD);     // 이미 오고 있으면(in_min 0) 곧바로
      const soon = rain.in_min <= RAIN_LEAD;
      await LN.schedule({ notifications: [{
        id: ALARM_ID.rain,
        title: soon ? `${rain.kind} 와요` : `${rain.at}쯤 ${rain.kind} 소식이에요`,
        body: '가까운 카페에서 쉬었다 가시겠어요? 눌러서 보기',
        extra: { kind: 'rain' },
        schedule: { at: new Date(Date.now() + lead * 60000), allowWhileIdle: true },
      }] });
    } catch (e) { console.warn('rain alert fail', e && e.message); try { localStorage.removeItem(RAIN_KEY); } catch (e2) {} }
  }
  { const LN = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications;
    if (LN && LN.addListener) LN.addListener('localNotificationActionPerformed', (e) => {   // 알림을 누르면 근처 카페 지도로
      const x = e && e.notification && e.notification.extra;
      if (x && x.kind === 'rain') quickAsk('cafe', '근처 카페 찾아줘');
    }); }
  setInterval(syncWeather, 15 * 60 * 1000);                                // 15분마다(서버 캐시가 있어 기상청 쿼터를 더 쓰지 않는다)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncWeather(true); });   // 웹·웹뷰에서 화면이 다시 보이면 즉시
  // 서버 주변 장소(/places): 현재 좌표 반경 1.2km의 식당·카페·숙박·플레이스. 서버가 없으면 앱 내장(충장로·동명동·양림동)만.
  const BUNDLE_PLACES = window.PLACES_DATA;
  async function syncPlaces() {
    if (!state.loc.lat) return;
    try {
      const d = await getJson(`${SERVER}/places?lat=${state.loc.lat}&lon=${state.loc.lon}&r=${PLACES_R}`, NET_MS.places);
      if (!d || !d.ok) return;
      if (!Array.isArray(d.rows) || !Array.isArray(d.cols)) return;   // rows/cols 형식이 아니면 기존 번들 데이터를 그대로 유지
      let rows = d.rows;
      // 회랑이 있는 동네로 이동해서 노는 경우(경기장 → 충장로): 그 동네 가게도 같이 받는다. 같은 동네면 중복 제거.
      const zone = zoneOf(), zc = zone && ZONE_CENTER[zone];
      if (zc) {
        try {
          const d2 = await getJson(`${SERVER}/places?lat=${zc.lat}&lon=${zc.lon}&r=${ZONE_R}`, NET_MS.places);
          if (d2 && d2.ok) { const seen = new Set(rows.map(x => x[0])); for (const x of d2.rows) if (!seen.has(x[0])) rows.push(x); }
        } catch (e) { /* 동네 장소는 없어도 현재 위치 장소로 진행 */ }
      }
      if (!rows.length) return;
      window.PLACES_DATA = { fetched_at: d.fetched_at, source: d.source, count: rows.length, cols: d.cols, rows };
      state.placesSource = 'server';
      state.plan = null; if (cur === 'scrPlan') ItdaPlanUI.render();   // 후보 목록이 바뀌었으니 일정은 다시 짠다(편집은 유지)
      if (d.near && d.near.dong) state.nearDong = d.near.dong;   // 위치 시트 첫 줄(현재 동네)
      if (d.near && d.near.dong && (state.loc.status === 'unlisted' || state.loc.status === 'failed')) { state.dong = d.near.dong; setLoc({ name: d.near.dong }); }
      console.log('places from server', d.count, d.near);
    } catch (e) { window.PLACES_DATA = BUNDLE_PLACES; state.placesSource = 'bundle'; }
  }
  const ZONE_CENTER = { '충장로': { lat: 35.1487, lon: 126.9166 }, '동명동': { lat: 35.1500, lon: 126.9260 }, '양림동': { lat: 35.1385, lon: 126.9130 } };
  // 지금 서 있는 권역. 경기장은 진입 회랑을 타고 충장로로 간다는 전제(골든 패스)라 충장로로 본다.
  const zoneOf = () => state.loc.zone || (state.loc.key === 'champions' ? '충장로' : null);
  function nowMin() { const q = param('now') || devNow(); if (q && /^\d{1,2}:\d{2}$/.test(q)) { const [h, m] = q.split(':').map(Number); return h * 60 + m; } const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }   // 시연용 ?now=16:00 · 개발자 모드 시각 고정

  // ---------- 유틸 ----------
  const t2m = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const norm = (m) => ((m % 1440) + 1440) % 1440;
  function kor(m) {                       // 60대 말투: '오후 7시 30분'
    m = norm(m); const h = Math.floor(m / 60), mm = m % 60;
    const ap = h < 12 ? '오전' : '오후'; const h12 = h % 12 === 0 ? 12 : h % 12;
    return mm ? `${ap} ${h12}시 ${mm}분` : `${ap} ${h12}시`;
  }
  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  let toastT;
  // 토스트: 12자 이내 + 아이콘(기준 §4). icon은 스프라이트 이름, 본문은 항상 esc(장소명이 섞이는 호출이 있다).
  function toast(msg, ms = 3500, icon) { const el = $('toast'); el.innerHTML = (icon ? IC(icon) : '') + `<span>${esc(msg)}</span>`; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms); }
  function speak(text) {
    try { if (!('speechSynthesis' in window)) return false; const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR'; u.rate = 0.95; speechSynthesis.cancel(); speechSynthesis.speak(u); return true; } catch { return false; }
  }
  function guard(fn) { return (...a) => { if (navigating) return; navigating = true; setTimeout(() => { navigating = false; }, MS.guard); fn(...a); }; }

  // ---------- 화면 전환 (히스토리 = 화면 스택. 앞으로는 push, 뒤로는 history.back) ----------
  let cur = 'scrHome';
  function render(id) {
    document.querySelectorAll('.scr').forEach(s => s.classList.toggle('on', s.id === id));
    cur = id; window.scrollTo(0, 0);
    if (id === 'scrHome') renderHome();
    if (id === 'scrTrainPick') { state.trainManual = false; editModeUI('scrTrainPick'); loadTrains(trainFrom); }   // 차편 화면으로 (되)돌아오면 '직접 입력' 갈래는 리셋
    if (id === 'scrAskTime') { setTimeout(initWheels, 0); editModeUI('scrAskTime'); }
    if (id === 'scrAskDest' || id === 'scrAskDo') editModeUI(id);
    if (id === 'scrConfirm') renderConfirm();
    if (id === 'scrPrefs') renderPrefs();
    if (id === 'scrMe') renderMe();
    if (id === 'scrDepart') renderStep();
    exitNav();                                                 // 뒤로가기로 돌아오면 상단 UI만 되살아난다(시트는 아래에서 닫는다)
    if (id === 'scrMapFull') { $('mfSheet').hidden = true; $('mfList').hidden = true; syncMapCtl(); setTimeout(() => drawMap('mapFullCanvas', fullMapOpts()), MS.mapDraw); }
    if (id === 'scrPlan') { syncProgress(); ItdaPlanUI.render(); if (ItdaPlanUI.enterPlan) ItdaPlanUI.enterPlan(); }   // 탭에 들어오면 '여기'(없으면 '다음') 칸으로 스크롤
    const navOn = NAV_SCREENS.includes(id);
    $('nav').hidden = !navOn; document.body.classList.toggle('has-nav', navOn);
    document.querySelectorAll('.nav-b').forEach(b => b.classList.toggle('on', b.dataset.nav === id));
  }
  const NAV_SCREENS = ['scrHome', 'scrMapFull', 'scrPlan', 'scrMe', 'scrDepart'];
  function navTo(id) {
    if (id === cur) return;
    if (id === 'scrHome') { const depth = history.length - startLen; if (depth > 0) history.go(-depth); else goReplace('scrHome'); return; }   // 상태는 지우지 않는다(restart와 다름)
    if ((id === 'scrMapFull' || id === 'scrPlan') && !state.loc.lat) { toast('위치를 먼저 잡아 주세요', 3500, 'map-pin'); return; }
    go(id);
  }
  document.querySelectorAll('.nav-b').forEach(b => b.addEventListener('click', guard(() => navTo(b.dataset.nav))));
  function go(id) { history.pushState({ scr: id }, '', '#' + id); render(id); }          // 앞으로
  function goReplace(id) { history.replaceState({ scr: id }, '', '#' + id); render(id); }
  function back() { if (cur === 'scrHome') return; history.back(); }                       // popstate가 그린다
  window.addEventListener('popstate', (e) => { const id = (e.state && e.state.scr) || 'scrHome'; if (['scrAskTime', 'scrAskDest', 'scrAskDo', 'scrTrainPick'].includes(cur) && id === 'scrConfirm' && state.editing !== 'done') state.editing = null; render(id); });
  function restart() {
    state.hour = null; state.minute = null; state.touchedTime = false; state.dest = null; setIntents([]); state.train = null; state.trainManual = false; state.editing = null; state.card = null; state.lastHeard = null;   // who(시민/여행객)는 남긴다
    state.inputMode = 'voice'; $('textIn').value = ''; textIn.fails = 0; cancelAlarm();
    state.plan = null; state.planAi = null; state.planEdits = emptyEdits('none'); state.planUndo = []; state.planConfirmed = false;   // 처음부터 = 편집(고정·거절)도 지운다
    try { localStorage.removeItem(PLAN_KEY); } catch (e) {}
    const rl = $('resumeLine'); if (rl) rl.hidden = true;
    document.querySelectorAll('.choice.sel').forEach(x => x.classList.remove('sel'));
    const depth = history.length - startLen; if (depth > 0) history.go(-depth); else goReplace('scrHome');
  }
  // 하드웨어 뒤로가기: @capacitor/app 플러그인이 있으면 같은 매핑, 없으면 안드로이드 기본(앱 종료)이라 반드시 설치돼 있어야 한다
  const CapApp = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener) CapApp.addListener('backButton', () => {
    if ($('textSheet').classList.contains('on')) { closeTextSheet(); return; }
    for (const sid of ['swapSheet', 'planDetail', 'planConfirm', 'planSheet', 'locPick']) {   // 열린 시트부터 닫는다(요소가 아직 없으면 건너뜀 — plan 시트는 plan-ui/index.html 소유)
      const sh = $(sid); if (sh && sh.classList.contains('on')) { sh.classList.remove('on'); return; }
    }
    // 홈, 또는 첫 진입 '시민/여행객' 화면(히스토리 시작점)이면 앱 종료. 홈에서 '바꾸기'로 들어온 who 화면은 한 칸 뒤 = 홈.
    if (cur === 'scrHome' || (cur === 'scrWho' && history.length - startLen <= 0)) { if (CapApp.exitApp) CapApp.exitApp(); } else back();
  });
  document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', guard(back)));
  // 진행 표시: 숫자(1/3)가 아니라 짧은 선. 시민/여행객, 차편을 목록에서 고르는지 직접 넣는지에 따라 화면 수가 달라 숫자로는 못 센다.
  function stepSeq() {
    if (state.who === 'citizen') return ['scrAskTime', 'scrAskDo'];                        // 시민: 몇 시까지 → 뭐 할지
    if (!$('scrTrainPick')) return ['scrAskTime', 'scrAskDest', 'scrAskDo'];               // 차편 화면이 없는 구판 마크업
    return state.trainManual ? ['scrTrainPick', 'scrAskTime', 'scrAskDest', 'scrAskDo']    // 직접 입력: 시각·타는 곳을 더 묻는다
                             : ['scrTrainPick', 'scrAskDo'];                               // 목록에서 고르면 시각·타는 곳이 한 번에 정해진다
  }
  function renderDots(sec, id) {
    const el = sec.querySelector('.step.dots'); if (!el) return;
    const seq = stepSeq(), i = seq.indexOf(id);
    el.hidden = i < 0;
    if (i < 0) return;
    el.innerHTML = seq.map((_, j) => `<i${j === i ? ' class="on"' : ''}></i>`).join('');
    el.setAttribute('aria-label', `${seq.length}단계 중 ${i + 1}단계`);
  }
  // '변경' 모드 표시: 진행 표시 숨김, 버튼 문구 교체
  function editModeUI(id) {
    const on = !!state.editing; const sec = $(id); if (!sec) return;
    renderDots(sec, id);
    sec.querySelectorAll('.step').forEach(el => el.style.visibility = on ? 'hidden' : '');
    const nxt = sec.querySelector('.next'); if (nxt) nxt.innerHTML = IC('check') + (on ? '이대로' : (nxt.dataset.label || '다음'));
    sec.querySelectorAll('.lnk.sub span').forEach(el => el.textContent = on ? '그대로 둘게요' : '이전');
  }
  function returnToConfirm() { state.editing = 'done'; history.back(); }   // ask 화면은 confirm에서 push됐으므로 한 칸 뒤 = confirm

  // ---------- 1. 홈: GPS 기반 위치 문구 ----------
  async function readPosition() {
    const G = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Geolocation;
    if (G) {
      try { const st = await G.checkPermissions(); if (st.coarseLocation !== 'granted' && st.location !== 'granted') await G.requestPermissions({ permissions: ['location'] }); } catch (e) { /* 권한 API 없으면 그냥 시도 */ }
      // 정밀 위치(GPS) — 대략 위치는 오차 2km라 반경 700m 판정 불가[실측]
      const p = await G.getCurrentPosition(GEO_OPT);
      return { lat: p.coords.latitude, lon: p.coords.longitude };
    }
    return new Promise((res, rej) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), rej, GEO_OPT) : rej(new Error('no geolocation')));
  }
  function classify(pos) {
    let best = null, bestD = Infinity;
    for (const p of PLACES) { const d = distM(pos, p); if (d < p.r && d < bestD) { best = p; bestD = d; } }
    if (best) return { status: 'place', key: best.key, name: best.name, zone: best.zone };
    const inG = pos.lat >= GWANGJU.latMin && pos.lat <= GWANGJU.latMax && pos.lon >= GWANGJU.lonMin && pos.lon <= GWANGJU.lonMax;
    return inG ? { status: 'unlisted', key: null, name: '광주', zone: null } : { status: 'outside', key: null, name: '광주', zone: null };
  }
  // 홈 첫 줄: v3 마크업이면 `지금 <button #wherePill><span #whereName>…</span></button>에서`(H1). 듣는 중 문구가 textContent로 덮어써도 여기서 복구한다.
  const HOME_WHERE_TPL = $('homeWhere') ? $('homeWhere').innerHTML : '';
  const HAS_PILL = /id="wherePill"/.test(HOME_WHERE_TPL);
  function bindPill() {                                                   // 위치 필은 #homeWhere 안에 있어 복구될 때마다 다시 묶는다 (시민/여행객 필은 헤더 .h-top에 따로 있음)
    const p = $('wherePill'); if (p && !p.dataset.bound) { p.dataset.bound = '1'; p.addEventListener('click', guard(openLocPick)); }
    updateWhoTag();
  }
  function updateWhoTag() { const wt = $('whoTag'); if (wt) { wt.hidden = !state.who; const wn = $('whoName') || wt; wn.textContent = state.who === 'citizen' ? '광주 시민' : '여행객'; const wi = $('whoIcon'); if (wi) wi.innerHTML = `<use href="#i-${state.who === 'citizen' ? 'house' : 'luggage'}"></use>`; } }
  function setLoc(loc) {
    Object.assign(state.loc, loc);
    const s = state.loc.status;
    const hw = $('homeWhere');
    if (HAS_PILL) {
      if (!$('wherePill')) { hw.innerHTML = HOME_WHERE_TPL; bindPill(); }
      $('whereName').textContent = s === 'outside' ? '광주' : state.loc.name;
    } else hw.textContent = s === 'outside' ? '광주에 오시면' : `지금 ${state.loc.name}에서`;
    const line = $('locLine');
    // 통상 상태(place·manual·unlisted)는 아무 것도 안 띄운다. 예외만 아이콘+짧은 경고(기준 §4, 판단1).
    const L = { pending: ['locate-fixed', '', '위치 확인 중'], outside: ['triangle-alert', '광주 밖 · 눌러서 선택', ''], failed: ['triangle-alert', '위치 못 찾음 · 선택', ''] }[s] || null;
    line.innerHTML = L ? IC(L[0]) + (L[1] ? `<span>${esc(L[1])}</span>` : '') : '';
    line.className = 'locline' + (L && L[0] === 'triangle-alert' ? ' warn' : '');
    line.setAttribute('aria-label', L ? (L[1] || L[2]) : '위치 고르기');
    line.hidden = !L;                                     // 판정이 됐으면 홈의 탭 요소는 오브·입력 바 2개뿐
    syncWeather();                                        // 좌표가 바뀌면 그 격자의 날씨로 배경을 다시 고른다(같은 자리면 syncWeather가 알아서 건너뛴다)
  }
  async function locate() {
    const at = param('at');                                              // 시연·테스트용: ?at=champions
    if (at && PLACES.some(p => p.key === at)) { const p = PLACES.find(x => x.key === at); setLoc({ status: 'place', key: p.key, name: p.name, zone: p.zone, lat: p.lat, lon: p.lon }); setPos(p.lat, p.lon); syncPlaces(); return; }
    const qlat = parseFloat(param('lat')), qlon = parseFloat(param('lon'));   // 시연·테스트용: ?lat=35.20&lon=126.93 (아무 좌표)
    if (!isNaN(qlat) && !isNaN(qlon)) { setLoc({ ...classify({ lat: qlat, lon: qlon }), lat: qlat, lon: qlon }); setPos(qlat, qlon); syncPlaces(); return; }
    const dp = devPos();                                                 // 개발자 모드 고정 위치(내 정보 > 개발자 모드 > 내 위치 고정)
    if (dp) { state.loc.manual = true; setLoc({ status: 'manual', key: dp.key, name: dp.name, zone: dp.zone, lat: dp.lat, lon: dp.lon }); setPos(dp.lat, dp.lon, true); syncPlaces(); return; }
    try { const pos = await readPosition(); if (state.loc.manual) return; setLoc({ ...classify(pos), lat: pos.lat, lon: pos.lon }); syncPlaces(); }
    catch (e) { console.warn('geo fail', e && (e.message || e.code || e)); if (!state.loc.manual) setLoc({ status: 'failed', key: null, name: '광주', zone: null }); }
  }
  // ---------- 1c. 위치 감시 · 진행 판정 (설계 §3) — 좌표는 전부 기기 안에서만 쓴다. 서버 호출(/places 등)은 기존 그대로 ----------
  const fixedLoc = () => {   // 시연 재현성: ?at=·?lat&lon·개발자 모드 고정 위치가 있으면 그 값이 현재 위치고 watch는 켜지 않는다
    if (devPos()) return true;
    const at = param('at');
    if (at && PLACES.some(p => p.key === at)) return true;
    const qlat = parseFloat(param('lat')), qlon = parseFloat(param('lon'));
    return !isNaN(qlat) && !isNaN(qlon);
  };
  let watchId = null, watchPlugin = null, wantWatch = false, myPos = null;
  async function startWatch() {                              // 앱이 앞에 있을 때만. 플러그인이 있으면 그것, 없으면 브라우저 API
    if (fixedLoc()) return;
    wantWatch = true; if (watchId !== null) return;
    const G = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Geolocation;
    try {
      if (G && G.watchPosition) { watchPlugin = G; watchId = await G.watchPosition(WATCH_OPT, (p, err) => { if (err || !p || !p.coords) return; setPos(p.coords.latitude, p.coords.longitude); }); }
      else if (navigator.geolocation) { watchPlugin = null; watchId = navigator.geolocation.watchPosition(p => setPos(p.coords.latitude, p.coords.longitude), e => console.warn('watch fail', e && (e.message || e.code)), WATCH_OPT); }
    } catch (e) { console.warn('watch start fail', e && e.message); watchId = null; return; }
    if (!wantWatch) stopWatch();                             // 기다리는 사이 화면이 가려졌으면 바로 해제
  }
  function stopWatch() {
    wantWatch = false; if (watchId === null) return;
    try { if (watchPlugin) watchPlugin.clearWatch({ id: watchId }); else navigator.geolocation.clearWatch(watchId); } catch (e) { console.warn('watch stop fail', e && e.message); }
    watchId = null; watchPlugin = null;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopWatch(); else startWatch(); });
  if (CapApp && CapApp.addListener) {                        // 안드로이드 백그라운드 전환
    CapApp.addListener('appStateChange', (st) => { if (st && st.isActive) { startWatch(); syncWeather(true); } else stopWatch(); });   // 앱으로 돌아오면 날씨를 그 자리에서 다시 본다
    CapApp.addListener('pause', stopWatch); CapApp.addListener('resume', () => { startWatch(); syncWeather(true); });
  }
  function setPos(lat, lon, force) {                         // 좌표 한 건(감시 · 시연 고정값 · ?debug=1의 __itda.setPos). force는 고정값을 넣을 때만
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!force && devPos()) return;                          // 개발자 모드로 위치를 고정해 뒀으면 실제 GPS는 무시한다(시연 재현성)
    myPos = { lat, lon }; syncProgress(); syncMapCtl();
    if (navMode && cur === 'scrMapFull' && window.ItdaMap && ItdaMap.centerOn) ItdaMap.centerOn(MAP_FULL, myPos);   // 경로안내 중에는 내 위치를 따라간다
  }
  /* 진행 순서 = state.plan.slots에서 좌표가 있는 채운 칸(화면에 보이는 순서 그대로) */
  function progressOrder() {
    const pl = state.plan; if (!pl || !Array.isArray(pl.slots)) return [];
    return pl.slots.filter(s => s && s.place && !s.skipped && Number.isFinite(s.place.lat) && Number.isFinite(s.place.lon))
      .map(s => ({ id: String(s.id), pos: { lat: s.place.lat, lon: s.place.lon } }));
  }
  const progressSig = () => { const q = progressOrder(); return q.length ? q.map(x => x.id).join('|') : null; };   // 저장분과 맞춰 볼 일정 서명
  const prState = () => state.progress || (state.progress = { atId: null, nextId: null, visited: [] });
  function saveProgress() {
    const sig = progressSig(), pr = prState();
    try {
      if (!sig || (!pr.atId && !pr.visited.length)) { localStorage.removeItem(PROGRESS_KEY); return; }
      localStorage.setItem(PROGRESS_KEY, JSON.stringify({ v: 1, day: todayStr(), sig, atId: pr.atId, nextId: pr.nextId, visited: pr.visited }));
    } catch (e) { /* 저장 못 해도 판정은 메모리로 돈다 */ }
  }
  function loadProgress() {                                  // 당일 + 같은 일정(칸 순서 서명)일 때만 복원
    let d = null; try { d = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || d.v !== 1 || d.day !== todayStr()) { try { localStorage.removeItem(PROGRESS_KEY); } catch (e) {} return false; }
    const sig = progressSig(); if (!sig || d.sig !== sig) return false;
    state.progress = { atId: d.atId ? String(d.atId) : null, nextId: d.nextId ? String(d.nextId) : null, visited: Array.isArray(d.visited) ? d.visited.map(String) : [] };
    return true;
  }
  let progressSigSeen = null;
  function ensureProgress() {                                // 일정이 (다시) 만들어졌으면 저장분을 한 번 맞춰 보고, 없으면 첫 칸을 '다음'으로
    const sig = progressSig(); if (!sig || progressSigSeen === sig) return;
    progressSigSeen = sig;
    if (!loadProgress()) state.progress = { atId: null, nextId: progressOrder()[0].id, visited: [] };
  }
  // 일정이 새로 생겼을 수도, 좌표가 새로 들어왔을 수도 있다 — 둘을 한 번에 맞춘다(판정이 안 바뀌면 아무 일도 안 일어난다)
  function syncProgress() { ensureProgress(); if (myPos) updateProgress(myPos); }
  /* 판정: 진행 순서대로 거리를 재서 '여기'(들어감 80m·나감 150m)와 '다음'을 정한다. 바뀌었을 때만 화면에 알린다 */
  function updateProgress(pos) {
    const seq = progressOrder(); if (!seq.length || !pos) return false;
    const pr = prState(), before = JSON.stringify([pr.atId, pr.nextId, pr.visited]);
    const ids = seq.map(x => x.id);
    let at = null;
    const now = pr.atId ? seq.find(x => x.id === pr.atId) : null;
    if (now && distM(pos, now.pos) <= HERE_OUT_M) at = now.id;              // 이미 '여기'인 칸은 150m까지 유지
    if (!at) { let bd = HERE_IN_M; for (const q of seq) { const d = distM(pos, q.pos); if (d <= bd) { bd = d; at = q.id; } } }   // 새로 들어오는 건 80m
    pr.atId = at;
    if (at && pr.visited.indexOf(at) < 0) pr.visited.push(at);
    pr.visited = pr.visited.filter(id => ids.indexOf(id) >= 0);
    let i = at ? ids.indexOf(at) : -1;                                      // '다음' = 여기 다음 칸, 여기가 없으면 마지막으로 다녀온 칸의 다음 칸
    if (i < 0) for (const v of pr.visited) { const k = ids.indexOf(v); if (k > i) i = k; }
    pr.nextId = i + 1 < ids.length ? ids[i + 1] : null;                     // 어느 칸도 방문 전이면 i = -1 → 첫 칸
    if (JSON.stringify([pr.atId, pr.nextId, pr.visited]) === before) return false;
    saveProgress(); onProgressChange(); return true;
  }
  function onProgressChange() {                              // 판정이 바뀌었을 때만 다시 그린다(GPS 한 건마다 지도를 다시 그리지 않는다)
    if (cur === 'scrPlan' && window.ItdaPlanUI && ItdaPlanUI.applyProgress) ItdaPlanUI.applyProgress(true);
    else if (cur === 'scrHome') renderHomePlan();
    else if (cur === 'scrMapFull') drawMap('mapFullCanvas', Object.assign({}, fullMapOpts(), { keepView: true }));
  }
  function slotById(id) { const pl = state.plan; return id && pl && Array.isArray(pl.slots) ? pl.slots.find(s => s && String(s.id) === String(id)) || null : null; }
  const herePlaceId = () => { const sl = slotById(prState().atId); return sl && sl.place ? sl.place.id : null; };   // 지도에서 살짝 키울 '여기' 마커(장소 id)
  function nextName() {                                      // 홈 위젯 2줄째 — 진행 중일 때만 '다음: …'
    const pr = prState(); if (!pr.atId && !pr.visited.length) return null;
    const sl = slotById(pr.nextId); return sl ? (sl.name || (sl.place && sl.place.name) || null) : null;
  }
  // 최근 고른 동네(localStorage itda.dongs, 최대 5): [{name, lat, lon, zone, key}]
  function recentDongs() { try { const l = JSON.parse(localStorage.getItem(DONGS_KEY) || '[]'); return Array.isArray(l) ? l.filter(x => x && typeof x.name === 'string').slice(0, DONGS_MAX) : []; } catch (e) { return []; } }
  function pushDong(d) { if (!d || !d.name) return; const l = [d, ...recentDongs().filter(x => x.name !== d.name)].slice(0, DONGS_MAX); try { localStorage.setItem(DONGS_KEY, JSON.stringify(l)); } catch (e) {} }
  function renderLocDongs() {                                            // #locPickDongs: 현재 동네(서버 near.dong) + 최근 동네(기존 7곳과 겹치면 제외)
    const w = $('locPickDongs'); if (!w) return;
    const items = [];
    if (state.nearDong && state.loc.lat) items.push({ name: state.nearDong, lat: state.loc.lat, lon: state.loc.lon, zone: state.loc.zone || null, key: null });
    for (const d of recentDongs()) if (d.name !== state.nearDong && !PLACES.some(p => p.name === d.name) && typeof d.lat === 'number') items.push({ ...d });
    w.innerHTML = items.map((i, k) => `<button class="choice" data-dong="${esc(i.name)}" data-k="${k}">${IC('map-pin', 'ic-l')}<span>${esc(i.name)}</span></button>`).join('');
    w.hidden = !items.length; w._items = items;
  }
  const markDest = (v) => $('destChoices').querySelectorAll('.choice').forEach(x => x.classList.toggle('sel', x.dataset.v === v));   // v가 null이면 전부 해제
  function openLocPick() { renderLocDongs(); $('locPick').classList.add('on'); }
  function afterLocChange() {
    $('locPick').classList.remove('on');
    state.plan = null; state.planAi = null;   // 출발 위치가 바뀌면 일정은 다시 짠다 — 위치가 바뀌면 AI도 다시 부른다(설계 §6). 편집은 유지
    if (cur === 'scrConfirm') { state.editing = 'done'; renderConfirm(); } if (cur === 'scrPlan') ItdaPlanUI.render(); if (cur === 'scrMe') renderMe();
  }
  $('locLine').addEventListener('click', openLocPick);
  if (HAS_PILL) bindPill(); else $('homeWhere').addEventListener('click', openLocPick);   // 구 마크업: 질문 줄 자체를 눌러도 고를 수 있게
  $('locPick').addEventListener('click', (e) => {                        // 위임: 동 버튼은 열 때마다 새로 그려지므로
    const b = e.target.closest('.choice'); if (!b || !$('locPick').contains(b)) return;
    if (b.id === 'btnLocGps') { state.loc.manual = false; devSetPos(null); setLoc({ status: 'pending', key: null, name: '광주', zone: null }); $('locPick').classList.remove('on'); locate(); return; }
    state.loc.manual = true;
    if (b.dataset.dong !== undefined) {
      const it = ($('locPickDongs')._items || [])[+b.dataset.k]; if (!it) return;
      state.dong = it.name; setLoc({ status: 'manual', key: it.key || null, name: it.name, zone: it.zone || null, lat: it.lat, lon: it.lon }); pushDong({ name: it.name, lat: it.lat, lon: it.lon, zone: it.zone || null, key: it.key || null }); devPin(it); syncPlaces();
      afterLocChange(); return;
    }
    const p = PLACES.find(x => x.key === b.dataset.v);
    if (p) { setLoc({ status: 'manual', key: p.key, name: p.name, zone: p.zone, lat: p.lat, lon: p.lon }); pushDong({ name: p.name, lat: p.lat, lon: p.lon, zone: p.zone, key: p.key }); devPin(p); syncPlaces(); }
    else setLoc({ status: 'manual', key: null, name: '광주', zone: null });
    afterLocChange();
  });
  $('locPickClose').addEventListener('click', () => $('locPick').classList.remove('on'));

  // ---------- 1b. 음성 입력 (speech.js: 폰의 음성 인식 → 글자 → 조건) ----------
  const voice = { on: false, fails: 0, ctl: null, hintT: null, askT: null, gotText: false, sid: 0, holding: false, pendingStop: false, holdAt: 0 };
  const textIn = { fails: 0 };
  function voiceUI(mode, text) {                         // mode: idle | listening | heard | hint
    const orb = $('orb');
    orb.classList.toggle('listening', mode === 'listening' || mode === 'heard');
    if (mode === 'idle') { setLoc({}); $('homeQ2').textContent = '뭘 하다 가실래요?'; $('heard').textContent = ''; $('orbLabel').textContent = '말하기'; return; }
    if (mode === 'listening') { $('orbLabel').textContent = '듣고 있어요'; $('heard').textContent = ''; }   // 질문 줄은 그대로 둔다 — 글자가 바뀌면 줄 수가 달라져 오브가 움직인다
    if (mode === 'heard') { $('heard').textContent = text; }
    if (mode === 'hint') { setLoc({}); $('homeQ2').innerHTML = IC('mic') + '<span>다시 말씀해 주세요</span>'; $('orbLabel').textContent = '말하기'; orb.classList.remove('listening'); }   // 재시도 힌트는 오류 상태에서만
  }
  function clearVoiceTimers() { clearTimeout(voice.hintT); clearTimeout(voice.askT); }
  function toAsk(msg) { clearVoiceTimers(); voice.on = false; voiceUI('idle'); if (msg) toast(msg, 3000); goStepwise(); }
  // '하나씩 고를게요' 진입점(홈 #btnStepwise · 글 시트 #btnTextPick · 음성 실패): 시민은 할 일부터, 여행객은 차편부터. 시간 휠은 '직접 고를게요'와 '변경'에서만.
  function goStepwise() { state.editing = null; state.askPrefs = null; if (state.who === 'citizen') go('scrAskTime'); else go($('scrTrainPick') ? 'scrTrainPick' : 'scrAskTime'); }   // 시민도 '몇 시까지'는 묻는다(시각 없이 둘러보기 링크로 건너뛸 수 있음). 직접 고르기로 오면 말로 지정한 취향은 버린다
  const bs = $('btnStepwise'); if (bs) bs.addEventListener('click', guard(goStepwise));
  async function startListening() {
    if (voice.on) return;                                // 누른 채 말하기: 시작은 누를 때 한 번만
    if (!window.ItdaSpeech) return toAsk('말하기가 안 되는 폰이에요. 하나씩 여쭤볼게요.');
    const okAvail = await ItdaSpeech.available();
    if (!okAvail) return toAsk('이 폰은 말하기가 안 돼요. 하나씩 여쭤볼게요.');
    const okPerm = await ItdaSpeech.ensurePermission();
    if (!okPerm) return toAsk('마이크를 허용하지 않아 글로 여쭤볼게요.');
    voice.on = true; voice.gotText = false; voiceUI('listening'); const sid = ++voice.sid;
    try { speechSynthesis && speechSynthesis.cancel(); } catch {}
    clearVoiceTimers();
    voice.hintT = setTimeout(() => {                     // 5초 무음 → 안내(화면+소리), 3초 더 무음 → 질문 화면
      if (!voice.on || voice.gotText) return;
      voiceUI('hint'); speak('괜찮아요. 동그라미를 누른 채로, 평소 말하듯 하시면 돼요. 예를 들어 일곱 시 반 기차인데 밥 먹고 싶어요, 하시고 손을 떼시면 돼요. 말하기 어려우시면 제가 하나씩 여쭤볼게요.');
      voice.askT = setTimeout(() => { if (voice.on && !voice.gotText) { if (voice.ctl) voice.ctl.stop(); toAsk(); } }, MS.voiceGiveUp);
    }, MS.voiceHint);
    voice.ctl = await ItdaSpeech.listen({
      maxMs: MS.voiceMax,
      onPartial: (t) => { if (sid !== voice.sid) return; voice.gotText = true; clearVoiceTimers(); voiceUI('heard', t); },
      onEnd: (t) => { if (sid !== voice.sid) return; voice.on = false; clearVoiceTimers(); if (t) applyHeard(t); else voiceFail('못 들었어요. 한 번만 다시 말씀해 주세요.'); },
      onError: (e) => { if (sid !== voice.sid) return; voice.on = false; clearVoiceTimers(); console.warn('stt', e); const m = String(e); voiceFail(/network/i.test(m) ? '통신이 안 돼 듣지 못했어요.' : (/no match|timeout|no speech/i.test(m) ? '아무 말도 못 들었어요. 동그라미를 누른 채 말씀하세요.' : '제가 잘못 들었어요. 한 번만 다시 말씀해 주세요.')); },
    });
    if (sid === voice.sid && (voice.pendingStop || !voice.holding)) { voice.pendingStop = false; try { voice.ctl.stop(); } catch (e) {} }   // 인식기가 열리기 전에 손을 뗀 경우
  }
  function voiceFail(msg) {                                // 몇 번을 못 알아들어도 홈에 머문다 — 자동으로 '직접 고르기'로 넘기지 않는다(대표 지시 2026-09-04)
    voice.fails++;
    voiceUI('hint'); speak(msg);   // 긴 설명문은 듣기(TTS) 데이터로만 남기고 화면에는 안 쓴다(기준 §1)
  }
  // 말·글에서 찾은 출발 동네를 위치로 삼는다(위치 시트에서 고른 것과 같은 처리). 목록에 없는 이름이면 GPS 위치를 그대로 둔다.
  function setHeardOrigin(key) {
    const p = PLACES.find(x => x.key === key); if (!p) return;
    state.loc.manual = true; state.dong = p.name;
    setLoc({ status: 'manual', key: p.key, name: p.name, zone: p.zone, lat: p.lat, lon: p.lon });
    pushDong({ name: p.name, lat: p.lat, lon: p.lon, zone: p.zone, key: p.key }); devPin(p);
    state.plan = null; state.planAi = null;                      // 출발 위치가 바뀌면 일정은 다시 짠다(afterLocChange와 같은 규칙)
    syncPlaces();
  }
  async function applyHeard(text) {
    $('homeQ2').textContent = '알아듣는 중…';
    const g = await ItdaSpeech.parseSmart(text, nowMin(), SERVER, NET_MS.nlu);
    state.heardSource = g.source;
    voice.fails = 0;
    const heardIntents = Array.isArray(g.intents) && g.intents.length ? g.intents : (g.intent ? [g.intent] : []);   // speech.js가 배열을 주면 그대로, 아니면 1개
    if (g.hour !== null || g.dest || heardIntents.length || g.at) {       // 새로 말한 건 새 요청: 이전 답은 지우고 들은 것만 채운다
      state.hour = null; state.minute = null; state.touchedTime = false; state.dest = null; setIntents([]); state.train = null; state.trainManual = false; state.card = null; state.planAi = null;
      state.askPrefs = null;                                     // 지난 요청에서 말한 '양식'이 이번 요청에 남지 않게
      markDest(null);
    }
    // 말한 음식·카페 종류는 이번 요청에만 쓴다 — 내 정보(itda.prefs.v1)는 건드리지 않는다
    if (g.food) { state.askPrefs = { food: g.food }; state.plan = null; }
    if (g.hour !== null) { state.hour = g.hour; state.minute = g.minute; state.touchedTime = true; }
    if (g.dest) { state.dest = g.dest; markDest(g.dest); }
    if (g.at) setHeardOrigin(g.at);                              // '동명동에서 놀 곳' — 말한 동네를 출발지로 (GPS 자리보다 우선)
    if (heardIntents.length) setIntents(heardIntents);
    state.lastHeard = text;
    voiceUI('idle');
    if (g.hour === null && !g.dest && !g.intent && !g.at && !g.food) {
      if (state.inputMode === 'text') { textFail(`"${text}"에서 시각·타는 곳·할 일을 못 찾았어요. 예처럼 써 주세요.`); return; }
      voiceFail(`"${text}"라고 들었는데 시각·타는 곳·할 일을 못 찾았어요. 다시 말씀해 주세요.`); return;
    }
    if (state.inputMode === 'text') { textIn.fails = 0; $('textIn').value = ''; closeTextSheet(); }
    speak('이렇게 이해했어요. 맞나요?');
    state.editing = null; go('scrConfirm');
  }
  // 누른 채 말하기(push-to-talk): 누르면 듣기 시작, 손을 떼면 그 자리에서 인식 종료
  const orbEl = $('orb');
  function cancelListening() { voice.sid++; voice.on = false; voice.pendingStop = false; clearVoiceTimers(); if (voice.ctl) { try { voice.ctl.stop(); } catch (e) {} } voice.ctl = null; }
  function holdStart(e) {
    if (voice.holding) return;
    if (e && e.pointerId != null && orbEl.setPointerCapture) { try { orbEl.setPointerCapture(e.pointerId); } catch (err) {} }
    voice.holding = true; voice.pendingStop = false; voice.holdAt = Date.now();
    orbEl.classList.add('holding');
    startListening();
  }
  function holdEnd() {
    if (!voice.holding) return;
    voice.holding = false; orbEl.classList.remove('holding');
    if (Date.now() - voice.holdAt < MS.holdMin && !voice.gotText) {   // 실수로 톡 친 경우: 조용히 되돌리고 방법만 알린다
      cancelListening(); voiceUI('hint'); speak('동그라미를 누른 채로 말씀하시고, 끝나면 손을 떼세요.'); return;
    }
    if (voice.ctl) { try { voice.ctl.stop(); } catch (e) {} } else voice.pendingStop = true;
  }
  orbEl.addEventListener('pointerdown', (e) => { e.preventDefault(); holdStart(e); });
  orbEl.addEventListener('pointerup', holdEnd);
  orbEl.addEventListener('pointercancel', holdEnd);
  orbEl.addEventListener('click', (e) => e.preventDefault());
  orbEl.addEventListener('contextmenu', (e) => e.preventDefault());
  orbEl.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdStart(); } });   // 키보드·토크백도 누르는 동안 듣기
  orbEl.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); holdEnd(); } });
  orbEl.addEventListener('blur', holdEnd);
  // ---------- 1c. 글로 쓰기 (음성과 같은 applyHeard 경로) ----------
  function openTextSheet() {
    if (voice.on) { voice.sid++; if (voice.ctl) voice.ctl.stop(); voice.on = false; clearVoiceTimers(); voiceUI('idle'); }
    try { speechSynthesis.cancel(); } catch (e) {}
    $('textHint').innerHTML = ''; $('btnTextSend').disabled = false; $('btnTextPick').classList.remove('hot');
    $('textSheet').classList.add('on'); setTimeout(() => { try { $('textIn').focus(); } catch (e) {} }, MS.focus);
  }
  function closeTextSheet() { $('textSheet').classList.remove('on'); try { $('textIn').blur(); } catch (e) {} }
  async function submitText() {
    const text = $('textIn').value.replace(/\s+/g, ' ').trim();
    if (!text) { $('textHint').innerHTML = BADGE('pencil', '한 줄만 써 주세요'); return; }
    if (text.length > TEXT_MAX) { $('textHint').innerHTML = BADGE('triangle-alert', '200자 안으로', 'warn'); return; }
    $('btnTextSend').disabled = true; $('textHint').innerHTML = BADGE('clock', '알아듣는 중');
    state.inputMode = 'text';
    try { await applyHeard(text); } finally { $('btnTextSend').disabled = false; }
  }
  function textFail(msg) {                                // 글 입력 실패: 문장은 남기고 힌트만. 2회째부터 '하나씩 고를게요' 링크를 강조(자동 전환은 안 함 — 쓴 글이 사라지면 당황)
    textIn.fails++;
    $('textHint').innerHTML = BADGE('circle-help', textIn.fails >= 2 ? '아래에서 직접 고르기' : '다시 써 주세요');   // 원문(msg)은 TTS·로그용으로만 남긴다
    $('btnTextPick').classList.toggle('hot', textIn.fails >= 2); voiceUI('idle');
    try { $('textIn').focus(); } catch (e) {}
  }
  $('inbar').addEventListener('click', guard(openTextSheet));
  $('btnTextSend').addEventListener('click', () => submitText());
  $('btnTextClose').addEventListener('click', closeTextSheet);
  $('btnTextPick').addEventListener('click', guard(() => { closeTextSheet(); goStepwise(); }));
  $('textIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitText(); } });
  $('textIn').addEventListener('beforeinput', (e) => { if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); submitText(); } });   // 삼성 키보드는 keydown이 229로만 올 때가 있음
  $('textIn').addEventListener('input', () => { if ($('textIn').value.length >= TEXT_MAX) $('textHint').innerHTML = BADGE('triangle-alert', '200자까지', 'warn'); });
  if (window.visualViewport) {                          // 키보드가 뜨면 시트를 그만큼 올린다(WebView adjustPan 대비)
    const vv = window.visualViewport;
    const onVV = () => { const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)); document.documentElement.style.setProperty('--kb', kb + 'px'); };
    vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV);
  }
  document.querySelectorAll('.lnk-voice').forEach(b => b.addEventListener('click', guard(() => { goReplace('scrHome'); setTimeout(startListening, 200); })));   // 질문 화면의 '말로 할게요' → 홈에서 듣기
  (async () => { try { if (window.ItdaSpeech && (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SpeechRecognition)) await ItdaSpeech.ensurePermission(); } catch {} })();   // 앱 시작 시 마이크 권한 미리(첫 탭 폴백 회피)

  // ---------- 2. 시간 휠 (알람 설정식: 위아래로 넘기기, 숫자 탭, ▲▼ 한 칸) ----------
  const ROW = 64, ROWS = 5, PAD = ROW * Math.floor(ROWS / 2);
  let wheelsReady = false;
  function buildWheel(el, n, fmt) {
    el.innerHTML = `<div class="pad" style="height:${PAD}px"></div>` + Array.from({ length: n }, (_, i) => `<div class="it${i % 5 === 0 ? ' five' : ''}" data-i="${i}">${fmt(i)}</div>`).join('') + `<div class="pad" style="height:${PAD}px"></div>`;
    el.querySelectorAll('.it').forEach(it => it.addEventListener('click', () => wheelSet(el, +it.dataset.i, true)));
  }
  function wheelIndex(el) { return Math.max(0, Math.min(el.querySelectorAll('.it').length - 1, Math.round(el.scrollTop / ROW))); }
  function markSel(el, i) { el.querySelectorAll('.it').forEach((it, k) => it.classList.toggle('sel', k === i)); }
  function wheelSet(el, i, smooth) { el.scrollTo({ top: i * ROW, behavior: smooth ? 'smooth' : 'auto' }); markSel(el, i); commitWheel(el, i); }
  // 시간 휠 확정. 화면을 떠나면 브라우저가 숨겨진 휠의 scrollTop을 0으로 되돌리며 scroll을 한 번 더 쏜다 —
  // 그때 0시로 확정돼 일정이 '오전 12시까지'가 되던 버그(2026-09-04 실측). 이 화면일 때만 반영한다.
  function commitWheel(el, i) {
    if (cur !== 'scrAskTime') return;
    if (Math.abs(el.scrollTop - i * ROW) > 1) el.scrollTop = i * ROW;   /* 칸 경계에 딱 맞춤 */
    if (el.id === 'wheelH') state.hour = i; else state.minute = i;
    state.touchedTime = true; updateTimeHint();
  }
  function initWheels() {
    const H = $('wheelH'), M = $('wheelM');
    if (!wheelsReady) {
      buildWheel(H, 24, i => `${i}`); buildWheel(M, 60, i => String(i).padStart(2, '0'));
      let tH, tM;
      H.addEventListener('scroll', () => { const i = wheelIndex(H); markSel(H, i); clearTimeout(tH); tH = setTimeout(() => commitWheel(H, i), MS.wheelCommit); });
      M.addEventListener('scroll', () => { const i = wheelIndex(M); markSel(M, i); clearTimeout(tM); tM = setTimeout(() => commitWheel(M, i), MS.wheelCommit); });
      document.querySelectorAll('[data-wheel]').forEach(b => b.addEventListener('click', () => { const el = $(b.dataset.wheel); const n = el.querySelectorAll('.it').length; const i = Math.max(0, Math.min(n - 1, wheelIndex(el) + (+b.dataset.d))); wheelSet(el, i, true); }));
      wheelsReady = true;
    }
    const firstTime = state.hour === null;
    if (firstTime) { const nm = nowMin(); state.hour = Math.min(23, Math.floor(nm / 60) + 3); state.minute = 30; }   // ?now= 시연 시각도 따른다
    const place = () => { H.scrollTop = state.hour * ROW; M.scrollTop = state.minute * ROW; markSel(H, state.hour); markSel(M, state.minute); };
    place(); requestAnimationFrame(() => requestAnimationFrame(place));   // 레이아웃 뒤 한 번 더 정렬
    if (firstTime) state.touchedTime = false;
    updateTimeHint();
  }
  function updateTimeHint() {
    const el = $('timeHint');
    const citizenT = state.who === 'citizen';
    { const q = document.querySelector('#scrAskTime .q'); if (q) q.innerHTML = citizenT ? '몇 시까지<br>시간 있으세요?' : '몇 시 차로<br>가세요?'; const nt = $('btnNoTime'); if (nt) nt.hidden = !citizenT; }
    el.innerHTML = state.touchedTime ? IC('check') + `<span>${esc(kor(state.hour * 60 + state.minute))}${citizenT ? '까지' : ' 차'}</span>` : '';
    el.classList.toggle('picked', state.touchedTime);
  }
  $('btnTimeNext').addEventListener('click', guard(() => { state.touchedTime = true; if (state.editing === 'time') returnToConfirm(); else go(state.who === 'citizen' ? 'scrAskDo' : 'scrAskDest'); }));   // 시민은 타는 곳을 안 묻는다
  { const nt = $('btnNoTime'); if (nt) nt.addEventListener('click', guard(() => { state.hour = null; state.minute = null; state.touchedTime = false; if (state.editing === 'time') returnToConfirm(); else go('scrAskDo'); })); }

  // ---------- 3. 교통편 / 할 일 ----------
  function bindChoices(wrapId, key, next) {
    $(wrapId).querySelectorAll('.choice').forEach(b => b.addEventListener('click', guard(() => {
      state[key] = b.dataset.v;
      $(wrapId).querySelectorAll('.choice').forEach(x => x.classList.toggle('sel', x === b));
      setTimeout(() => { if (state.editing) returnToConfirm(); else go(next); }, MS.pick);
    })));
  }
  bindChoices('destChoices', 'dest', 'scrAskDo');
  // 할 일: v3는 `.choice.multi` 토글(aria-pressed) + '선택 완료'(#btnDoNext). H1 마크업이 아직 단일(.multi 없음)이면 예전처럼 한 번 탭 = 바로 다음.
  function doDone() { if (!state.intents.length) return; if (state.editing) returnToConfirm(); else go('scrConfirm'); }
  $('doChoices').querySelectorAll('.choice').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.v;
    if (b.classList.contains('multi')) { setIntents(state.intents.includes(v) ? state.intents.filter(x => x !== v) : [...state.intents, v]); return; }
    if (navigating) return; navigating = true; setTimeout(() => { navigating = false; }, MS.guard);
    setIntents([v]); setTimeout(doDone, MS.pick);
  }));
  { const bn = $('btnDoNext'); if (bn) bn.addEventListener('click', guard(doDone)); }

  // ---------- 3b. 돌아갈 차편 (#scrTrainPick, 서버 /trains — 출발 시간표만, 잔여석 없음) ----------
  let trainFrom = 'songjeong', trainSeq = 0;
  const hm = (m) => `${String(Math.floor(norm(m) / 60)).padStart(2, '0')}:${String(norm(m) % 60).padStart(2, '0')}`;
  const HHMM = /^\d{1,2}:\d{2}$/;
  // 지난 차를 빼고, 같은 시각·행선지가 두 줄로 오면 등급이 붙은 쪽만 남긴다(계약: 거르는 건 앱 몫).
  function tidyTrains(raw, now) {
    const tidy = (g) => (g || '').replace(/-산천|\s*\([A-Z]-type\)/g, '').trim();
    const seen = new Map();
    raw.filter(x => x && HHMM.test(x.dep || '') && t2m(x.dep) >= now).forEach(x => {
      const k = `${x.dep}|${x.to || ''}`, g = tidy(x.grade), cur = seen.get(k);
      if (!cur || (g && g !== '미확인' && (!tidy(cur.grade) || tidy(cur.grade) === '미확인'))) seen.set(k, Object.assign({}, x, { grade: g }));
    });
    return [...seen.values()].sort((a, b) => t2m(a.dep) - t2m(b.dep));
  }
  function trainRowHtml(x, icon) {
    const sub = esc([x.to ? x.to + '행' : '', x.grade && x.grade !== '미확인' ? x.grade : ''].filter(Boolean).join(' · '));
    const arr = x.arr && HHMM.test(x.arr) ? ` · ${kor(t2m(x.arr))} 도착` : '';
    return `<button class="train-row" data-dep="${esc(x.dep)}" data-arr="${esc(x.arr || '')}" data-to="${esc(x.to || '')}" data-grade="${esc(x.grade || '')}"><b class="num">${kor(t2m(x.dep))}</b><span>${IC(icon, 'ic-s')}${sub}${arr}</span></button>`;
  }
  async function loadTrains(from) {
    const list = $('trainList'), note = $('trainNote'), manual = $('btnTrainManual'); if (!list || !note) return;
    const seq = ++trainSeq; trainFrom = from;
    document.querySelectorAll('#tpTabs .cat').forEach(x => x.classList.toggle('on', x.dataset.from === from));
    list.innerHTML = ''; note.innerHTML = BADGE('clock', '받는 중'); if (manual) manual.hidden = false;
    const fail = (msg) => { if (seq !== trainSeq) return; list.innerHTML = ''; note.innerHTML = BADGE('triangle-alert', msg, 'warn'); if (manual) manual.hidden = false; };
    try {
      const d = await getJson(`${SERVER}/trains?from=${encodeURIComponent(from)}`, NET_MS.trains);
      if (seq !== trainSeq) return;
      if (!d || !d.ok || !Array.isArray(d.rows)) return fail('시간표 못 받음');
      const now = nowMin();
      const rows = tidyTrains(d.rows, now);
      if (!rows.length) return fail(d.rows.length ? '오늘 남은 차 없음' : '시간표 못 받음');
      const tIc = trainFrom === 'terminal' ? 'bus-front' : 'train-front';
      list.innerHTML = rows.map(x => trainRowHtml(x, tIc)).join('');
      const fm = /T(\d{2}):(\d{2})/.exec(d.fetched_at || '');
      note.innerHTML = BADGE('clock', `${fm ? kor(+fm[1] * 60 + +fm[2]) + ' ' : ''}시간표`) + BADGE('circle-help', '잔여석 미확인') + (now < DAY_START ? BADGE('triangle-alert', `첫차 ${kor(t2m(rows[0].dep))}`, 'warn') : '');
    } catch (e) { fail('시간표 못 받음'); }
  }
  function pickTrain(b) {
    const dep = b.dataset.dep; if (!HHMM.test(dep)) return;
    state.train = { from: trainFrom, dep, arr: b.dataset.arr || null, to: b.dataset.to || null, grade: b.dataset.grade || null };
    const [h, m] = dep.split(':').map(Number); state.hour = h; state.minute = m; state.touchedTime = true;
    state.dest = trainFrom; markDest(state.dest);
    $('trainList').querySelectorAll('.train-row').forEach(x => x.classList.toggle('sel', x === b));
    setTimeout(() => { if (state.editing) returnToConfirm(); else go('scrAskDo'); }, MS.pick);
  }
  { const tl = $('trainList'); if (tl) tl.addEventListener('click', guard((e) => { const b = e.target.closest('.train-row'); if (b) pickTrain(b); })); }
  document.querySelectorAll('#tpTabs .cat').forEach(b => b.addEventListener('click', () => loadTrains(b.dataset.from)));
  { const bm = $('btnTrainManual'); if (bm) bm.addEventListener('click', guard(() => {   // 시간표에 없는 차 → 시간 휠. 탭이 가리키는 곳을 타는 곳으로 미리 둔다(뒤에서 바꿀 수 있음)
    state.train = null; state.trainManual = true; if (!state.dest) state.dest = trainFrom;
    if (state.editing) goReplace('scrAskTime'); else go('scrAskTime');   // '변경'으로 들어온 경우 차편 화면을 히스토리에서 빼야 returnToConfirm(한 칸 뒤)이 확인 화면에 닿는다
  })); }

  // ---------- 4. 확인 ----------
  function renderConfirm() {
    const t = state.hour !== null ? kor(state.hour * 60 + state.minute) : null;
    const d = state.dest ? DESTS[state.dest] : null;
    const kind = d ? d.kind : '차';
    const citizen = state.who === 'citizen';
    if (!state.dest) state.dest = 'none';                            // 안 정했으면 '정한 곳 없음'. 시민은 아예 안 묻고, 여행객도 강요하지 않는다(2026-09-04 대표 지시)
    const tr = state.train && state.train.dep === hm(state.hour * 60 + (state.minute || 0)) ? state.train : null;
    $('cfTime').innerHTML = t
      ? (citizen ? `<strong>${t}</strong>까지` : `<strong>${t}</strong> ${kind}${tr ? ` <small>${esc([tr.to ? tr.to + '행' : '', tr.grade && tr.grade !== '미확인' ? tr.grade : ''].filter(Boolean).join(' · '))}</small>` : ''}`)
      : '<strong>둘러보기</strong>';
    $('cfDest').innerHTML = d ? `<strong>${esc(d.name)}</strong>` : '<span class="dim">아직 못 정했어요</span>';
    { const di = $('cfRowDest') && $('cfRowDest').querySelector('.c-ic'); if (di) di.innerHTML = `<use href="#i-${state.dest === 'terminal' ? 'bus-front' : state.dest === 'none' ? 'circle-minus' : 'train-front'}"></use>`; }
    $('cfRowDest').hidden = citizen || state.hour === null;          // 시각이 없으면 타는 곳은 계산에 안 쓰인다(computeCard가 null) — 안 보여준다
    const names = state.intents.map(k => INTENTS[k]).filter(Boolean);
    $('cfDo').innerHTML = names.length ? `<strong>${names.join(' · ')}</strong>` : '<span class="dim">아직 못 정했어요</span>';
    { const di = $('cfDoIc'); if (di) di.innerHTML = state.intents.map(k => IC(CAT_IC[k] || 'sparkles')).join(''); }   // 할 일 아이콘 나열(기준 §4)
    $('cfFrom').innerHTML = state.loc.key ? `<strong>${esc(state.loc.name)}</strong>` : (state.loc.lat && state.loc.status !== 'outside' ? `<strong>${esc(state.dong || '지금 위치')}</strong>` : '<span class="dim">아직 못 정했어요</span>');
    const dep = state.hour !== null ? state.hour * 60 + state.minute : null;
    // 서술문 4줄은 삭제. 남기는 건 (a) 파생 값 1개 (b) 막힌 이유(예외)뿐 — 기준 §4 + 판단2.
    let note = '';
    if (t && d && state.dest !== 'none' && !citizen) {              // 시민에겐 타는 곳 줄이 없다 — 숨긴 줄을 근거로 문구를 내지 않는다
      const dead = dep - state.buffer;
      note = dead < 0 ? BADGE('triangle-alert', '자정 넘는 차 계산 못 함', 'warn') : BADGE('clock', `${kor(dead)}까지 ${d.name}`);
    }
    if (dep !== null && dep < nowMin()) note += BADGE('triangle-alert', '이미 지난 시각', 'warn');
    if (!citizen && state.hour === null) note += BADGE('train-front', '차 시간을 넣으면 나갈 시각도 알려드려요');   // 안 넣어도 된다 — 기능이 안 보이게 되지만 않게 한 줄
    $('cfNote').innerHTML = note;
    const noStation = citizen || !state.dest || state.dest === 'none';   // 역에 갈 일이 없으면 '역 도착 여유'는 보이지 않는다
    $('cfBuf').hidden = noStation; $('buf30').parentElement.hidden = noStation;
    $('cfBuf').innerHTML = IC('clock', 'ic-s') + '<span>역 여유</span>';
    $('buf30').classList.toggle('on', state.buffer === BUFFERS[0]); $('buf45').classList.toggle('on', state.buffer === BUFFERS[1]);
    const ok = state.intents.length > 0;                             // 시각·타는 곳이 없으면 '둘러보기'로 짠다 — 여행객에게도 강요하지 않는다
    $('btnGo').innerHTML = IC('check') + (ok ? '이대로 짜기' : '빠진 것부터');
    if (state.editing === 'done' && state.editKey) { const row = $(state.editKey); if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), MS.flash); } }
    state.editing = null;
  }
  document.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', guard(() => {
    const k = b.dataset.edit;
    if (k === 'from') { state.editKey = 'cfRowFrom'; openLocPick(); return; }
    state.editing = k; state.editKey = { time: 'cfRowTime', dest: 'cfRowDest', intent: 'cfRowDo' }[k];
    if (k === 'time' && state.who !== 'citizen' && $('scrTrainPick')) { go('scrTrainPick'); return; }   // 여행객의 '시각' = 돌아갈 차편. 목록에서 고르면 타는 곳도 함께 정해진다
    go({ time: 'scrAskTime', dest: 'scrAskDest', intent: 'scrAskDo' }[k]);
  })));
  $('buf30').addEventListener('click', () => { state.buffer = BUFFERS[0]; renderConfirm(); });
  $('buf45').addEventListener('click', () => { state.buffer = BUFFERS[1]; renderConfirm(); });
  $('btnGo').addEventListener('click', guard(() => {
    if (!state.dest) state.dest = 'none';                            // 시각·타는 곳은 없어도 짠다(둘러보기). 되묻는 건 할 일 하나뿐
    if (!state.intents.length) { state.editing = 'intent'; state.editKey = 'cfRowDo'; go('scrAskDo'); return; }
    state.planAi = null;   // 새 생성(할 일·시각·취향·위치) — AI를 다시 부른다(설계 §6)
    buildAndGo();
  }));
  $('btnRestart').addEventListener('click', guard(restart));

  // ---------- 5. 결과: 돌아가는 길 카드 (청사진 §4.3 역산을 앱에서) ----------
  const depsToday = (row) => { const day = new Date().getDay(); return (day === 0 || day === 6) ? row.weekend : row.weekday; };   // 주말·평일 시간표 고르기
  const depsRange = (deps) => `${kor(t2m(deps[0]))}~${kor(t2m(deps[deps.length - 1]))}`;
  function computeCard() {
    if (state.hour === null) return null;
    if (state.dest === 'none') return { noDest: true };
    const zone = zoneOf();
    const row = zone && state.dest ? CORRIDORS[`${zone}|${state.dest}`] : null;
    if (!row) return null;
    const dep = state.hour * 60 + state.minute, deadline = dep - state.buffer;
    if (deadline < 0 || dep < DAY_START) return { none: true, code: 'past_midnight', reason: '자정을 넘는 차는 아직 계산 못 해요.' };
    const deps = depsToday(row);
    const ok = deps.filter(d => t2m(d) + row.ride <= deadline);
    if (ok.length < 2) return { none: true, code: 'no_train', reason: `저희가 확인한 열차는 ${depsRange(deps)}뿐이에요. 이 시각엔 맞는 차가 없어요.` };
    if (ok.length === deps.length) return { none: true, code: 'beyond_table', reason: `저희가 확인한 열차는 ${depsRange(deps)}뿐이에요. 그 뒤 차는 광주교통공사 앱이나 역에서 확인해 주세요.` };   // 표 범위 밖은 추측하지 않는다
    const board = t2m(ok[ok.length - 2]);
    const arrive = board + row.ride, slack = dep - arrive;
    const raw = board - row.walk_max - row.buffer, leave = raw - raw % LEAVE_ROUND;
    return { hub: row.hub, hubPos: row.hubPos, line: row.line, dir: row.dir, board, arrive, slack, leave, confidence: row.confidence, zone };
  }
  async function cancelAlarm() { const LN = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications; if (!LN) return; try { await LN.cancel({ notifications: [{ id: ALARM_ID.pre }, { id: ALARM_ID.at }] }); } catch (e) {} }
  function tableRange() { const row = CORRIDORS['충장로|songjeong']; return row ? depsRange(depsToday(row)) : '확인한 시간대'; }
  // 나갈 시각 알람(폰 로컬 알림, 서버 불필요): 10분 전 + 정각. 시연용 가짜 시각(?now=)이면 안 잡는다.
  async function scheduleAlarm(c, body) {   // body(선택): 일정 화면이 넘기는 exitSentence — 있으면 두 알림의 본문을 그 문장으로(제목은 그대로)
    const LN = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications; if (!LN) return;
    if (param('now')) return;
    try {
      let st = await LN.checkPermissions(); if (st.display !== 'granted') st = await LN.requestPermissions();
      if (st.display !== 'granted') { toast('알림 허용 안 됨', 3500, 'bell'); return; }
      try { const ex = await LN.checkExactNotificationSetting(); if (ex && ex.exact_alarm !== 'granted' && !localStorage.getItem('exactAsked')) { localStorage.setItem('exactAsked', '1'); await LN.changeExactNotificationSetting(); } } catch (e) { /* 12 미만은 없음 */ }
      await cancelAlarm();
      const now = new Date(), base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const at = (min) => new Date(base.getTime() + min * 60000);
      const where = c.taxi ? `${c.dest}까지 택시로 ${c.ride}분` : `${c.hub}에서 ${c.line} ${c.dir} 방향 ${kor(c.board)} 차`;
      const list = [];
      if (at(c.leave - 10) > now) list.push({ id: ALARM_ID.pre, title: '10분 뒤에 나가세요', body: body || `${kor(c.leave)}에 나가면 돼요 · ${where}`, schedule: { at: at(c.leave - 10), allowWhileIdle: true } });
      if (at(c.leave) > now) list.push({ id: ALARM_ID.at, title: '지금 나가세요', body: body || where, schedule: { at: at(c.leave), allowWhileIdle: true } });
      if (list.length) { await LN.schedule({ notifications: list }); toast(list.length === 2 ? `${kor(c.leave - 10)}과 ${kor(c.leave)}에 알려드릴게요` : `${kor(c.leave)}에 알려드릴게요`); }
      else toast('이미 지난 시각', 3500, 'bell');
    } catch (e) { console.warn('alarm fail', e && e.message); }
  }
  async function fetchTaxiCard() {
    if (state.hour === null || !state.dest || state.dest === 'none' || !state.loc.lat) return null;
    const dep = `${String(state.hour).padStart(2, '0')}:${String(state.minute).padStart(2, '0')}`;
    const zone = zoneOf() || '';
    try {
      const d = await getJson(`${SERVER}/leave_by?lat=${state.loc.lat}&lon=${state.loc.lon}&dest=${state.dest}&train_dep=${dep}&buffer=${state.buffer}${zone ? '&zone=' + encodeURIComponent(zone) : ''}`, NET_MS.taxi);
      if (!d || !d.ok || d.mode !== 'taxi') return null;
      return { taxi: true, leave: t2m(d.leave_by), arriveBy: t2m(d.station_arrive_by), ride: d.ride_min, nav: d.nav_min, fare: d.taxi_fare, dist: d.distance_m, dest: d.dest, confidence: '택시 기준(카카오 길찾기)', note: d.policy_note, corridorReason: d.corridor_reason || null };
    } catch (e) { return null; }
  }
  let resultSeq = 0;
  const STALE = Symbol('stale');   // 기다리는 동안 더 새 요청이 시작되면 이 화면은 그리지 않는다
  // 카드 정하기: 회랑 → (못 풀면) 택시 기준. 택시는 서버를 기다리므로 그동안 '계산 중' 얼굴을 먼저 띄운다.
  async function resolveCard(seq) {
    let c = computeCard();
    if (state.loc.status === 'outside' && state.hour !== null && state.dest && state.dest !== 'none') return { none: true, outside: true, reason: '지금은 광주 밖이에요. 광주에 오시면 계산해요.' };
    const noneCode = c && c.none ? c.code : null;
    if ((!c || c.none) && state.dest && state.dest !== 'none' && state.hour !== null) {
      state.cardPending = true;   // 화면은 #scrBuilding(또는 일정 요약의 '계산 중')이 맡는다
      const tc = await fetchTaxiCard();
      state.cardPending = false;
      if (seq !== resultSeq) return STALE;
      if (tc) { tc.corridorReason = tc.corridorReason || noneCode; c = tc; }
    }
    return c;
  }
  // 지도·안내 화면 위에 같이 붙는 한 줄 요약
  function miniLine(c, dep) {
    if (state.hour === null && state.loc.lat) return '시각 없음 · 주변 둘러보기';
    if (c && c.taxi) return `${kor(c.leave)} 택시 · ${c.dest} ${kor(c.arriveBy)}까지`;
    if (c && !c.none && !c.noDest) return `${kor(c.leave)} 나가기 · ${kor(c.board)} ${c.hub}`;
    if (c && c.noDest) return `${kor(dep)}까지 시간만 봐요`;
    return '돌아가는 길을 확인 못 했어요';
  }
  // 카드가 정해지면 딸려 나오는 것들(화면 없음): 알람 · 지도/안내 화면의 한 줄 요약
  function applyCard(c, dep) {
    if (c && !c.none && !c.noDest && c.leave !== undefined) scheduleAlarm(c);
    else cancelAlarm();   // 정한 곳 없음·확인 못 했으면 이전 알람도 지운다
    const mini = miniLine(c, dep);
    { const m = $('mfCard'); if (m) m.textContent = mini; }
    { const d = $('dTop'); if (d) d.textContent = mini; }
  }
  /* 듣기(TTS)가 읽는 첫 문장 — 화면에는 안 쓰고 데이터로만 남긴다(기준 §1).
   * 일정 화면의 '듣기'가 이 문장 뒤에 ItdaPlan.exitSentence를 붙여 읽는다. */
  function slotText() {
    return state.hour === null ? '오늘 둘러볼 곳을 짜 드렸어요. 영업 여부는 확인 못 했어요.'
      : (state.who === 'citizen' || state.dest === 'none') ? '정하신 시각 안에 들어가는 일정이에요. 영업 여부는 확인 못 했어요.'
      : '나갈 시각 안에 들어가는 일정이에요. 영업 여부는 확인 못 했어요.';
  }
  /* ---------- 5a. 일정 짜기: 확인 → 짜는 중(#scrBuilding) → 일정(#scrPlan) — 설계 §1·§6
   * 돌아가는 길 카드 계산 → 규칙 엔진 후보로 POST /plan/ai(4초) → generate(prefs·tasteMap·ai) → 일정.
   * AI가 실패·404·서버 없음이면 조용히 규칙 엔진 결과로 간다(토스트 없음 — 이유 줄만 빠진다). */
  async function fetchPlanAi(seq) {
    if (!window.ItdaPlanUI || typeof ItdaPlanUI.aiRequest !== 'function') return null;
    let body = null;
    try { body = await ItdaPlanUI.aiRequest(); } catch (e) { console.warn('ai request fail', e && e.message); return null; }   // 후보를 보도 거리로 다시 재느라 비동기다(§4)
    if (!body || !Array.isArray(body.slots) || !body.slots.length) return null;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), NET_MS.planAi);
    try {
      const r = await fetch(SERVER + '/plan/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      if (!r.ok) return null;                                   // 404(서버에 아직 없음)도 조용한 폴백
      const d = await r.json();
      if (seq !== resultSeq || !d || !d.ok || !Array.isArray(d.picks)) return null;
      const picks = {}, why = {};
      for (const q of d.picks) {
        if (!q || typeof q.placeId !== 'string') continue;
        picks[String(q.slotId)] = q.placeId;
        if (q.why) why[String(q.slotId)] = String(q.why);
      }
      if (!Object.keys(picks).length) return null;
      console.log('plan ai', Object.keys(picks).length + '칸', d.cost_krw !== undefined ? d.cost_krw + '원' : '');
      return { picks, why, order: Array.isArray(d.order) && d.order.length ? d.order.slice() : null, note: d.note || '' };
    } catch (e) { return null; }                                // 시간 초과·통신 끊김
    finally { clearTimeout(t); }
  }
  // 확인 CTA·저장분 복원 공통 경로. opts.ai가 넘어오면 그걸 쓰고 재호출하지 않는다(복원 — 설계 §6)
  async function buildAndGo(opts) {
    opts = opts || {};
    const seq = ++resultSeq, t0 = Date.now();
    go('scrBuilding');
    const c = await resolveCard(seq);
    if (c === STALE || seq !== resultSeq) return;
    state.card = c; state.plan = null;
    applyCard(c, state.hour !== null ? state.hour * 60 + state.minute : null);
    state.planAi = opts.ai !== undefined ? opts.ai : await fetchPlanAi(seq);
    if (seq !== resultSeq) return;
    state.plan = null;
    const wait = Math.max(0, BUILD_MIN_MS - (Date.now() - t0));
    if (wait) await new Promise(r => setTimeout(r, wait));
    if (seq !== resultSeq || cur !== 'scrBuilding') return;      // 기다리는 사이 사용자가 나갔으면 화면을 뺏지 않는다
    goReplace('scrPlan');                                        // 뒤로 = 확인 화면(짜는 중은 히스토리에 안 남긴다)
  }
  // 일정 화면 '다시 짜기'가 부른다 — AI만 다시 받는다(설계 §6). 실패하면 규칙 엔진 결과 그대로.
  async function refreshPlanAi() {
    const seq = ++resultSeq;
    const ai = await fetchPlanAi(seq);
    if (seq !== resultSeq || !ai) return false;
    state.planAi = ai; state.plan = null;
    if (cur === 'scrPlan') ItdaPlanUI.render();
    return true;
  }

  // ---------- 5b. 지도 기본 층 (map.js) ----------
  function mapCtx() {
    const c = state.card;
    const zone = zoneOf();
    const inb = INBOUND[`${state.loc.key}|${zone}`];
    const row = zone ? CORRIDORS[`${zone}|songjeong`] : null;
    return {
      now: nowMin(), origin: { lat: state.loc.lat, lon: state.loc.lon, zone: state.loc.zone, key: state.loc.key }, zone,
      hub: c && c.hubPos ? c.hubPos : (row ? row.hubPos : null),
      board: c && !c.none && !c.noDest ? c.board : null,
      inbound: inb ? { walk: inb.walk, wait: inb.wait, ride: inb.ride, alight: inb.alightPos } : null,
      zoneCenter: ZONE_CENTER[zone] || (state.loc.lat ? { lat: state.loc.lat, lon: state.loc.lon } : ZONE_CENTER['충장로']), companion: 'senior',
      taxiLeave: c && c.taxi ? c.leave : null,
      deadline: c && c.noDest && state.hour !== null ? state.hour * 60 + state.minute : null,   // 타는 곳 미정: 정한 시각까지만
      freeMode: state.hour === null && !!state.loc.lat,                                            // 시각도 없음: 주변 둘러보기
    };
  }
  // 일정 → 지도 표시(기술설계 §5-5): state.plan(§1.3 계약)만 읽는다. plan-ui 함수는 부르지 않는다.
  function planMarkers() {
    const pl = state.plan; if (!pl || !Array.isArray(pl.slots)) return [];
    let k = 0;
    return pl.slots.filter(s => s && s.place && !s.skipped && typeof s.place.lat === 'number')
      .map(s => { k++; return { p: s.place, n: s.n !== null && s.n !== undefined ? s.n : k, fixed: !!s.fixed, tight: !!s.tight }; });   // n이 없는 구판 plan이면 순번으로
  }
  function planHubPos() { const ex = state.plan && state.plan.exit; return ex && ex.hubPos && typeof ex.hubPos.lat === 'number' ? ex.hubPos : null; }
  /* 일정을 구간으로 나눈다(설계 지도경로_GPS강조_2026-09-04 §2).
   * 시작→칸1 · 칸i→칸i+1 · 마지막 칸→탑승 정류장 = walk / 탑승→역 = bus(카드에 노선id가 있으면 route=) / 택시 폴백이면 마지막 칸→역 = taxi */
  function planLegs() {
    const pl = state.plan;
    const start = (pl && posOf(pl.startPos)) || (state.loc.lat ? { lat: state.loc.lat, lon: state.loc.lon } : null);
    const seq = []; if (start) seq.push(start);
    planMarkers().forEach(m => { const q = posOf(m.p); if (q) seq.push(q); });
    const legs = [];
    for (let i = 0; i + 1 < seq.length; i++) legs.push({ mode: 'walk', pts: [seq[i], seq[i + 1]] });
    const last = seq[seq.length - 1] || null, hp = planHubPos(), dest = destPos();
    const taxi = !!(state.card && state.card.taxi) || !!(pl && pl.exit && pl.exit.mode === 'taxi');
    if (last && taxi) { if (dest) legs.push({ mode: 'taxi', pts: [last, dest] }); }
    else if (last && hp) {
      legs.push({ mode: 'walk', pts: [last, hp] });
      if (dest) legs.push({ mode: 'bus', pts: [hp, dest], route: routeIdOf() });   // 회랑(지하철·버스) 구간 — 노선을 모르면 두 점 사이 도로 형상만
    }
    return legs.filter(l => l.pts[0].lat !== l.pts[1].lat || l.pts[0].lon !== l.pts[1].lon);
  }
  const posOf = (q) => (q && typeof q.lat === 'number' && typeof q.lon === 'number' && !isNaN(q.lat) && !isNaN(q.lon) ? { lat: q.lat, lon: q.lon } : null);
  const destPos = () => { const p = PLACES.find(x => x.key === state.dest); return p ? posOf(p) : null; };   // 돌아갈 역·터미널('정한 곳 없음'이면 null)
  const routeIdOf = () => { const c = state.card, v = c && (c.routeId || c.route_id || c.routeid); return v ? String(v) : null; };
  const r4 = (v) => v.toFixed(4);   // 캐시 키·질의 좌표는 4자리(약 11m) — 서버 캐시와 같은 자릿수
  const ptsQ = (pts) => pts.map(p => `${r4(p.lat)},${r4(p.lon)}`).join(';');
  const legKey = (l) => `${l.mode}|${ptsQ(l.pts)}${l.route ? '|' + l.route : ''}`;
  const legsKeyOf = (legs) => legs.map(legKey).join('||');
  const straightLegs = (legs) => legs.map(l => ({ mode: l.mode, coords: l.pts.slice(), ok: false }));
  const ROUTE_CACHE = new Map();   // 구간 키 → {mode, coords, ok} — 같은 일정이면 다시 부르지 않는다(실패도 담는다)
  let legsKey = null, legsDone = null, legsWait = null;   // 마지막으로 조회한 일정 서명 · 그 결과 · 진행 중인 조회
  // 구간 하나의 도로 형상. 서버가 없거나 4초를 넘기면 그 구간만 직선 두 점 — 없는 길을 지어내지 않는다.
  async function fetchLeg(l) {
    const key = legKey(l);
    const hit = ROUTE_CACHE.get(key); if (hit) return hit;
    const straight = { mode: l.mode, coords: l.pts.slice(), ok: false };
    let out = straight;
    try {
      const d = await getJson(`${SERVER}/route?mode=${l.mode}&pts=${ptsQ(l.pts)}${l.route ? '&route=' + encodeURIComponent(l.route) : ''}`, NET_MS.route);
      if (d && d.ok && Array.isArray(d.coords)) {
        const coords = d.coords.filter(c => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number').map(c => ({ lat: c[0], lon: c[1] }));
        if (coords.length >= 2) out = { mode: l.mode, coords, ok: true };
      }
    } catch (e) { /* 서버 없음·시간 초과: 직선 폴백 */ }
    ROUTE_CACHE.set(key, out);
    return out;
  }
  // 지금 그릴 경로: 이 일정으로 받아 둔 구간이 있으면 그것, 없으면 직선(먼저 그리고 도착하면 다시 그린다)
  function currentLegs() {
    const legs = planLegs(); if (!legs.length) return null;
    return legsDone && legsKeyOf(legs) === legsKey ? legsDone : straightLegs(legs);
  }
  // 구간을 받아 둔다. 같은 일정으로 이미 받았으면 아무 것도 안 한다. 반환: 그림이 바뀌면 true
  function loadLegs() {
    const legs = planLegs(); if (!legs.length) return Promise.resolve(false);
    const key = legsKeyOf(legs);
    if (key === legsKey && legsDone) return Promise.resolve(false);
    if (key === legsKey && legsWait) return legsWait;
    legsKey = key; legsDone = null;
    legsWait = Promise.all(legs.map(fetchLeg)).then(res => {
      if (legsKey !== key) return false;                       // 기다리는 동안 일정이 바뀌었으면 버린다
      legsDone = res; legsWait = null;
      return res.some(r => r.ok);                              // 전부 직선이면 다시 그릴 이유가 없다
    }, () => { legsWait = null; return false; });
    return legsWait;
  }
  // route 옵션을 구간 배열로 승격(일정 탭 썸네일처럼 좌표 배열을 넘기는 호출부 포함). 이미 구간 배열이거나 일정이 없으면 그대로.
  function withLegs(opts) {
    if (!opts || !Array.isArray(opts.route) || !opts.route.length) return opts;
    if (opts.route[0] && Array.isArray(opts.route[0].coords)) return opts;
    const legs = currentLegs();
    return legs ? Object.assign({}, opts, { route: legs }) : opts;
  }
  let walkRoute = null;   // '가는 길'로 그린 도보 선 {id, coords} — 필터 전환·다시 그리기에도 남는다
  const fullMapOpts = () => { const hp = planHubPos(); return { preview: false, numbered: planMarkers(), route: walkRoute ? [{ mode: 'walk', coords: walkRoute.coords }] : currentLegs(), hub: hp ? { pos: hp, label: '역' } : null }; };
  // 지금 위치 점·'여기' 마커를 어느 지도에나 얹는다(호출부가 안 넘겨도) — GPS 강조(설계 §3)
  function withHere(opts) {
    syncProgress();
    const hid = herePlaceId();
    if (!myPos && !hid) return opts;
    return Object.assign({}, opts || {}, { me: (opts && opts.me) || myPos, hereId: opts && opts.hereId !== undefined ? opts.hereId : hid });
  }
  let mapCat = null;
  async function drawMap(id, opts) {   // 반환: 성공 시 counts, 실패 시 null(plan-ui가 미니 지도를 숨길지 판단할 수 있게). 예외는 밖으로 안 던진다.
    if (!window.ItdaMap || !window.PLACES_DATA) return null;
    try {
      const ctx = mapCtx();
      const legsWaiting = opts && opts.route ? loadLegs() : null;   // 지도가 뜨는 동안 도로 형상을 받아 둔다(지도 SDK가 실패해도 조회는 남는다)
      const counts = await ItdaMap.render(id, ctx, Object.assign({ category: mapCat, onTap: showPlace, onCluster: showCluster }, withHere(withLegs(opts))));
      if (legsWaiting) legsWaiting.then(changed => {   // 먼저 직선으로 그려 두고, 도로 형상이 도착하면 그 지도만 다시 그린다
        if (changed && document.getElementById(id)) drawMap(id, id === 'mapFullCanvas' ? Object.assign({}, opts, { keepView: true }) : opts);
      });
      if (id === 'mapFullCanvas') {   // planMapCanvas(일정 미니 지도)는 전체 지도의 집계 줄을 건드리지 않는다
        $('mfCount').innerHTML = BADGE('circle-help', `${mapCat ? (ItdaMap.CAT_KO[mapCat] || '') + ' ' : ''}${counts.total}곳`);
      }
      return counts;
    } catch (e) { console.warn('map fail', e && e.message); return null; }
  }
  function showPlace(p, j) {
    if (walkRoute && walkRoute.id !== String(p.id)) { walkRoute = null; drawMap('mapFullCanvas', Object.assign({}, fullMapOpts(), { keepView: true })); }   // 다른 가게를 누르면 앞서 그린 도보 선은 지운다
    state.sheetPlace = p;
    $('mfList').hidden = true;
    const sh = $('mfSheet'); sh.hidden = false;
    $('mfName').textContent = p.name; $('mfSub').textContent = `· ${ItdaMap.CAT_KO[p.category] || ''}${p.sub ? ' · ' + p.sub : ''}`;
    $('mfWalk').innerHTML = j.taxi ? IC('car-taxi-front', 'ic-s') + `<span>택시 ${state.card && state.card.ride ? state.card.ride + '분' : ''}</span>` : (j.toHub !== undefined ? IC('footprints', 'ic-s') + `<span>역까지 ${j.toHub}분</span>` : '');
    $('mfOpen').innerHTML = BADGE('circle-help', '영업 미확인'); $('mfOpen').setAttribute('aria-label', '영업 여부 확인 안 됨');
    $('mfLeave').innerHTML = j.free ? IC('clock', 'ic-s') + '<span>시간 제한 없음</span>' : (j.state === 'ok' && typeof j.leaveBy === 'number' ? IC('clock', 'ic-s') + `<span>${esc(ItdaMap.fmt(j.leaveBy))} 나가기${j.tight ? ' · 빠듯' : ''}</span>` : (j.state === 'late' ? IC('triangle-alert', 'ic-s') + `<span>${esc(j.why)}</span>` : ''));   // 판정은 색이 아니라 여기서만 문장으로
    $('mfGo').hidden = false;
    syncMapCtl();
  }
  document.querySelectorAll('#cats .cat').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#cats .cat').forEach(x => x.classList.toggle('on', x === b));
    mapCat = b.dataset.cat === 'all' ? null : b.dataset.cat; $('mfSheet').hidden = true; $('mfList').hidden = true; syncMapCtl(); drawMap('mapFullCanvas', { ...fullMapOpts(), keepView: true });
  }));
  $('mfSheetClose').addEventListener('click', () => { $('mfSheet').hidden = true; syncMapCtl(); if (walkRoute) { walkRoute = null; drawMap('mapFullCanvas', Object.assign({}, fullMapOpts(), { keepView: true })); } });
  /* 지도 조작 버튼(2026-09-04 대표 지시): 확대·축소·내 위치. SDK 호출은 map.js 안에만 있다 */
  const MAP_FULL = 'mapFullCanvas';
  const ZOOM_NEAR = 17;                                     // 내 위치로 갈 때 최소한 이만큼은 당겨서 본다(네이버는 zoom이 클수록 확대 — map.js ZOOM_FULL과 같은 값)
  function syncMapCtl() {
    const ctl = $('mfCtl'); if (!ctl) return;
    ctl.hidden = !$('mfList').hidden;              // 묶음 목록은 화면을 반쯤 덮는다 — 그 위로 버튼을 올리면 위쪽 칩과 겹치므로 목록을 보는 동안엔 감춘다
    const sh = $('mfSheet').hidden ? null : $('mfSheet');   // 가게 시트가 열렸으면 그 위로 비킨다
    const open = !!sh;
    ctl.style.setProperty('--mf-sheet-h', open ? sh.offsetHeight + 'px' : '0px');
    ctl.classList.toggle('up', !!open);
    const lb = $('mfLocate'); if (lb) lb.classList.toggle('on', !!myPos);
  }
  const zoomMap = (d) => { if (window.ItdaMap && ItdaMap.zoomBy) ItdaMap.zoomBy(MAP_FULL, d); };
  $('mfZoomIn').addEventListener('click', () => zoomMap(1));
  $('mfZoomOut').addEventListener('click', () => zoomMap(-1));
  async function goMyPos() {                                // 표적 버튼: 지금 위치로 지도를 되돌린다. 위치를 모르면 한 번 더 잡아 보고, 그래도 없으면 직접 고르기
    const btn = $('mfLocate');
    let pos = walkOrigin();
    if (!pos) { btn.disabled = true; try { await locate(); } catch (e) { console.warn('locate fail', e && e.message); } btn.disabled = false; pos = walkOrigin(); }
    if (!pos) { toast('지금 계신 곳을 못 찾았어요', 3500, 'map-pin'); openLocPick(); return; }
    const z = window.ItdaMap && ItdaMap.zoomOf ? ItdaMap.zoomOf(MAP_FULL) : null;
    if (!ItdaMap.centerOn(MAP_FULL, pos, z !== null && z < ZOOM_NEAR ? ZOOM_NEAR : undefined)) drawMap(MAP_FULL, fullMapOpts());
    syncMapCtl();
  }
  $('mfLocate').addEventListener('click', goMyPos);
  $('mfNorth').addEventListener('click', () => { if (window.ItdaMap && ItdaMap.resetNorth) ItdaMap.resetNorth(MAP_FULL); });
  /* 묶음 점 탭 → 그 안의 가게 목록(가까운 순). 한 줄을 고르면 기존 가게 시트로 넘어간다 */
  const CLUSTER_ROWS = 40;                                  // 한 번에 그리는 줄 수 — 수백 줄을 한꺼번에 만들면 그것대로 버벅인다
  let clusterList = [];
  function showCluster(ps) {
    if (!Array.isArray(ps) || !ps.length) return;
    const from = walkOrigin();
    clusterList = ps.slice().sort((a, b) => {
      const da = from ? ItdaMap.distM(from, a) : null, db = from ? ItdaMap.distM(from, b) : null;
      return (da === null ? Infinity : da) - (db === null ? Infinity : db);
    });
    $('mfSheet').hidden = true;
    $('mfListN').textContent = `이 근처 ${ps.length}곳`;
    $('mfListRows').innerHTML = clusterList.slice(0, CLUSTER_ROWS).map((p, i) => {
      const w = from ? ItdaMap.walkMin(from, p) : null;
      const sub = `${ItdaMap.CAT_KO[p.category] || ''}${w === null ? '' : ` · 걸어서 ${w}분`}`;
      return `<button class="mfl-row" type="button" data-i="${i}"><span class="mfl-nm">${esc(p.name)}</span><span class="mfl-sub">${esc(sub)}</span></button>`;
    }).join('');
    if (clusterList.length > CLUSTER_ROWS) $('mfListRows').insertAdjacentHTML('beforeend',
      `<div class="mfl-more">가까운 ${CLUSTER_ROWS}곳만 보여드려요 · 지도를 크게 하면 나뉘어요</div>`);   // 수백 줄을 다 그리면 목록 자체가 버벅인다
    $('mfList').hidden = false;
    syncMapCtl();
  }
  $('mfListRows').addEventListener('click', (e) => {
    const row = e.target.closest('.mfl-row'); if (!row) return;
    const p = clusterList[Number(row.dataset.i)];
    if (p) { $('mfList').hidden = true; showPlace(p, ItdaMap.judge(p, mapCtx())); }
  });
  $('mfListClose').addEventListener('click', () => { $('mfList').hidden = true; syncMapCtl(); });
  $(MAP_FULL).addEventListener('itda:rotation', (e) => {   // 지도를 돌렸을 때만 '북쪽으로' 버튼이 나온다(안 돌렸으면 버튼이 하나 줄어든다)
    const deg = e.detail && e.detail.deg ? Math.abs(e.detail.deg) : 0;
    $('mfNorth').hidden = deg < 1;
  });
  // 네이버지도로 연다(키 불필요). 폰에 네이버지도 앱이 있으면 nmap:// 스킴으로 열고, 없으면 웹 지도로 떨어진다.
  function openUrl(u) { if (CapApp && CapApp.openUrl) CapApp.openUrl({ url: u }).catch(() => window.open(u, '_blank')); else window.open(u, '_blank'); }
  /* 지역 사장 → 사장님 화면(/store). 같은 서버(server/owner.py)가 서빙한다.
     방문객 성격(itda.who)은 건드리지 않는다 — 사장님은 이 앱의 페르소나가 아니라 다른 화면의 사용자다.
     앱에서는 기본 브라우저로 나간다(Capacitor App.openUrl) — 인앱 브라우저 플러그인은 아직 없다. */
  /* 앱 안에서 연다. 밖으로 내보내면(App.openUrl·window.open) Capacitor WebView가 주소를 못 넘겨
     'null 사이트에 접근할 수 없습니다'로 떨어진다[실측 2026-09-04 실기기]. store.html은 APK에 함께 들어 있고,
     ?server= 로 API 주소를 넘기면(store.js resolveServer) 서버가 어디에 있든 같은 화면이 뜬다.
     돌아오기는 안드로이드 뒤로가기 또는 사장님 화면 좌상단 '앱으로'. */
  function openOwner() {
    toast('사장님 화면을 엽니다', 1600, 'store');
    const u = 'store.html?from=app&server=' + encodeURIComponent(SERVER);
    setTimeout(() => { location.href = u; }, 260);
  }
  const NM_APP = 'kr.beginnova.itda';                                                    // nmap:// 은 appname 이 필수다
  const nWeb = (name) => `https://map.naver.com/p/search/${encodeURIComponent(name)}`;    // 앱이 없을 때 갈 곳
  function openNm(scheme, name) { if (CapApp && CapApp.openUrl) CapApp.openUrl({ url: scheme }).catch(() => window.open(nWeb(name), '_blank')); else window.open(nWeb(name), '_blank'); }
  // 이름만 보내면 네이버가 같은 상호의 다른 지점(첨단점 등)을 고를 수 있어 동 이름을 붙인다[실측 9.3 올데이우동]. 동은 서버 장소의 행정동, 없으면 권역 이름.
  const openNaverPlace = (name, lat, lon, dong) => { const q = dong ? `${name} ${dong}` : name; openNm(`nmap://place?lat=${lat}&lng=${lon}&name=${encodeURIComponent(q)}&appname=${NM_APP}`, q); };
  function openNaverRoute(name, lat, lon) {                                              // 출발지는 아는 경우에만 넣는다(없으면 네이버지도가 현위치를 쓴다)
    const s = state.loc && state.loc.lat ? `slat=${state.loc.lat}&slng=${state.loc.lon}&sname=${encodeURIComponent(state.loc.name || '지금 위치')}&` : '';
    openNm(`nmap://route/public?${s}dlat=${lat}&dlng=${lon}&dname=${encodeURIComponent(name)}&appname=${NM_APP}`, name);
  }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.max(10, Math.round(m / 10) * 10) + 'm');
  function walkOrigin() { return myPos || (state.loc && state.loc.lat ? { lat: state.loc.lat, lon: state.loc.lon } : null); }
  /* 도보 길: 내 위치 → 가게를 지도에 긋고 분·거리를 시트에 쓴다(네이버로 넘기지 않는다).
   * 서버가 닿고 TMAP 보행자 경로(source=tmap_pedestrian)가 오면 그 길 그대로, 아니면 직선.
   * 시간은 두 경우 모두 어르신 걸음(45m/분)으로 우리가 계산한다 — 어느 기준인지 화면에 밝힌다.
   * 카카오 길찾기(자동차)는 도보 시간으로 쓰지 않는다: 직선 480m 구간을 1,240m로 준다[실측 2026-09-04]. */
  const WALK_MPM = 45;                                        // 분당 걷는 거리(m) — map.js WALK.speed.senior와 같은 값
  async function drawWalkTo(p) {
    const from = walkOrigin();
    if (!from) { toast('지금 계신 곳을 먼저 알려주세요', 3500, 'map-pin'); openLocPick(); return; }
    const straight = ItdaMap.distM(from, p);
    let coords = [[from.lat, from.lon], [p.lat, p.lon]], dist = straight === null ? null : Math.round(straight * 1.2), road = false;
    const paint = () => { walkRoute = { id: String(p.id), coords }; drawMap('mapFullCanvas', fullMapOpts()); };
    const line = () => $('mfWalk').innerHTML = (dist === null)
      ? IC('circle-help', 'ic-s') + '<span>거리를 확인 못 했어요</span>'
      : IC('footprints', 'ic-s') + `<span>걸어서 ${Math.max(1, Math.ceil(dist / WALK_MPM))}분 · ${fmtDist(dist)} · ${road ? '도로 기준' : '직선 기준'}</span>`;
    paint(); line();                                          // 먼저 직선으로 그려 두고
    try {                                                     // 보행 경로가 오면 그 길로 갈아 끼운다
      const r = await getJson(`${SERVER}/route?mode=walk&pts=${from.lat},${from.lon};${p.lat},${p.lon}`, NET_MS.route);
      if (r && r.ok && (r.source === 'tmap_pedestrian' || r.source === 'ors_foot_walking') && Array.isArray(r.coords) && r.coords.length > 1) {
        coords = r.coords; road = true;
        if (Number.isFinite(r.distance_m) && r.distance_m > 0) dist = r.distance_m;
        if (state.sheetPlace && String(state.sheetPlace.id) === String(p.id)) { paint(); line(); }   // 그 사이 다른 가게를 눌렀으면 덮지 않는다
      }
    } catch (e) { /* 서버가 없으면 직선 그대로 */ }
  }
  /* 경로안내 모드(대표 지시 2026-09-04): 팝업은 내려가고 상단 UI는 사라진다. 지도는 GPS 현재 위치에 고정.
   * 뒤로가기(하드웨어·제스처)면 상단 UI만 되살아나고 팝업은 다시 열리지 않는다 — render()가 exitNav+시트 닫기를 함께 한다. */
  let navMode = false;
  function slideDownSheet(el) {
    if (!el || el.hidden) return;
    el.classList.add('down');
    setTimeout(() => { el.hidden = true; el.classList.remove('down'); syncMapCtl(); }, MS.sheetSlide);
  }
  function exitNav() {
    if (!navMode) return;
    navMode = false;
    const sc = $('scrMapFull'); if (sc) sc.classList.remove('nav-on');
    syncMapCtl();
  }
  async function enterNav(p) {
    let pos = myPos || walkOrigin();
    if (!pos) { const b = $('mfGo'); b.disabled = true; try { await locate(); } catch (e) { console.warn('locate fail', e && e.message); } b.disabled = false; pos = myPos || walkOrigin(); }
    if (!pos) { toast('지금 계신 곳을 못 찾았어요', 3500, 'map-pin'); openLocPick(); return; }
    await drawWalkTo(p);                                     // 걷는 길을 먼저 그려 두고
    navMode = true;
    slideDownSheet($('mfSheet'));
    const sc = $('scrMapFull'); if (sc) sc.classList.add('nav-on');
    if (window.ItdaMap && ItdaMap.centerOn) ItdaMap.centerOn(MAP_FULL, pos, ZOOM_NEAR);
    history.pushState({ scr: 'scrMapFull', nav: 1 }, '', '#scrMapFull');   // 뒤로가기 한 번이면 이 모드만 빠져나온다
  }
  $('mfGo').addEventListener('click', () => { const p = state.sheetPlace; if (p) enterNav(p); });
  $('mfCall').addEventListener('click', () => toast('전화번호 미확인', 3500, 'circle-help'));
  $('mfNaver').addEventListener('click', () => { const p = state.sheetPlace; if (p) openNaverPlace(p.name, p.lat, p.lon, p.dong || p.zone); });

  // ---------- 6. 가는 길 ----------
  function steps() {
    const c = state.card, inb = INBOUND[`${state.loc.key}|${c && c.zone}`];
    const s = [];
    if (c && c.noDest) { s.push({ t: '타는 곳', s: '아직 안 정함', p: '타는 곳을 정하면 돌아가는 길을 한 단계씩 안내해 드려요.', q: '' }); return s; }
    if (inb) {
      s.push({ t: `${inb.stop}까지`, s: `걸어서 ${inb.walk}분`, p: '경기장 정문 왼쪽으로 나가세요.', q: '' });
      s.push({ t: `${inb.line} 버스`, s: inb.dir, p: '꽉 차면 다음 차를 타셔도 돼요. 늦어지는 건 밥 시간이지 기차가 아니에요.', q: '버스가 안 오면 택시를 부르거나 1330에 물어보세요.' });
      s.push({ t: `${inb.alight}에서`, s: '내리세요', p: `${c ? c.hub : ''} 방향으로 걸어가면 돼요.`, q: '' });
    } else if (c && c.taxi) {
      s.push({ t: '택시 부르기', s: `${kor(c.leave)}까지`, p: '가게에서 나와 카카오T 앱으로 부르거나, 가게에 택시를 불러 달라고 하세요.', q: '전화번호는 확인된 것만 넣어요. 아직 확인한 콜택시 번호가 없어요.' });
      s.push({ t: `${c.dest}까지`, s: `택시로 ${c.ride}분`, p: `${kor(c.arriveBy)}까지 도착하면 ${DESTS[state.dest].kind}까지 ${state.buffer}분 남아요.`, q: c.fare ? `요금 약 ${c.fare.toLocaleString()}원 (길찾기 기준)` : '' });
      return s;
    } else if (c && !c.none) {
      s.push({ t: `${c.hub}까지`, s: '걸어서 8분 안', p: `${kor(c.leave)}에는 나오세요.`, q: '' });
    } else {
      s.push({ t: '돌아가는 길', s: '확인 못 했어요', p: '이 동네의 돌아가는 길은 아직 확인 못 했어요.', q: '1330에 물어보세요.' });
    }
    if (c && !c.none) s.push({ t: `${c.line} ${c.dir} 방향`, s: `${kor(c.board)} 탑승`, p: `${c.hub}에서 ${c.dir} 방향으로 타세요.`, q: `${DESTS[state.dest].name} ${kor(c.arrive)} 도착 예정.` });
    return s;
  }
  function renderStep() {
    const s = steps(), i = Math.min(state.stepIdx, s.length - 1), st = s[i];
    $('dStep').textContent = `${i + 1}/${s.length}`;
    $('dT').textContent = st.t; $('dS').textContent = st.s; $('dP').textContent = st.p; $('dQ').textContent = st.q; $('dQ').style.display = st.q ? '' : 'none';
    $('dShow').textContent = state.card && state.card.taxi ? `${state.card.dest}까지 택시로 가 주세요.` : state.card && !state.card.none && !state.card.noDest ? `${state.card.hub} ${state.card.dir} 방향 타는 곳을 알려주세요.` : '광주송정역 가는 길을 알려주세요.';
    $('btnArrive').innerHTML = IC('check') + (i === s.length - 1 ? '다 왔어요' : '도착했어요');
  }
  $('btnArrive').addEventListener('click', guard(() => { const n = steps().length; if (state.stepIdx >= n - 1) { toast('잘 도착하셨어요', 3500, 'flag'); back(); } else { state.stepIdx++; renderStep(); } }));
  $('btnReread').addEventListener('click', () => { const t = `${$('dT').textContent} ${$('dS').textContent}. ${$('dP').textContent}`; if (!speak(t)) toast('소리 읽기 안 됨', 3500, 'volume-2'); });
  $('btnNaver').addEventListener('click', () => {
    const c = state.card; let name, pos;
    if (c && c.taxi) { const p = PLACES.find(x => x.key === state.dest); if (p) { name = p.name; pos = p; } }
    else if (c && c.hubPos) { name = c.hub; pos = c.hubPos; }
    if (!pos) { const p = PLACES.find(x => x.key === 'songjeong'); name = p.name; pos = p; }
    openNaverRoute(name, pos.lat, pos.lon);
  });


  /* ---------- 7. 취향(#scrPrefs 온보딩 · #scrMe 내 정보) — 설계 §2, 저장 키 itda.prefs.v1
   * 칩 = 픽토그램 + 한 단어. 두 화면이 같은 컴포넌트(chipsHtml/bindChips)를 쓴다. */
  const WALK_MAX_DEFAULT = 20, WALK_MAX_OPTS = [5, 10, 15, 20, 25, 30];   // 다음 장소까지 걷기 상한(분). 기본 20분 — 대표 결정 2026-09-04
  const normWalkMax = (x) => { const n = Math.round(Number(x) / 5) * 5; return WALK_MAX_OPTS.includes(n) ? n : WALK_MAX_DEFAULT; };
  const PREFS_Q = [
    { key: 'food', multi: true, q: '뭘 드실래요?', ic: 'utensils', opts: [
      ['korean', '한식', 'soup'], ['western', '양식', 'pizza'], ['japanese', '일식', 'fish'],
      ['chinese', '중식', 'utensils-crossed'], ['snack', '분식', 'sandwich'], ['any', '상관없음', 'check']] },
    { key: 'companion', multi: false, q: '누구와 가세요?', ic: 'users', opts: [
      ['senior', '어르신', 'user'], ['child', '아이', 'baby'], ['none', '보통', 'check']] },
    // 물어보는 것은 '자료로 가릴 수 있는 것'만 둔다(2026-09-04 대표 지시).
    // 지운 것: 카페 조용한·빵·전망(카페 3,501곳의 sub가 98%가 '카페' 하나 — 판별 근거 0), 계단·긴 줄(매핑표에 키조차 없음).
    { key: 'avoid', multi: true, q: '피할 것 있으세요?', ic: 'circle-minus', opts: [
      ['spicy', '매운 것', 'flame']] },
    // 다음 장소까지 걸어갈 수 있는 상한(분). 5분 단위 — 이 값이 일정 후보 반경을 정한다(ItdaPlan.generate의 maxWalk)
    { key: 'walkMax', multi: false, num: true, dflt: WALK_MAX_DEFAULT, q: '다음 장소까지 얼마나 걸으실 수 있어요?', ic: 'footprints',
      opts: WALK_MAX_OPTS.map(m => [String(m), m + '분', 'footprints']) },
  ];
  const PREFS_EMPTY = () => ({ v: 1, food: [], companion: 'none', avoid: [], walkMax: WALK_MAX_DEFAULT, updatedAt: null });
  function readPrefs() {
    let p = null; try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (e) { p = null; }
    if (!p || typeof p !== 'object' || p.v !== 1) return null;
    const arr = (x) => Array.isArray(x) ? x.filter(v => typeof v === 'string') : [];
    // 구버전 저장분에 남은 값은 지금 물어보는 것만 남기고 버린다 — 화면에 없는 취향이 계산에만 살아 있으면 안 된다
    const optsOf = (k) => (PREFS_Q.find(g => g.key === k) || { opts: [] }).opts.map(o => o[0]);
    const keep = (x, k) => { const ok = optsOf(k); return arr(x).filter(v => ok.includes(v)); };
    return { v: 1, food: keep(p.food, 'food'), companion: typeof p.companion === 'string' ? p.companion : 'none', avoid: keep(p.avoid, 'avoid'),
      walkMax: normWalkMax(p.walkMax), updatedAt: p.updatedAt || null };   // walkMax 없던 저장분(구버전)은 기본 20분
  }
  function savePrefs() {
    const p = state.prefs || (state.prefs = PREFS_EMPTY());
    p.v = 1; p.updatedAt = new Date().toISOString().slice(0, 16);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* 저장 못 해도 이번 세션은 돈다 */ }
  }
  const groupOf = (k) => PREFS_Q.find(g => g.key === k) || null;
  /* 칩 선택 표시. 아직 고르기 전(state.prefs 없음·값 없음)이라도 g.dflt가 있으면 그 값을 눌린 상태로 보여 준다 —
   * 화면에 아무것도 안 눌려 있는데 실제로는 20분으로 계산되는 어긋남을 막는다. */
  const prefsHas = (g, v) => {
    const p = state.prefs, cur = p ? p[g.key] : undefined;
    if (g.multi) return Array.isArray(cur) && cur.includes(v);
    if (cur === undefined || cur === null || cur === '') return g.dflt !== undefined && String(g.dflt) === String(v);
    return String(cur) === String(v);
  };
  function togglePref(g, v) {
    const p = state.prefs || (state.prefs = PREFS_EMPTY());
    if (!g.multi) { p[g.key] = g.num ? Number(v) : v; return; }
    const now = Array.isArray(p[g.key]) ? p[g.key].slice() : [];
    if (v === 'any') { p[g.key] = now.includes('any') ? [] : ['any']; return; }        // '상관없음'은 같은 그룹을 해제한다(설계 §2)
    p[g.key] = now.includes(v) ? now.filter(x => x !== v) : now.filter(x => x !== 'any').concat([v]);
  }
  function chipsHtml() {
    return PREFS_Q.map(g => `<div class="pf-g"><div class="pf-q">${IC(g.ic, 'ic-s')}<span>${esc(g.q)}</span></div><div class="pf-chips" role="group" aria-label="${esc(g.q)}">`
      + g.opts.map(([v, label, icon]) => `<button type="button" class="chip" data-g="${g.key}" data-v="${v}" aria-pressed="${prefsHas(g, v) ? 'true' : 'false'}">${IC(icon, 'ic-l')}<span>${esc(label)}</span></button>`).join('')
      + '</div></div>').join('');
  }
  function syncChips(w) { if (w) w.querySelectorAll('.chip').forEach(b => { const g = groupOf(b.dataset.g); if (g) b.setAttribute('aria-pressed', prefsHas(g, b.dataset.v) ? 'true' : 'false'); }); }
  function bindChips(id, onChange) {
    const w = $(id); if (!w || w.dataset.bound) return; w.dataset.bound = '1';
    w.addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b || !w.contains(b)) return;
      const g = groupOf(b.dataset.g); if (!g) return;
      togglePref(g, b.dataset.v); syncChips(w);
      if (onChange) onChange();
    });
  }
  const fillChips = (id, onChange) => { const w = $(id); if (!w) return; if (!w.children.length) { w.innerHTML = chipsHtml(); bindChips(id, onChange); } else syncChips(w); };
  function renderPrefs() { fillChips('prefsGroups'); }
  function finishPrefs() {                                     // '다음'·'건너뛰기' 둘 다 저장한다 — 온보딩은 한 번만 묻는다(설계 §1)
    if (!state.prefs) state.prefs = PREFS_EMPTY();
    savePrefs(); state.planAi = null; state.plan = null;
    const depth = history.length - startLen; if (depth > 0) history.go(-depth); else goReplace('scrHome');
  }
  { const bpn = $('btnPrefsNext'), bps = $('btnPrefsSkip');
    if (bpn) bpn.addEventListener('click', guard(finishPrefs));
    if (bps) bps.addEventListener('click', guard(finishPrefs)); }
  function renderMe() {
    fillChips('mePrefs', () => { savePrefs(); state.planAi = null; state.plan = null; });   // 내 정보에서 고치면 즉시 저장 — 다음 생성부터 반영(토스트 없음)
    { const el = $('meWhoName'); if (el) el.textContent = state.who === 'citizen' ? '광주 시민' : '여행객'; }
    { const el = $('meWhoIcon'); if (el) el.innerHTML = `<use href="#i-${state.who === 'citizen' ? 'house' : 'luggage'}"></use>`; }
    { const el = $('meLocName'); if (el) el.textContent = state.loc.name || '광주'; }
    const bk = $('meBook');
    if (bk) {
      let cnt = 0;
      try { const sm = window.ItdaPlanUI && ItdaPlanUI.summary && ItdaPlanUI.summary(); cnt = sm && sm.booked ? sm.booked : 0; } catch (e) { cnt = 0; }
      bk.hidden = !cnt; { const el = $('meBookName'); if (el) el.textContent = `예약 ${cnt}`; }
    }
    renderDev();
  }
  { const mw = $('meWho'), ml = $('meLoc'), mb = $('meBook'), mo = $('meOwner');
    if (mw) mw.addEventListener('click', guard(() => go('scrWho')));
    if (ml) ml.addEventListener('click', guard(openLocPick));
    if (mb) mb.addEventListener('click', guard(() => navTo('scrPlan')));
    if (mo) mo.addEventListener('click', guard(openOwner)); }   // 사장님 화면(store.html) — 같은 서버가 /store로 서빙
  /* ---------- 7b. 개발자 모드 (#meDev) — '내 정보'를 다섯 번 누르면 열린다
   * 온보딩은 한 번만 묻는 합의(설계 §1)라, 다시 보려면 저장 데이터를 지우고 앱을 껐다 켜야 한다.
   * 그 '지우기'를 앱 안에서 할 수 있게 하는 게 이 칸의 전부다 — 숨은 기능·시연용 스위치가 아니다. */
  // DEV_KEY · DEVPOS_KEY는 위(§0 상수)에 있다 — 개발자 모드 켜짐 표시는 사용자 데이터가 아니라 리셋해도 안 지운다
  const DEV_TAPS = 5, DEV_TAP_MS = 2500;            // 이 시간 안에 다섯 번 눌러야 열린다(잘못 눌러서 켜지지 않게)
  const APP_KEY_RX = /^itda[._]/;                   // 앱이 쓰는 저장 키는 전부 이 접두사 — 새 키가 늘어도 리셋에서 안 빠진다
  let devTaps = 0, devTapT = null;
  function devTap() {
    clearTimeout(devTapT); devTapT = setTimeout(() => { devTaps = 0; }, DEV_TAP_MS);
    if (devOn()) return;                                       // 이미 켜져 있으면 셀 필요 없다
    if (++devTaps < DEV_TAPS) { if (devTaps >= 3) toast(`${DEV_TAPS - devTaps}번 더 누르면 개발자 모드`, 1500, 'list-checks'); return; }
    devTaps = 0;
    try { localStorage.setItem(DEV_KEY, '1'); } catch (e) {}
    toast('개발자 모드를 켰어요', 2500, 'list-checks'); renderMe();
  }
  /* 지금 저장돼 있는 것들 — 무엇을 지우는지 보고 누르게 한다(지운 뒤 '정말 지워졌나'도 여기서 확인) */
  function devKeys() {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (APP_KEY_RX.test(k) && k !== DEV_KEY && k !== DEVPOS_KEY && k !== DEVNOW_KEY && k !== DEVSRV_KEY) out.push(k); } } catch (e) {}
    return out.sort();
  }
  function renderDev() {
    const w = $('meDev'); if (!w) return;
    w.hidden = !devOn(); if (w.hidden) return;
    const dp = devPos(), ps = $('devPosSub'), pl = $('devPosLabel');   // 시연용 내 위치 고정 상태
    if (pl) pl.textContent = dp ? `내 위치 고정 해제 (지금 '${dp.step || dp.name}')` : '내 위치를 여기로 고정';
    if (ps) ps.textContent = dp ? '지도의 내 위치 버튼도 이 자리를 가리켜요. 눌러서 실제 GPS로 되돌립니다.' : '눌러서 동네를 고르면 시연 내내 그 자리가 내 위치예요.';
    renderDevStep(); renderDevNow(); renderDevSrv();
    const keys = devKeys();
    const size = keys.reduce((n, k) => { try { return n + (localStorage.getItem(k) || '').length; } catch (e) { return n; } }, 0);
    const el = $('devInfo');
    if (el) el.textContent = keys.length ? `저장된 것 ${keys.length}개 (${size.toLocaleString()}자): ${keys.join(', ')}` : '저장된 사용자 데이터가 없어요 — 다시 켜면 온보딩부터 시작해요.';
  }
  /* ① 진행 상태 수동 이동 — 위치를 고정하면 GPS 거리 판정(80m)이 얼어붙어 '여기/다음'이 영영 안 바뀐다.
   * 그래서 고정 위치를 일정의 다음 칸 좌표로 옮긴다 — 판정·저장·화면 갱신은 실제 도착과 똑같은 경로를 탄다.
   * state.loc(출발 동네)은 건드리지 않는다: 진짜로 걸어가도 state.loc은 그대로고 myPos만 바뀌기 때문. */
  function devStepIndex() {                                // 지금 몇 번째 칸까지 왔나 (-1 = 아직 출발 전)
    const seq = progressOrder(), pr = prState();
    let i = pr.atId ? seq.findIndex(x => x.id === pr.atId) : -1;
    if (i < 0) for (const v of pr.visited) { const k = seq.findIndex(x => x.id === v); if (k > i) i = k; }
    return i;
  }
  const devSlotName = (id, k) => { const sl = slotById(id); return (sl && (sl.name || (sl.place && sl.place.name))) || `${k + 1}번째 칸`; };
  function renderDevStep() {
    const lb = $('devStepLabel'), sb = $('devStepSub'); if (!lb || !sb) return;
    const seq = progressOrder();
    if (!seq.length) { lb.textContent = '다음 칸에 도착한 걸로'; sb.textContent = '일정이 없어요 — 먼저 일정을 만들어 주세요.'; return; }
    const i = devStepIndex();
    lb.textContent = i + 1 < seq.length ? `'${devSlotName(seq[i + 1].id, i + 1)}'에 도착한 걸로` : '마지막 칸까지 다 왔어요';
    sb.textContent = i < 0 ? `${seq.length}칸 중 아직 출발 전` : `${seq.length}칸 중 ${i + 1}번째 '${devSlotName(seq[i].id, i)}'에 있어요`;
  }
  function devStepNext() {
    const seq = progressOrder();
    if (!seq.length) { toast('먼저 일정을 만들어 주세요', 3000, 'triangle-alert'); return; }
    const i = devStepIndex();
    if (i + 1 >= seq.length) { toast('마지막 칸이에요', 2500, 'flag'); return; }
    const q = seq[i + 1], nm = devSlotName(q.id, i + 1);
    /* '여기'로 잡힌 칸은 150m까지 유지된다(HERE_OUT_M) — 골목상권은 칸 사이가 100m도 안 돼서
     * 그대로 옮기면 앞 칸이 계속 '여기'로 남는다. 걸쇠만 풀고 판정은 updateProgress에게 그대로 맡긴다
     * (80m 안에서 가장 가까운 칸을 고르므로, 그 칸 위에 서면 그 칸이 '여기'가 된다). */
    prState().atId = null;
    // 이름·동네는 지금 것을 그대로 물려준다(홈의 '지금 ○○에서'는 걸어가도 안 바뀌므로) — 좌표만 그 칸으로 옮긴다
    devSetPos({ name: state.loc.name || '광주', lat: q.pos.lat, lon: q.pos.lon, zone: state.loc.zone || null, key: state.loc.key || null, step: nm });
    toast(`'${nm}'에 도착한 걸로 했어요`, 2600, 'flag');
  }
  function devStepReset() {
    state.progress = { atId: null, nextId: null, visited: [] };
    try { localStorage.removeItem(PROGRESS_KEY); } catch (e) {}
    progressSigSeen = null;                                // 다음 syncProgress에서 첫 칸을 '다음'으로 다시 잡게
    const back = devPos() && state.loc.lat ? { name: state.loc.name || '광주', lat: state.loc.lat, lon: state.loc.lon, zone: state.loc.zone || null, key: state.loc.key || null } : null;
    if (back) devSetPos(back); else { syncProgress(); onProgressChange(); renderDev(); }
    toast('진행을 처음으로 되돌렸어요', 2500, 'undo-2');
  }

  /* ② 시각 고정 — ?now=의 앱 안 버전. 30분 단위로 밀고 당긴다(처음 누르면 지금 시각의 정시/반). */
  function renderDevNow() {
    const lb = $('devNowLabel'); if (!lb) return;
    const v = devNow();
    lb.textContent = v ? `시각 고정: ${kor(t2m(v))} (${v})` : '시각 고정: 안 함 (진짜 시계)';
    const w = $('devNowChips'); if (w) w.querySelectorAll('.dev-chip').forEach(b => b.classList.toggle('on', b.dataset.now === 'off' && !v));
  }
  function devNowShift(d) {
    const base = devNow() ? t2m(devNow()) : Math.floor(nowMin() / 30) * 30;   // 처음 켤 때는 지금 시각을 30분 단위로 내림
    const m = norm(base + d);
    try { localStorage.setItem(DEVNOW_KEY, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); } catch (e) {}
    devNowApplied();
  }
  function devNowOff() { try { localStorage.removeItem(DEVNOW_KEY); } catch (e) {} devNowApplied(); }
  function devNowApplied() {                               // 시각이 바뀌면 일정은 다시 짜야 하고 배경도 다시 골라야 한다
    state.plan = null; state.planAi = null; state.card = null;
    cancelAlarm();                                         // 옛 시각으로 걸어 둔 알림은 지운다
    skyKey = null; syncWeather(true);
    renderDev();
    const v = devNow();
    toast(v ? `시각을 ${kor(t2m(v))}로 고정했어요 · 일정을 다시 만들어 주세요` : '진짜 시계로 되돌렸어요', 3200, 'clock');
  }

  /* ⑧ 서버 주소 — ?server=의 앱 안 버전. SERVER는 상수라 바꾸면 앱을 다시 시작해야 한다. */
  const DEV_SRV = { local: 'http://localhost:8000', render: 'https://gwangju-itda-api.onrender.com' };
  function renderDevSrv() {
    const lb = $('devSrvLabel'), sb = $('devSrvSub'); if (!lb) return;
    const which = SERVER === DEV_SRV.render ? 'render' : 'local';
    lb.textContent = `서버: ${which === 'render' ? '배포(Render)' : '노트북'}`;
    if (sb && !sb.dataset.ping) sb.textContent = SERVER;    // 연결 확인 결과가 떠 있으면 덮지 않는다
    const w = $('devSrvChips'); if (w) w.querySelectorAll('.dev-chip').forEach(b => b.classList.toggle('on', b.dataset.srv === which));
  }
  function devSrvSet(which) {
    const url = DEV_SRV[which]; if (!url) return;
    if (url === SERVER) { toast('이미 그 서버예요', 2000, 'check'); return; }
    try { localStorage.setItem(DEVSRV_KEY, url); } catch (e) {}
    toast(`${which === 'render' ? '배포' : '노트북'} 서버로 바꿔요 · 다시 시작합니다`, 2000, 'external-link');
    setTimeout(() => location.reload(), 700);               // SERVER가 상수라 다시 읽으려면 재시작이 필요하다
  }
  async function devSrvPing() {                            // 지금 서버가 살아 있나 — /health 왕복 시간
    const sb = $('devSrvSub'); if (!sb) return;
    sb.dataset.ping = '1'; sb.textContent = `${SERVER} — 확인 중…`;
    const t0 = Date.now();
    try {
      const d = await getJson(SERVER + '/health', 8000);    // Render 무료 티어는 콜드스타트가 길다
      sb.textContent = d ? `${SERVER} — 붙었어요 (${Date.now() - t0}ms)` : `${SERVER} — 응답이 200이 아니에요 (${Date.now() - t0}ms)`;
    } catch (e) { sb.textContent = `${SERVER} — 못 붙었어요 (${Date.now() - t0}ms)`; }
  }

  /* 캐시 초기화 — 받아 둔 자료(장소·경로·날씨·취향표)를 버리고 다시 받는다.
   * 브라우저 캐시·세션 저장소를 비운 뒤 새로고침한다. 저장된 사용자 데이터(취향·일정)는 건드리지 않는다. */
  async function devClearCache() {
    try { sessionStorage.clear(); } catch (e) {}
    try { if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } } catch (e) {}
    toast('캐시를 비웠어요. 다시 받는 중…', 2000, 'undo-2');
    setTimeout(() => location.reload(), 400);
  }
  /* 저장 사용자 데이터 리셋 — itda.* 키를 전부 지운다(개발자 모드 스위치만 남긴다).
   * 화면은 그대로 두고 알리기만 한다: '앱을 껐다 켜면 온보딩'이라는 약속을 눈으로 확인하려는 기능이라서. */
  function devReset() {
    const keys = devKeys();
    try { for (const k of keys) localStorage.removeItem(k); } catch (e) {}
    state.plan = null; state.planAi = null; state.planConfirmed = false;
    cancelAlarm();
    toast(`${keys.length}개를 지웠어요. 앱을 껐다 켜면 온보딩부터예요.`, 5000, 'triangle-alert');
    renderDev();
  }
  { const dc = $('devCache'), dr = $('devReset'), dq = $('devRestart'), df = $('devOff'), dp = $('devPos');
    { const st = $('devStep'), sr = $('devStepReset');
      // guard()를 안 쓴다 — 450ms 잠금이 걸리면 칸을 연속으로 못 넘긴다(화면 전환이 아니라 안전하다)
      if (st) st.addEventListener('click', devStepNext);
      if (sr) sr.addEventListener('click', devStepReset); }
    { const nw = $('devNowChips');
      if (nw) nw.addEventListener('click', (e) => { const b = e.target.closest('.dev-chip'); if (!b) return; if (b.dataset.now === 'off') devNowOff(); else devNowShift(+b.dataset.now); }); }   // +30분을 연달아 눌러야 해서 guard 없음
    { const sv = $('devSrvChips');
      if (sv) sv.addEventListener('click', (e) => { const b = e.target.closest('.dev-chip'); if (!b) return; if (b.dataset.srv === 'ping') devSrvPing(); else devSrvSet(b.dataset.srv); }); }
    if (dp) dp.addEventListener('click', guard(() => { if (devPos()) { devSetPos(null); toast('실제 GPS로 되돌렸어요', 2000, 'locate-fixed'); locate(); } else openLocPick(); }));
    if (dc) dc.addEventListener('click', guard(devClearCache));
    if (dr) dr.addEventListener('click', guard(devReset));
    if (dq) dq.addEventListener('click', guard(() => location.reload()));
    if (df) df.addEventListener('click', guard(() => { const had = !!devPos(); try { localStorage.removeItem(DEV_KEY); localStorage.removeItem(DEVPOS_KEY); localStorage.removeItem(DEVNOW_KEY); localStorage.removeItem(DEVSRV_KEY); } catch (e) {} renderDev(); if (had) { startWatch(); locate(); } toast('개발자 모드를 껐어요', 2000, 'x'); })); }
  // 여는 손잡이 두 곳: 내 정보 화면의 '내 정보' 제목 · 하단 내비의 '내 정보' 탭(이미 그 화면일 때)
  { const title = document.querySelector('#scrMe .card-k');
    if (title) title.addEventListener('click', devTap);
    const tab = document.querySelector('.nav-b[data-nav="scrMe"]');
    if (tab) tab.addEventListener('click', () => { if (cur === 'scrMe') devTap(); }); }

  // 취향 매핑표: 앱 번들 사본을 읽는다(없으면 엔진 기본 정렬)
  async function loadTasteMap() {
    try {
      const r = await fetch(TASTE_MAP_URL, { cache: 'no-cache' }); if (!r.ok) return;
      const d = await r.json(); if (d && typeof d === 'object') { state.tasteMap = d; console.log('taste map', Object.keys(d).length); }
    } catch (e) { /* 없으면 취향 정렬은 엔진 기본값으로 */ }
  }

  // ---------- 일정 화면 모듈 초기화 (app/plan-ui.js) ----------
  ItdaPlanUI.init({ state, $, kor, t2m, nowMin, toast, speak, go, guard, DESTS, INTENTS, INBOUND, ZONE_CENTER, PLACES, CORRIDORS, SERVER, scheduleAlarm, cancelAlarm, drawMap, getCur: () => cur, openUrl, openNaverPlace, openLocPick, setIntents, slotText, refreshAi: refreshPlanAi });

  // ---------- 홈 위젯·시민/여행객 (v3) ----------
  let savedPlan = null;   // loadSaved()가 찾은 오늘 저장 일정(복원 전까지)
  function renderHome() {
    updateWhoTag(); renderHomePlan();   // 설명문(#homeTag)·예문(.h-ex)은 삭제됨(기준 §4)
  }
  function renderHomePlan() {                                  // #homePlan: 현재 일정(U의 ItdaPlanUI.summary()) 또는 저장 일정. 없으면 숨김. 위젯이 보이면 #resumeLine은 숨긴다.
    const hp = $('homePlan'); if (!hp) return;
    let text = null, sub = '', subIc = 'clock';
    if (state.plan && window.ItdaPlanUI && typeof ItdaPlanUI.summary === 'function') {
      try {
        const s = ItdaPlanUI.summary();
        if (typeof s === 'string' && s) text = s;
        else if (s && (s.text || s.main)) { text = s.text || s.main; sub = s.sub || ''; if (s.reserved || s.paid) { sub = `예약 ${s.reserved || 0} · 결제 ${s.paid || 0}`; subIc = 'calendar-check'; } }   // 예약·결제가 있으면 2줄째는 그 수(설계 §1)
      } catch (e) { /* 요약 실패 시 아래 폴백 */ }
    }
    if (!text && state.plan && Array.isArray(state.plan.slots)) {
      const names = state.plan.slots.filter(s => s && s.place && !s.skipped).map(s => s.place.name);
      if (names.length) { text = `오늘 일정 · ${names.slice(0, 2).join(' → ')}`; sub = state.plan.exit && typeof state.plan.exit.leave === 'number' ? `${kor(state.plan.exit.leave)} 나가기` : ''; }
    }
    if (!text && savedPlan) { const sig = savedPlan.sig, d = DESTS[sig.dest] || DESTS.none; text = '오늘 일정'; sub = `${kor(sig.hour * 60 + (Number.isInteger(sig.minute) ? sig.minute : 0))} ${d.kind}`; }
    if (text && state.plan) { syncProgress(); const nx = nextName(); if (nx) { sub = `다음: ${nx}`; subIc = 'map-pin'; } }   // 진행 중이면 장소 나열 대신 다음 칸(설계 §3)
    hp.hidden = true;                                          // 홈에서는 오늘 일정 위젯 대신 빠른 부탁 2개를 둔다(대표 지시 2026-09-04). 일정은 하단 '일정' 탭에서.
    { const hq = $('homeQuick'); if (hq) hq.hidden = false; }   // 두 박스는 항상 보인다
    if (text) { $('homePlanText').innerHTML = IC('calendar-days', 'ic-s') + `<span>${esc(text)}</span>`; $('homePlanSub').innerHTML = sub ? IC(subIc, 'ic-s') + `<span>${esc(sub)}</span>` : ''; const rl = $('resumeLine'); if (rl) rl.hidden = true; }
  }
  { const hp = $('homePlan'); if (hp) hp.addEventListener('click', guard(() => { if (state.plan || state.card) go('scrPlan'); else if (savedPlan) resumeSaved(savedPlan); })); }
  function setMapCat(cat) {                                  // 지도 탭의 종류 필터를 코드에서 바꾼다(버튼 표시도 함께)
    mapCat = cat || null;
    document.querySelectorAll('#cats .cat').forEach(x => x.classList.toggle('on', x.dataset.cat === (cat || 'all')));
  }
  /* 오브 아래 빠른 부탁: 확인 화면을 거치지 않고 그 종류만 찍힌 지도로 바로 간다(대표 지시 2026-09-04).
   * 이름이 '찾아줘'인 이유 — 여기서는 LLM도 순위도 없다. 반경 안의 그 종류를 지도에 다 찍을 뿐이다.
   * '추천'은 말·글로 조건을 받아 일정을 짜는 경로(applyHeard → /plan/ai)에서만 한다(2026-09-04 대표 지적). */
  function quickAsk(intent, sentence) {
    state.lastHeard = sentence; state.heardSource = 'quick'; state.inputMode = 'quick'; state.askPrefs = null;
    setIntents([intent]);                                    // 지도에서 일정으로 이어갈 때 쓰도록 의도는 남긴다
    voiceUI('idle');
    if (!state.loc || !state.loc.lat) { toast('어디 계신지 먼저 알려주세요', 3500, 'map-pin'); openLocPick(); return; }
    setMapCat(intent); $('mfSheet').hidden = true;
    state.editing = null; go('scrMapFull');
  }
  { const qe = $('qEat'), qc = $('qCafe');
    if (qe) qe.addEventListener('click', guard(() => quickAsk('eat', '근처 식당 찾아줘')));
    if (qc) qc.addEventListener('click', guard(() => quickAsk('cafe', '근처 카페 찾아줘'))); }
  function pickWho(w) {                                        // 첫 진입(시작점)이면 바꿔치기, 홈·내 정보에서 '바꾸기'로 왔으면 한 칸 뒤
    saveWho(w);
    const first = history.length - startLen <= 0;
    if (!state.prefs && $('scrPrefs')) { if (first) goReplace('scrPrefs'); else go('scrPrefs'); return; }   // 취향 온보딩은 딱 한 번(설계 §1)
    if (cur === 'scrWho' && first) goReplace('scrHome'); else back();
  }   // 첫 진입(시작점)이면 홈으로 바꿔치기, 홈에서 '바꾸기'로 왔으면 한 칸 뒤 = 홈
  // 환영(#scrWelcome) → 시민/여행객. 온보딩은 앞으로만 간다(goReplace) — 되돌아갈 것이 없고,
  // 시작점이 한 칸으로 남아야 취향까지 마친 뒤 '뒤로'가 홈으로 떨어진다(finishPrefs의 history.go)
  { const wn = $('btnWelNext'); if (wn) wn.addEventListener('click', guard(() => goReplace('scrWho'))); }
  { const c = $('btnCitizen'), t = $('btnTraveler'), w = $('whoTag'), o = $('btnOwner');
    if (c) c.addEventListener('click', guard(() => pickWho('citizen')));
    if (t) t.addEventListener('click', guard(() => pickWho('traveler')));
    if (o) o.addEventListener('click', guard(openOwner));   // 지역 사장 — 성격을 고르는 게 아니라 사장님 화면으로 나간다
    if (w) w.addEventListener('click', guard(() => go('scrWho'))); }   // 헤더 우측 '광주 시민 ▾' 필 → 이 목록(시민·여행객·지역 사장)

  // ---------- 일정 저장분 복원 (기술설계 §5-10: 키 itda.plan.v1 — plan-ui가 쓰고 여기서 읽는다) ----------
  // 저장 모양: { v:1, day:'2026-09-03', savedAt:min, sig:{ intents:[..], intent, dest, hour, minute, buffer, locKey }, edits, confirmed } — v3: sig.intents(배열) 추가, 구 형식 sig.intent만 있어도 읽는다
  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function dropSaved() { savedPlan = null; try { localStorage.removeItem(PLAN_KEY); } catch (e) {} const rl = $('resumeLine'); if (rl) rl.hidden = true; }
  function loadSaved() {                                       // 반환: 오늘 유효한 저장 일정 s | null (시작 시 who·차편 스킵 판단에 쓴다)
    let s = null;
    try { s = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null'); } catch (e) { s = null; }
    if (!s) return null;
    const sig = s.sig;
    if (s.v !== 1 || !sig || typeof sig !== 'object' || !s.edits || typeof s.edits !== 'object') { dropSaved(); return null; }   // 모양 불일치
    const dep = Number.isInteger(sig.hour) ? sig.hour * 60 + (Number.isInteger(sig.minute) ? sig.minute : 0) : null;
    if (s.day !== todayStr() || dep === null || dep <= nowMin()) { dropSaved(); return null; }   // 당일이 아니거나(자정 지남) 이미 출발 시각이 지났으면 버린다
    savedPlan = s;
    const rl = $('resumeLine'); if (!rl) return s;   // 홈 줄이 없으면(index.html 미통합) 표시만 못 한다 — 키는 남긴다
    const d = DESTS[sig.dest] || DESTS.none;
    rl.innerHTML = IC('calendar-days') + `<span>오늘 일정 · ${esc(kor(dep))} ${esc(d.kind)}</span>`;
    rl.hidden = !!$('homePlan');                               // v3 홈 위젯이 있으면 그쪽이 보여준다(renderHome)
    rl.onclick = guard(() => resumeSaved(s));
    return s;
  }
  function resumeSaved(s) {
    const sig = s.sig;
    const p = sig.locKey ? PLACES.find(x => x.key === sig.locKey) : null;
    if (p) { if (state.loc.key !== p.key || !state.loc.lat) { state.loc.manual = true; setLoc({ status: 'manual', key: p.key, name: p.name, zone: p.zone, lat: p.lat, lon: p.lon }); syncPlaces(); } }
    else if (!state.loc.lat) { toast('위치를 먼저 잡아 주세요', 3500, 'map-pin'); openLocPick(); return; }   // GPS 좌표로 짠 일정인데 아직 위치가 없음: 위치부터
    state.hour = sig.hour; state.minute = Number.isInteger(sig.minute) ? sig.minute : 0; state.touchedTime = true;
    state.dest = sig.dest || null; setIntents(Array.isArray(sig.intents) && sig.intents.length ? sig.intents : (sig.intent ? [sig.intent] : [])); if (BUFFERS.includes(sig.buffer)) state.buffer = sig.buffer;
    state.train = sig.train && typeof sig.train === 'object' ? sig.train : null;
    state.card = null; state.plan = null; state.planEdits = s.edits; state.planUndo = []; state.planConfirmed = !!s.confirmed;
    state.editing = null; state.lastHeard = null;
    markDest(state.dest);
    savedPlan = null; const rl = $('resumeLine'); if (rl) rl.hidden = true;
    const savedAi = s.ai && typeof s.ai === 'object' && s.ai.picks && typeof s.ai.picks === 'object' ? s.ai : null;
    buildAndGo({ ai: savedAi });   // 복원은 저장된 AI 결과 그대로 — 재호출 없음(설계 §6)
  }

  /* ---------- 결제 복귀 (docs/예약결제_구현설계_2026-09-04 §2)
   * pay-return.html이 서버 confirm까지 끝내고 index.html?paid=<orderId>&pk=<paymentKey> 또는 ?payfail=<code>로 돌려보낸다.
   * 결제창은 앱을 떠나므로 여기선 앱이 새로 뜬 상태 — 저장분(itda.plan.v1)을 되살려 그 편집에 'paid'를 적는다. */
  function handlePayReturn(saved) {
    const paid = param('paid'), fail = param('payfail');
    if (!paid && !fail) return false;
    const PAY_PENDING = (window.ItdaPlanUI && ItdaPlanUI.PAY_PENDING) || 'itda.pay.pending';
    let pend = null;
    try { pend = JSON.parse(localStorage.getItem(PAY_PENDING) || 'null'); } catch (e) { pend = null; }
    try { localStorage.removeItem(PAY_PENDING); } catch (e) {}
    if (fail) { toast(fail === 'PAY_PROCESS_CANCELED' ? '결제를 그만뒀어요' : '결제가 안 됐어요', 4000, 'triangle-alert'); return false; }
    if (!pend || pend.orderId !== paid) { toast('결제 내역을 못 찾았어요', 4000, 'triangle-alert'); return false; }   // 주문 번호가 안 맞으면 손대지 않는다
    if (!saved || !saved.edits) { toast('일정을 못 찾았어요', 4000, 'triangle-alert'); return false; }
    try {
      saved.edits = ItdaPlanUI.applyPaid(saved.edits, pend, param('pk'));
      localStorage.setItem(PLAN_KEY, JSON.stringify(saved));
    } catch (e) { toast('결제 표시를 못 했어요', 4000, 'triangle-alert'); return false; }
    resumeSaved(saved);
    toast('결제됐어요 · 테스트', 4000, 'credit-card');
    return true;
  }


  /* ---------- 홈 오브: 풀 굴절 유리 (기준 §4-1 + liquid-glass 스킬 references/refraction-implementation.md)
   * 3단 강등: 굴절(SVG feDisplacementMap 체인) → 블러(flow.css .orb 기본값) → 근고체(@supports·OS 신호·html.reduce-glass).
   * 필터는 이 오브 하나에만 건다(카드·목록에는 금지). 맵은 지오메트리 키로 캐시하고 크기가 바뀔 때만 다시 만든다.
   * 부호 규약: 볼록 렌즈는 안쪽 fetch → 128 - n_outward*v*127 (스킬 실측 2026-09-02).
   * -------------------------------------------------------------------------------------------- */
  (function orbGlass() {
    const orb = $('orb'), host = $('lgFilters');
    if (!orb || !host) return;
    const ETA = 1.5, SHININESS = 3, SPEC_OPACITY = 0.4, SAT_BOOST = 6, BLUR = 0.5, SPEC_BACK = 0.3, LIGHT = 225;
    const UMAX = 0.985, SPEC_GAIN = 1.3, MIN_PX = 40, MAX_DPR = 2, DEBOUNCE_MS = 200, RETRY_MS = 400;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, at) => { const e = document.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, at[k]); return e; };
    const canvasOf = (PW, PH) => { const c = document.createElement('canvas'); c.width = PW; c.height = PH; return c; };
    const sdf = (W, H, R) => (px, py) => R - Math.hypot(px - W / 2, py - H / 2);   // 원의 SDF: 가장자리까지 거리

    function refractOK() {                                   // 앱 스위치 → CSS 지원 → 검증된 런타임(스킬 ledger)
      const h = document.documentElement;
      if (h.classList.contains('reduce-glass') || h.classList.contains('senior')) return false;
      try { if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return false; } catch (e) {}
      let ok = false;
      try { ok = CSS.supports('backdrop-filter', 'url(#x)') || CSS.supports('-webkit-backdrop-filter', 'url(#x)'); } catch (e) {}
      if (!ok) return false;
      const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
      if (!m) return false;
      return +m[1] >= (/;\s?wv\)/.test(navigator.userAgent) ? 151 : 148);
    }
    const slope = (u) => u / Math.sqrt(1 - u * u);            // 볼록 원형(구) 프로파일
    const snell = (sl, T) => { const ti = Math.atan(sl), tt = Math.asin(Math.sin(ti) / ETA); return Math.tan(ti - tt) * T; };

    // 굴절 변위 맵(RG=이동 방향)과 정반사 맵(A=세기)을 한 번의 픽셀 루프로 굽는다. 반환은 <feImage>에 그대로 넣을 data URL.
    function lensMaps(W, H, R, B, T, res) {
      const sMax = slope(UMAX), maxDisp = snell(sMax, T);
      const Lx = Math.cos(LIGHT * Math.PI / 180), Ly = Math.sin(LIGHT * Math.PI / 180);
      const PW = Math.round(W * res), PH = Math.round(H * res);
      const mc = canvasOf(PW, PH), sc = canvasOf(PW, PH);
      const mx = mc.getContext('2d'), sx = sc.getContext('2d');
      const mi = mx.createImageData(PW, PH), si = sx.createImageData(PW, PH);
      const dist = sdf(W, H, R);
      for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
        const px = (x + .5) / res, py = (y + .5) / res;
        const d = dist(px, py); let nx = 0, ny = 0, v = 0, I = 0;
        if (d >= 0 && d < B) {
          const gl = Math.hypot(px - W / 2, py - H / 2) || 1;
          nx = (px - W / 2) / gl; ny = (py - H / 2) / gl;      // 바깥 방향 법선
          const u = Math.min(1 - d / B, UMAX), sl = slope(u);
          v = snell(sl, T) / maxDisp;
          const f0 = nx * Lx + ny * Ly, e = sl / sMax;
          I = Math.min(1, Math.pow(Math.max(0, f0), SHININESS) * e + Math.pow(Math.max(0, -f0), SHININESS) * e * SPEC_BACK);
        }
        const i = (y * PW + x) * 4;
        mi.data[i] = Math.round(128 - nx * v * 127); mi.data[i + 1] = Math.round(128 - ny * v * 127);
        mi.data[i + 2] = 0; mi.data[i + 3] = 255;
        const g8 = Math.round(255 * Math.min(1, I * SPEC_GAIN));
        si.data[i] = g8; si.data[i + 1] = g8; si.data[i + 2] = g8; si.data[i + 3] = Math.round(255 * I);
      }
      mx.putImageData(mi, 0, 0); sx.putImageData(si, 0, 0);
      return { maxDisp, displace: mc.toDataURL('image/png'), specular: sc.toDataURL('image/png') };
    }
    // 원형 렌즈는 약한 중앙 확대 맵이 굴절보다 먼저 온다(스킬 §9).
    function magnifyMap(W, H, R, mag, res) {
      const maxOff = 0.5 * Math.hypot(W, H) * (1 - 1 / mag);
      const PW = Math.round(W * res), PH = Math.round(H * res);
      const gc = canvasOf(PW, PH), gx = gc.getContext('2d'), gi = gx.createImageData(PW, PH);
      const dist = sdf(W, H, R);
      for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
        const px = (x + .5) / res, py = (y + .5) / res; let vx = 0, vy = 0;
        if (dist(px, py) >= 0) { vx = (W / 2 - px) * (1 - 1 / mag) / maxOff; vy = (H / 2 - py) * (1 - 1 / mag) / maxOff; }
        const i = (y * PW + x) * 4;
        gi.data[i] = Math.round(128 + vx * 127); gi.data[i + 1] = Math.round(128 + vy * 127);
        gi.data[i + 2] = 0; gi.data[i + 3] = 255;
      }
      gx.putImageData(gi, 0, 0);
      return { maxOff, url: gc.toDataURL('image/png') };
    }

    const made = new Set();
    function buildFilter(W, H, res) {
      const R = Math.min(W, H) / 2, B = +orb.dataset.bezel || 22, T = +orb.dataset.thickness || 20, mag = +orb.dataset.magnify || 0;
      const id = `lg-orb-w${W}h${H}r${Math.round(R)}a${LIGHT}x${res}`;
      if (made.has(id)) return id;
      const lens = lensMaps(W, H, R, B, T, res);
      const f = mk('filter', { id, x: '-20%', y: '-20%', width: '140%', height: '140%', 'color-interpolation-filters': 'sRGB' });
      let blurIn = 'SourceGraphic';
      if (mag > 1) {
        const g = magnifyMap(W, H, R, mag, res);
        f.append(
          mk('feImage', { href: g.url, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', result: 'magnifying_displacement_map' }),
          mk('feDisplacementMap', { in: 'SourceGraphic', in2: 'magnifying_displacement_map', scale: (2 * g.maxOff).toFixed(2), xChannelSelector: 'R', yChannelSelector: 'G', result: 'magnified_source' }));
        blurIn = 'magnified_source';
      }
      f.append(
        mk('feGaussianBlur', { in: blurIn, stdDeviation: BLUR, result: 'blurred' }),
        mk('feImage', { href: lens.displace, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', result: 'displacement_map' }),
        mk('feDisplacementMap', { in: 'blurred', in2: 'displacement_map', scale: (2 * lens.maxDisp).toFixed(2), xChannelSelector: 'R', yChannelSelector: 'G', result: 'displaced' }),
        mk('feColorMatrix', { in: 'displaced', type: 'saturate', values: SAT_BOOST, result: 'displaced_saturated' }),
        mk('feImage', { href: lens.specular, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', result: 'specular_layer' }),
        mk('feComposite', { in: 'displaced_saturated', in2: 'specular_layer', operator: 'in', result: 'specular_saturated' }));
      const ct = mk('feComponentTransfer', { in: 'specular_layer', result: 'specular_faded' });
      ct.append(mk('feFuncA', { type: 'linear', slope: SPEC_OPACITY, intercept: 0 }));
      f.append(ct,
        mk('feBlend', { in: 'specular_saturated', in2: 'displaced', mode: 'normal', result: 'withSaturation' }),
        mk('feBlend', { in: 'specular_faded', in2: 'withSaturation', mode: 'normal' }));
      host.appendChild(f); made.add(id);
      return id;
    }

    let t = null;
    function apply() {
      if (!refractOK()) return;
      const r = orb.getBoundingClientRect();
      const W = Math.round(r.width), H = Math.round(r.height);
      if (W < MIN_PX || H < MIN_PX) return;                    // 홈이 안 보일 때(0px)는 만들지 않는다
      const res = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      let id = null;
      try { id = buildFilter(W, H, res); } catch (e) { console.warn('orb glass fail', e && e.message); return; }
      orb.style.setProperty('backdrop-filter', `url(#${id})`);
      orb.style.setProperty('-webkit-backdrop-filter', `url(#${id})`);
      orb.classList.add('lg-refracting');
    }
    const schedule = () => { clearTimeout(t); t = setTimeout(apply, DEBOUNCE_MS); };
    if (param('debug')) window.__orb = { apply, refractOK, buildFilter, made };   // 검증 훅
    requestAnimationFrame(() => requestAnimationFrame(apply));
    setTimeout(apply, RETRY_MS);                             // rAF는 탭이 가려져 있으면 안 돈다 — 타이머로 한 번 더
    if (window.ResizeObserver) new ResizeObserver(schedule).observe(orb);
    window.addEventListener('orientationchange', schedule);
  })();
  // ---------- 시작 ----------
  history.replaceState({ scr: 'scrHome' }, '', '#scrHome');
  const startLen = history.length;
  if (param('debug')) window.__itda = { state, go, nowMin, setIntents, loadTrains, goStepwise, legs: () => currentLegs(), loadLegs, setPos, progress: () => state.progress, prefs: () => state.prefs, ai: () => state.planAi, buildAndGo, fetchPlanAi };   // 시연·검증 훅(?debug=1): setPos(lat,lon)로 위치를 흉내 낸다
  state.who = readWho();
  state.prefs = readPrefs();
  setLoc({ status: 'pending' });
  const saved = loadSaved();
  // v3 진입: 오늘 저장 일정(차편 hour)이 있으면 who·차편을 안 묻고 홈. itda.who가 없으면 '시민/여행객'이 히스토리 시작점(H1 마크업이 없으면 홈).
  const askWho = !state.who && !saved && !!$('scrWho') && !param('paid') && !param('payfail');
  const askPrefs = !askWho && !state.prefs && !saved && !!$('scrPrefs') && !param('paid') && !param('payfail');   // who는 있는데 취향만 없는 경우도 한 번 묻는다
  const askWelcome = askWho && !!$('scrWelcome');               // 환영은 '시민/여행객'을 묻는 첫 진입에서만 — 취향만 빠진 경우엔 안 뜬다
  if (askWelcome) { history.replaceState({ scr: 'scrWelcome' }, '', '#scrWelcome'); render('scrWelcome'); }
  else if (askWho) { history.replaceState({ scr: 'scrWho' }, '', '#scrWho'); render('scrWho'); }
  else if (askPrefs) { history.replaceState({ scr: 'scrPrefs' }, '', '#scrPrefs'); render('scrPrefs'); }
  else render('scrHome');
  const paidBack = handlePayReturn(saved);                   // 결제창에서 돌아온 진입(?paid·?payfail)
  locate();
  loadTasteMap();
  startWatch();                                              // 앱이 앞에 있는 동안만 위치 감시(고정값 시연이면 안 켠다)
  syncCorridors();
  syncWeather();
  if (!paidBack) setTimeout(() => speak(askWho ? '광주에 사세요, 여행 오셨어요?' : (state.who === 'citizen' ? '지금 광주에서 뭘 하실래요? 파란 동그라미를 누르고 말씀하세요.' : '지금 광주에서 뭘 하다 가실래요? 파란 동그라미를 누르고 말씀하세요.')), MS.greet);
})();
