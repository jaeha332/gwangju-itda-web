/* 광주잇다 — 일정 화면(plan-ui.js). 계산은 plan.js(ItdaPlan), 화면·조작·시트·스낵바·저장은 여기. flow.js가 init(ctx)로 공유 상태와 헬퍼를 넘긴다.
 * 계약: docs/일정_기술설계_2026-09-03.md §1(state.plan/planEdits/planUndo/planConfirmed) §2(ItdaPlan API) §3(이 파일) — 화면·문구·수치는 docs/일정_설계_2026-09-03.md + 목업.
 * v3(docs/일정_v3_계약_2026-09-04.md): 칸 순서(핸들 DnD·▲▼·move/up/down op) · 바꾸기 시트(#swapSheet, candidatesNear) · 다중 의도(state.intents) · 홈 위젯 요약(summary) · 예약 배지(slot.booking).
 * 파일 경계: plan.js(순수 계산) · plan-ui.js(이 파일) · map.js(지도) · flow.js(화면 전환·상태) · index.html/flow.css(H1) */
(function () {
  'use strict';
  let state, $, kor, t2m, nowMin, toast, speak, go, guard, DESTS, INBOUND, CORRIDORS, SERVER, scheduleAlarm, drawMap, getCur, openNaverPlace, slotText, refreshAi;
  const PLAN_KEY = 'itda.plan.v1';                               // §5-10: 여기서 쓰고(persist) flow.js가 시작 시 읽는다(loadSaved)
  const SWAP_R = 600, SWAP_R_WIDE = 1200;                        // 바꾸기 후보 반경(m) — 계약 §4
  const SWAP_MAX = 10;          // 바꾸기 시트에 보여 줄 후보 수 — 계약 §4
  const ADD_MAX = 5;            // '한 곳 더' 시트 후보 수
  const SPARE_MIN = 20;         // 남는 시간이 이만큼이면 '한 곳 더' 행을 보여 준다 [정책값]
  const SUM_NAMES = 3;          // 홈 위젯 요약에 적는 가게 이름 수
  const AI_CANDS = 10;          // AI에 넘기는 칸별 후보 수 상한 — 설계 §4
  const AI_SLOTS = 6;           // AI에 넘기는 칸 수 상한 (서버 MAX_SLOTS와 같은 값)
  /* 보도 거리 재정렬(2026-09-04) — 후보를 고를 때까지는 직선거리×1.2였다. '주변 카페'가 실제로는 더 먼 곳으로
   * 뽑히던 문제[실측 동명동: 스타벅스 직선 57m/보도 75m 가 스테이북 직선 39m/보도 113m 보다 가깝다].
   * 서버 POST /walk/near 가 후보들의 TMAP 보행자 거리를 병렬로 재 준다(후보 8곳에 2.3초[실측]).
   * 못 받으면 직선 순서 그대로 — 값을 지어내지 않는다. */
  const WALK_NEAR_CANDS = 6;    // 칸마다 보도 거리를 물어보는 후보 수 (서버 WALK_NEAR_MAX=8 이내)
  const WALK_NEAR_SLOTS = 3;    // 보도 거리로 다시 재는 칸 수 — 호출 수는 이 둘의 곱이다
  const WALK_NEAR_MS = 5000;    // 이 안에 못 오면 직선 순서로 진행한다
  const WHY_MAX = 12;           // 이유 배지 글자 수 — 설계 §4
  const CANDS_MANY = 10;        // 분모가 이보다 크면 배지 문구를 '가까운 순 n번째'로
  const TAXI_CALL_EARLY = 10;   // 택시는 나가기 이만큼 전에 미리 부르라고 안내(분)
  const FLASH_MS = 1100;        // 옮긴 카드·나가기 줄 강조 시간(flow.css의 flash 애니메이션과 같은 길이)
  const DAY_MIN = 1440;         // 하루(분) — 자정 넘는 일정은 계산하지 않는다
  const WALK_FAR = 9999;        // 걷기 시간을 모르는 후보는 정렬에서 맨 뒤로
  const M_PER_DEG_LAT = 111320; // 위도 1°의 대략 거리(m) — 반경을 '몇 분 거리'로 바꿀 때만
  const EARTH_R_M = 6371000;    // 하버사인 지구 반지름(m)
  const SCROLL_HOLD_MS = 20000; // 사용자가 손으로 스크롤한 뒤 이만큼은 자동 스크롤을 하지 않는다(설계 §3)
  const AUTO_SETTLE_MS = 900;   // 우리가 시킨 스크롤이 끝날 때까지 — 그 사이 scroll 이벤트는 사용자 조작이 아니다
  let bound = false, wasConfirmed = false, addCat = null, confirmId = null, confirmNext = null, detailId = null, swapId = null, swapRadius = SWAP_R;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const josa = (w, a, b) => { w = String(w); const c = w.charCodeAt(w.length - 1); const jong = c >= 0xAC00 && c <= 0xD7A3 ? (c - 0xAC00) % 28 : 0; return w + (jong ? a : b); };   // 받침 있으면 a
  const dur = (m) => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), mm = m % 60; return h ? (mm ? `${h}시간 ${mm}분` : `${h}시간`) : `${mm}분`; };
  const ic = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;   /* 인라인 스프라이트는 index.html(2a). 이름은 docs/픽토그램_UI_기준 §3 매핑표만 */
  const CAT_ICO = { eat: 'utensils', cafe: 'coffee', play: 'sparkles', sight: 'landmark' };
  const catIc = (cat) => ic(CAT_ICO[cat] || 'landmark');
  const REDUCED = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isN = (x) => typeof x === 'number' && Number.isFinite(x);                  // 자료 방어: null·undefined·NaN 시각/좌표를 걸러 낸다

  function init(c) {
    ({ state, $, kor, t2m, nowMin, toast, speak, go, guard, DESTS, INBOUND, CORRIDORS, SERVER, scheduleAlarm, drawMap, getCur } = c);
    slotText = typeof c.slotText === 'function' ? c.slotText : null;   // 듣기(TTS) 첫 문장 — flow.js가 데이터로만 들고 있다
    refreshAi = typeof c.refreshAi === 'function' ? c.refreshAi : null;   // '다시 짜기'가 AI를 다시 부를 때(설계 §6)
    openNaverPlace = c.openNaverPlace || ((name) => window.open(`https://map.naver.com/p/search/${encodeURIComponent(name)}`, '_blank'));   // 폴백도 네이버지도 웹
    if (!bound) { bind(); bound = true; }
  }

  // ---------- 입력 조립 (§3.3 buildPlan) ----------
  let placesCache = { src: null, list: [] };
  function placesList() { const d = window.PLACES_DATA; if (placesCache.src !== d) placesCache = { src: d, list: window.ItdaMap ? ItdaMap.places() : [] }; return placesCache.list; }   // 1,500행 객체화는 자료가 바뀔 때만
  const zoneOf = () => state.loc.zone || (state.loc.key === 'champions' ? '충장로' : null);
  const companionOf = () => { const c = state.prefs && state.prefs.companion; return c === 'senior' || c === 'child' ? c : (state.prefs ? 'default' : 'senior'); };   // 취향 companion을 그대로 걷기 속도로(설계 §2). 취향이 없으면 지금까지처럼 어르신 걸음
  const walkMaxOf = () => ItdaPlan.maxWalkOf({ maxWalk: state.prefs && state.prefs.walkMax });   // 취향의 걷기 상한(분). 취향 없음·이상한 값이면 엔진 기본(20분)
  /* ---------- 칸 사이 이동수단(도보·택시·대중교통) ----------
   * 값은 서버 GET /move 가 준다(도보=TMAP 보행자, 택시=카카오모빌리티, 대중교통=ODsay).
   * 매번 부르면 ODsay 무료 30건/일이 금방 마르므로 '이동 줄을 눌렀을 때'만 받아 오고, 받은 건 세션 안에서 재사용한다. */
  const MOVE_IC = { walk: 'footprints', taxi: 'car-taxi-front', transit: 'bus-front' };
  const MOVE_WHY = { tmap_pedestrian: '보행 경로 기준', ors_foot_walking: '보행 경로 기준', kakao_mobility: '길찾기 기준', odsay: '대중교통 길찾기 기준', straight: '직선 거리 기준' };
  const MOVE_FAIL = { no_odsay_key: '아직 연결 안 됨', quota_guard: '오늘 조회 한도', too_close: '걸어가는 게 빨라요', too_far: '너무 멀어요', no_key: '아직 연결 안 됨' };
  const NET_MOVE_MS = 8000;                    // /move 는 공급자 3곳을 거치므로 넉넉히
  const MOVE_PREFETCH_MAX = 6;                 // 화면을 열 때 미리 받아 둘 구간 수 상한(칸 5개 + 여유)
  const moveCache = {};                        // 'lat,lon|lat,lon' → 서버가 준 modes (세션 동안 유지)
  const moveFull = {};                         // 세 수단을 다 받아 둔 구간(부분만 받은 구간과 구별)
  const moveTried = {};                        // 한 번이라도 물어본 구간 — 실패해도 다시 조르지 않는다(무한 반복 방지)
  let moveId = null, moveBusy = false;         // 시트가 열린 칸 id · 조회 중
  let movePre = false;                         // 도보 미리받기 진행 중
  const mpos = (p) => p && isN(p.lat) && isN(p.lon) ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : null;
  const mkey = (a, b) => { const x = mpos(a), y = mpos(b); return x && y ? x + '|' + y : null; };
  /* ItdaPlan.generate 주입 — 캐시에 있는 값만 준다. 없으면 null(엔진이 걷기 추정으로 간다) */
  function moveInfo(from, to, mode) {
    const k = mkey(from, to); if (!k) return null;
    const m = (moveCache[k] || {})[mode];
    return m && m.ok && isN(m.min) ? { min: m.min, mode, fare: isN(m.fare) ? m.fare : null, source: m.source || null } : null;
  }
  async function loadMove(from, to, modes) {
    const k = mkey(from, to); if (!k || !SERVER) return null;
    if (moveFull[k]) return moveCache[k];
    const q = modes ? `&modes=${modes}` : '';
    const d = await netJson(`${SERVER}/move?from=${mpos(from)}&to=${mpos(to)}${q}&companion=${companionOf()}`, null, NET_MOVE_MS);
    if (!d || !d.modes) return null;
    moveCache[k] = Object.assign(moveCache[k] || {}, d.modes);
    if (!modes) moveFull[k] = true;                            // 세 수단을 다 물어본 구간만 '완료'로 표시
    return moveCache[k];
  }
  /* 일정 화면이 뜰 때 칸 사이 '도보'만 미리 받아 둔다 — 직선 추정 대신 실제 보행 경로 시간으로 일정을 잰다.
   * 대중교통(ODsay 무료 30건/일)은 부르지 않는다. 한 번 물어본 구간은 실패해도 다시 조르지 않는다. */
  async function prefetchWalk(pl) {
    if (movePre || !SERVER || !pl || !Array.isArray(pl.slots)) return;
    const legs = [];
    for (const s of pl.slots) {
      if (s.skipped || !s.place || !s.from) continue;
      const k = mkey(s.from, s.place);
      const want = chosenMove(s.id);
      const all = !!(want && want !== 'walk');                  // 이미 택시·대중교통으로 정해 둔 구간이면 그 값까지 받는다(저장분 복원 대비)
      if (!k) continue;
      const done = moveTried[k];                                // true = 도보만 물어봄 · 'all' = 세 수단 다 물어봄
      if (done === 'all' || (done && !all)) continue;
      moveTried[k] = all ? 'all' : true;                        // 한 번 물어본 구간은 실패해도 다시 조르지 않는다
      legs.push({ from: s.from, to: s.place, all });
      if (legs.length >= MOVE_PREFETCH_MAX) break;
    }
    if (!legs.length) return;
    movePre = true;
    for (const l of legs) {
      try { await loadMove(l.from, l.to, l.all ? null : 'walk'); } catch (e) { console.warn('walk prefetch', e && e.message); }
    }
    movePre = false;
    rebuild(); renderPlan();                                   // 받은 실경로 시간으로 도착 시각을 다시 잰다
  }
  /* 일정에 쓸 취향 — 내 정보(itda.prefs.v1) 위에 '이번에 말로 지정한 것'(state.askPrefs)을 덮는다.
   * "양식 식당에서 밥먹고"라고 말하면 저장된 취향이 뭐든 이번 일정은 양식이 앞선다. 저장은 하지 않는다. */
  function prefsForPlan() {
    const base = state.prefs || null, ask = state.askPrefs || null;
    if (!ask || !ask.food) return base;
    const p = Object.assign({ v: 1, food: [], companion: 'none', avoid: [], walkMax: walkMaxOf() }, base || {});
    p.food = [ask.food];
    return p;
  }
  const planWalkMax = () => { const pl = state.plan; return pl && isN(pl.maxWalk) ? pl.maxWalk : walkMaxOf(); };   // 화면 문구는 '이 일정을 짤 때 쓴 상한'을 쓴다
  const intentsOf = () => { const a = Array.isArray(state.intents) ? state.intents.filter(Boolean) : []; return a.length ? a : [state.intent || 'none']; };   // v3: 다중 의도(없으면 state.intent 하나)
  function todaysDeps() {                                        // 오늘 시간표(분 배열) — 회랑이 없으면 null
    const c = state.card; const row = c && c.zone && CORRIDORS[`${c.zone}|${state.dest}`]; if (!row) return null;
    const day = new Date().getDay(); const deps = (day === 0 || day === 6) ? row.weekend : row.weekday;
    return Array.isArray(deps) ? deps.map(t2m) : null;
  }
  function buildPlanWith(edits, ai) {   // ai: undefined면 지금 AI 결과(state.planAi), null이면 규칙 엔진만
    if (!state.loc.lat) return null;
    const c = state.card, now = nowMin(), zone = zoneOf(), intents = intentsOf();
    const inb = INBOUND[`${state.loc.key}|${zone}`];
    let startAt = now, startPos = { lat: state.loc.lat, lon: state.loc.lon }, transit = null;
    if (inb && c && !c.taxi && !c.none && !c.noDest) {          // 경기장 → 충장로처럼 회랑 동네로 이동해서 노는 경우
      const t = inb.walk + inb.wait + inb.ride; transit = { line: inb.line, dir: inb.dir, stop: inb.stop, alight: inb.alight, min: t, arrive: now + t };
      startAt = now + t; startPos = inb.alightPos;
    }
    const ret = ItdaPlan.normalizeReturn({ card: c, hour: state.hour, minute: state.minute, buffer: state.buffer, dest: state.dest, destName: (DESTS[state.dest] || DESTS.none).name, now, deps: todaysDeps() });
    const plan = ItdaPlan.generate({ now, startAt, startPos, places: placesList(), intent: intents[0], intents, companion: companionOf(), walkMin: ItdaMap.walkMin, maxWalk: walkMaxOf(), moveInfo, ret, edits, areaName: areaName(), transit,
      prefs: prefsForPlan(), tasteMap: state.tasteMap || null, ai: ai === undefined ? (state.planAi || null) : ai });   // 취향 정렬·AI 지정(설계 §5) — 엔진이 아직 모르는 옵션이면 그냥 무시된다
    plan.transit = transit;
    if (plan.builtAt === undefined) plan.builtAt = now; if (plan.startAt === undefined) plan.startAt = startAt; if (!plan.startPos) plan.startPos = startPos;
    if (plan.exitAt === undefined && plan.exit) plan.exitAt = plan.exit.leave;
    return plan;
  }
  function buildPlan() {
    const key = intentsOf().join('+');                           // 칸 id의 뜻이 바뀌므로(고른 종류·순서) 편집을 갈아끼움
    if (!state.planEdits || state.planEdits.intent !== key) state.planEdits = ItdaPlan.emptyEdits(key);
    if (!Array.isArray(state.planUndo)) state.planUndo = [];
    return buildPlanWith(state.planEdits);
  }
  function rebuild() { state.plan = buildPlan(); }
  const areaName = () => zoneOf() || state.dong || (state.loc.name && state.loc.name !== '광주' ? state.loc.name : null) || '이 동네';
  /* POST /plan/ai 요청 본문(설계 §4). 규칙 엔진으로 한 번 짜서 칸·자리를 얻고, 그 자리 기준 칸별 후보 ≤10을 모은다.
   * 여기서는 AI 없이 짠다 — 지금 AI 결과가 다음 요청의 후보를 물들이지 않게. 통신은 flow.js(fetchPlanAi)가 한다. */
  async function aiRequest() {
    if (!state.loc.lat || !window.ItdaPlan || typeof ItdaPlan.candidates !== 'function') return null;
    const pl = buildPlanWith(state.planEdits, null);
    if (!pl || !Array.isArray(pl.slots)) return null;
    const o = candOpts(), slots = [], froms = [];
    let pos = pl.startPos;
    for (const sl of pl.slots) {
      if (!sl || !pos) break;
      const picked = ItdaPlan.candidates(sl.cat, pos, o, usedIds(pl, sl.id)).slice(0, AI_CANDS);
      const cands = picked.map(c => ({ id: String(c.p.id), name: String(c.p.name || ''), sub: String(c.p.sub || ''), walk: isN(c.walk) ? c.walk : null, trust: c.p.trust === 'verified' ? 'verified' : 'unknown' }));
      if (cands.length) {
        slots.push({ id: sl.id, cat: sl.cat, stay: isN(sl.stay) ? sl.stay : null, candidates: cands });
        froms.push({ from: { lat: pos.lat, lon: pos.lon }, places: picked.map(c => c.p) });
      }
      if (sl.place && isN(sl.place.lat) && isN(sl.place.lon)) pos = sl.place;
      if (slots.length >= AI_SLOTS) break;
    }
    if (!slots.length) return null;
    await rerankByWalk(slots, froms);                            // 직선거리 순서를 보도 거리 순서로 갈아끼운다(실패하면 그대로)
    const ex = pl.exit || null;
    return { prefs: prefsForPlan() || {}, who: state.who || null, now: hm24(nowMin()),
      leave: ex && ex.mode !== 'free' && isN(ex.leave) ? hm24(ex.leave) : null, area: areaName(), slots };
  }
  /* 후보의 walk(직선×1.2 추정)을 서버가 잰 보도 거리로 바꾸고 다시 정렬한다 — 앞 칸부터 WALK_NEAR_SLOTS개, 칸마다 앞 WALK_NEAR_CANDS곳.
   * 칸의 출발 자리는 '규칙 엔진이 고른 앞 칸 장소'다. AI가 앞 칸을 다른 곳으로 바꾸면 뒤 칸 기준점이 조금 달라지지만,
   * 같은 동네 안 후보라 순서는 거의 그대로다 — 확정된 일정의 이동 시간은 화면이 뜬 뒤 /move 로 다시 잰다(loadMove).
   * 서버가 없거나 느리거나 어느 후보를 못 재면 그 후보는 직선 추정 그대로 둔다(값을 지어내지 않는다). */
  async function rerankByWalk(slots, froms) {
    if (!SERVER) return;
    const jobs = [];
    for (let i = 0; i < slots.length && i < WALK_NEAR_SLOTS; i++) {
      const f = froms[i], sl = slots[i];
      if (!f || !isN(f.from.lat) || !isN(f.from.lon)) continue;
      const targets = f.places.slice(0, WALK_NEAR_CANDS)
        .filter(p => p && isN(p.lat) && isN(p.lon))
        .map(p => ({ id: String(p.id), lat: p.lat, lon: p.lon }));
      if (targets.length < 2) continue;                          // 후보가 하나면 순서를 바꿀 일이 없다
      jobs.push({ sl, body: { origin: f.from.lat + ',' + f.from.lon, companion: companionOf(), targets } });
    }
    if (!jobs.length) return;
    let done = 0;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), WALK_NEAR_MS);
    try {
      await Promise.all(jobs.map(async (j) => {
        const r = await fetch(SERVER + '/walk/near', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j.body), signal: ctrl.signal });
        if (!r.ok) return;
        const d = await r.json();
        if (!d || !d.ok || !Array.isArray(d.rows)) return;
        const min = {};
        for (const row of d.rows) if (row && row.ok && isN(row.min) && row.source !== 'straight') min[String(row.id)] = row.min;   // 직선 폴백은 안 쓴다 — 이미 그 값으로 정렬돼 있다
        if (!Object.keys(min).length) return;
        for (const c of j.sl.candidates) if (min[c.id] !== undefined) c.walk = min[c.id];
        j.sl.candidates.sort((a, b) => (isN(a.walk) ? a.walk : 999) - (isN(b.walk) ? b.walk : 999));
        done++;
      }));
    } catch (e) { /* 시간 초과·통신 끊김 — 직선 순서 그대로 간다 */ }
    finally { clearTimeout(t); }
    console.log('walk rerank', done + '/' + jobs.length + '칸 보도 기준');
  }

  // ---------- 파생값 ----------
  const markers = (pl) => pl.slots.filter(s => s.place && !s.skipped && isN(s.place.lat) && isN(s.place.lon)).map(s => ({ p: s.place, n: s.n, fixed: !!s.fixed, tight: !!s.tight }));
  const route = (pl) => [pl.startPos, ...markers(pl).map(m => m.p), ...(pl.exit && pl.exit.hubPos ? [pl.exit.hubPos] : [])];
  const fixedCount = () => Object.keys((state.planEdits && state.planEdits.fixed) || {}).length;
  const destName = () => (DESTS[state.dest] || DESTS.none).name;
  const destKind = () => (DESTS[state.dest] || DESTS.none).kind;
  const KO = (cat) => ItdaPlan.KO[cat] || cat, PK = (cat) => ItdaPlan.PLACE_KO[cat] || ItdaPlan.KO[cat] || '곳';
  // 시간 배지: '오후 4:01 ~ 4:46'(같은 오전/오후면 뒤는 시:분만) — 카드 상단·홈 위젯 공용
  const hm = (m) => { if (!isN(m)) return '--:--'; m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m / 60), mm = m % 60; return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(mm).padStart(2, '0')}`; };
  const span = (a, b) => { const A = hm(a), B = hm(b); return `${A} ~ ${A.slice(0, 2) === B.slice(0, 2) ? B.slice(3) : B}`; };
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bold = (s, times) => {                                   // 문장 속 시각(나갈·도착)만 강조색 — 긴 시각부터, '오후 6시'가 '오후 6시 53분'의 앞부분에 걸리지 않게
    const ts = times.filter(Boolean).map(String).sort((a, b) => b.length - a.length); if (!ts.length) return esc(s);
    return esc(s).replace(new RegExp(`(?:${ts.map(reEsc).join('|')})(?! ?\\d+분)`, 'g'), m => `<b class="num">${m}</b>`);
  };
  const booked = (sl) => sl && sl.booking && (sl.booking.status === 'reserved' || sl.booking.status === 'paid') ? sl.booking.status : null;   // v3 §7 예약 메타

  // ---------- 렌더 ----------
  function renderPlan() {
    if (getCur() !== 'scrPlan') { hideSnack(true); return; }    // 화면을 떠나면 되돌리기·스낵바를 비운다(§3.3)
    if (drag) dragCancel('render');                              // 다시 그리는 동안 끌기 중이면 원복(상태 머신 → idle)
    const list = $('planList'), main = $('planSumMain'), sub = $('planSumSub'), note = $('planNote');
    list.innerHTML = ''; sub.innerHTML = ''; note.innerHTML = ''; $('planMap').hidden = true; $('btnPlanAdd').hidden = true;
    if (!state.loc.lat) { main.innerHTML = `${ic('map-pin')}위치부터 잡아 주세요`; return; }
    if (state.cardPending) { main.innerHTML = `${ic('clock')}계산 중…`; return; }
    if (!state.plan) rebuild();
    const pl = state.plan; if (!pl) { main.innerHTML = `${ic('triangle-alert')}일정을 못 짰어요`; return; }
    const ex = pl.exit || { mode: 'free', leave: null }, mode = ex.mode, leaveK = isN(ex.leave) ? kor(ex.leave) : '아직 몰라요';
    const pastMidnight = ex.leave >= DAY_MIN || (state.card && state.card.none && state.card.code === 'past_midnight');
    if (pastMidnight) {   // 자정을 넘는 차는 계산하지 않는다(추측 금지) — 요약만 남기고 목록·버튼은 숨긴다
      main.innerHTML = `${ic('triangle-alert')}자정 넘는 일정은 계산 못 해요`;
      $('btnPlanRedo').hidden = true; $('btnPlanGo').hidden = true; return;
    }
    $('btnPlanRedo').hidden = false; $('btnPlanGo').hidden = false;
    // 요약: 큰 시각 1개 + 아이콘 메타 1줄(clock 시작~끝 · footprints 총 도보 · 할 일 아이콘) — 기준 §4 일정 탭
    main.innerHTML = mode === 'free' ? freeSummary(planStats(pl))                 // 시각을 안 정했으면 마무리 시각이 없다 — 총 소요·칸 수로(2026-09-04 결정)
      : mode === 'time' ? `<b class="num">${leaveK}</b>까지예요`
      : mode === 'unknown' ? `<b class="num">${leaveK}</b>엔 ${esc(destName())}에 계셔야 해요`
      : `<b class="num">${leaveK}</b>에 나가요`;
    sub.innerHTML = summaryMeta(pl, ex);
    list.innerHTML = planRows(pl, ex, mode).join('');
    $('btnPlanAdd').hidden = mode !== 'free' && pl.spare >= SPARE_MIN;   // 남는 시간 행에 버튼이 있으면 아래 버튼은 숨긴다(한 화면에 같은 버튼 둘 금지). free는 그 행이 없으므로 항상 열어 둔다
    note.innerHTML = `${ic('circle-help')}영업 미확인 · 닫혀 있으면 ‘빼기’${state.placesSource !== 'server' ? ` · ${ic('triangle-alert')}가게 자료 일부만` : ''}`;   /* 이 화면의 유일한 힌트(기준 §5-3) */
    $('btnPlanRedo').innerHTML = `${ic('arrow-left-right')}다시 짜기`;
    $('btnPlanGo').innerHTML = `${ic('check')}${state.planConfirmed ? '정했어요' : wasConfirmed ? '바뀐 일정으로' : '이 일정으로'}`;
    drawPlanMap(pl, ex);
    applyProgress(false);   // 다시 그려도 '여기·다음·지나온 칸' 표시는 유지(스크롤은 판정이 바뀔 때만)
    prefetchWalk(pl);       // 칸 사이 도보를 실경로 시간으로 — 받아 오면 스스로 한 번 더 그린다(대중교통은 안 부른다)
  }
  /* free 모드 요약: 마무리 시각을 만들지 않으므로 큰 시각 대신 '지금부터 약 2시간 30분 · 3곳'(총 소요·칸 수) */
  function freeSummary(st) {
    if (!st || !st.done || !st.total) return `${ic('clock')}오늘 둘러보기`;
    return `지금부터 <b class="num">약 ${dur(st.total)}</b> · <b class="num">${st.done}곳</b>`;
  }
  /* 요약 아이콘 메타 1줄: clock 시작~끝 · footprints 총 도보 · 할 일 아이콘 (기준 §4 일정 탭) */
  function summaryMeta(pl, ex) {
    const kinds = intentsOf().filter(i => i !== 'none');
    const fill = pl.slots.filter(s => !s.skipped && isN(s.arrive) && isN(s.end));
    const sM = fill.length ? fill[0].arrive : null, eM = (ex.mode !== 'free' && isN(ex.leave)) ? ex.leave : (fill.length ? fill[fill.length - 1].end : null);   // free는 마무리 시각이 없다 — 마지막 칸 끝까지만
    const walkSum = pl.slots.reduce((a, s) => a + (!s.skipped && isN(s.walk) ? s.walk : 0), 0) + (isN(ex.walkToHub) ? ex.walkToHub : 0);
    const meta = [];
    if (isN(sM) && isN(eM)) meta.push(`<span class="p-meta num">${ic('clock')}${span(sM, eM)}</span>`);
    if (walkSum > 0) meta.push(`<span class="p-meta num" role="img" aria-label="총 도보 ${walkSum}분">${ic('footprints')}${walkSum}분</span>`);
    if (kinds.length) meta.push(`<span class="p-meta" role="img" aria-label="할 일: ${esc(kinds.map(KO).join(', '))}">${kinds.map(catIc).join('')}</span>`);
    return meta.join('');
  }
  /* 목록 행: 지금 위치 → (진입 교통) → 칸들 → 남는 시간 → 역·택시 → 나가기 */
  function planRows(pl, ex, mode) {
    const rows = [];
    const gps = state.loc.status === 'unlisted' || state.loc.status === 'failed';
    rows.push(`<div class="p-row edge">${ic('map-pin')}<b>${esc(state.loc.name || '지금 위치')}</b>${gps ? '<span>GPS</span>' : ''}</div>`);
    if (pl.transit) rows.push(`<div class="p-walk bus num">${ic('bus-front')}${esc(pl.transit.line)} ${pl.transit.min}분<small>${kor(pl.transit.arrive)} ${esc(pl.transit.alight)}</small></div>`);
    pl.slots.forEach((sl, i) => { try { rows.push(slotRow(sl, ex, i, pl.slots.length)); } catch (err) { console.warn('[plan-ui] 칸을 못 그렸어요(건너뜀)', sl, err); } });   // 자료가 망가진 칸 하나 때문에 목록 전체가 사라지지 않게
    const spare = pl.spare;
    if (spare >= SPARE_MIN && mode !== 'free') rows.push(`<div class="p-row spare">${ic('clock')}<span>남는 시간</span><b class="num">${dur(spare)}</b><span class="grow"></span><button class="more" type="button" data-act="add">한 곳 더</button></div>`);
    if (mode === 'timetable') rows.push(`<div class="p-walk hub strong num">${ic('footprints')}${esc(ex.hub || '역')} ${ex.walkToHub != null ? ex.walkToHub : '?'}분</div>`);
    else if (mode === 'taxi') rows.push(`<div class="p-walk hub strong num">${ic('car-taxi-front')}택시${ex.ride != null ? ` ${ex.ride}분` : ''}</div>`);
    if (mode !== 'free') rows.push(exitRow(pl));   // 시각을 안 정했으면 마무리(나가기) 카드를 안 만든다(2026-09-04 결정)
    return rows;
  }
  /* 지도 썸네일: 번호 마커·점선·역 라벨. SDK·자료 없으면 숨김 */
  function drawPlanMap(pl, ex) {
    if (!window.ItdaMap || !window.PLACES_DATA) return;
    $('planMap').hidden = false;
    const noMap = () => { $('planMap').hidden = true; };
    try { Promise.resolve(drawMap('planMapCanvas', { preview: true, onlyNumbered: true, numbered: markers(pl), route: route(pl), hub: ex.hubPos ? { pos: ex.hubPos, label: ex.hub || '역' } : null }))
      .then(() => { if (!$('planMapCanvas').children.length) noMap(); }, noMap); }   // drawMap은 SDK 실패를 삼키고 warn만 남긴다 → 지도가 안 생겼으면(자식 없음) 목록만 보여준다
    catch (e) { noMap(); }
  }
  const HANDLE = `<button type="button" class="p-handle" data-act="drag" aria-label="끌어서 순서 바꾸기">${ic('grip-vertical')}</button>`;
  const upDown = (idx, total) => `<div class="p-minis"><button type="button" class="mini" data-act="up" aria-label="위로 올리기"${idx <= 0 ? ' disabled' : ''}>${ic('chevron-up')}</button><button type="button" class="mini" data-act="down" aria-label="아래로 내리기"${idx >= total - 1 ? ' disabled' : ''}>${ic('chevron-down')}</button></div>`;   // H1: .p-acts 2×2 grid, .p-minis 한 칸에 ▲▼
  /* 카드 구조(기준 §4 일정 카드): [상단] clock 시간범위·소요 + 종류 아이콘 태그 + 핸들 / [중앙] 번호+이름+chevron / [배지] n/N·미확인·고정·경고 / [하단] 바꾸기·빼기·고정·▲▼.
   * 부제 줄(관광지·카페)과 '동네 한 바퀴만…' 문장은 삭제(B급). 아이콘 단독은 핸들·▲▼·이름 옆 chevron뿐이고 전부 aria-label을 단다. */
  /* 상단 줄: clock 시간범위·소요(시각을 모르면 체류만 — 지어낸 숫자는 안 쓴다) + 종류 아이콘 태그 */
  function slotTop(sl) {
    const okTime = isN(sl.arrive) && isN(sl.end);
    return `<div class="p-tl"><span class="p-tbadge num">${ic('clock')}${okTime ? `${span(sl.arrive, sl.end)} · ${sl.end - sl.arrive}분` : `${sl.stay}분`}</span><span class="p-tag ${sl.cat}">${catIc(sl.cat)}${KO(sl.cat)}</span></div>`;
  }
  /* 빈 칸: 노랑 점선, 사유는 배지, 조작은 원인별(+ 순서는 바꿀 수 있다) */
  function skipRow(sl, id, tl, ud) {
    const rejN = sl.rejected || ((state.planEdits.rejected && state.planEdits.rejected[String(sl.id)]) || []).length;
    const acts = [];
    if (sl.fixed) acts.push(`<button type="button" class="on" data-act="unfix">${ic('pin-off')}고정 해제</button>`);
    else if (rejN > 0 && sl.candidates > 0) acts.push(`<button type="button" data-act="clear">${ic('undo-2')}처음부터</button>`);
    acts.push(`<button type="button" class="quiet" data-act="remove">${ic('circle-minus')}빼기</button>`);
    const why = sl.reason ? `<div class="p-badges"><span class="bd warn">${ic('circle-help', 'bd-ic')}${esc(sl.reason)}</span></div>` : '';
    return `<article class="p-row skip${sl.fixed ? ' fixed' : ''}" ${id}><div class="p-top">${tl}${HANDLE}</div><div class="p-mid"><div class="p-num grey" aria-hidden="true"></div><div class="p-name plain">이 칸은 비워요</div></div>${why}<div class="p-acts">${acts.join('')}${ud}</div></article>`;
  }
  /* 이유 배지 글자 다듬기: 12자 상한(설계 §4). 서버가 더 길게 주면 단어 중간이 아니라 구분자에서 끊는다 */
  function shortWhy(t) {
    t = String(t).replace(/\s+/g, ' ').trim();
    if (t.length <= WHY_MAX) return t;
    let cut = t.slice(0, WHY_MAX);
    if (!/[\s·/]/.test(t.charAt(WHY_MAX))) cut = cut.replace(/[\s·/][^\s·/]*$/, '');
    return cut.replace(/[\s·/]+$/, '');
  }
  /* 채운 칸 배지: 예약·결제 / 고정 / 미확인 / n번째 / 늦음·빠듯 / 멀어요 */
  function slotBadges(sl, bk) {
    const badges = [];
    if (sl.why && !sl.aiFallback) badges.push(`<span class="bd ai">${ic('sparkles', 'bd-ic')}${esc(shortWhy(sl.why))}</span>`);   // AI가 고른 이유(설계 §6). 폴백 칸에는 안 붙는다
    if (bk) badges.push(`<span class="bd fx">${ic(bk === 'paid' ? 'credit-card' : 'calendar-check', 'bd-ic')}${bk === 'paid' ? '결제됨 · 테스트' : '예약됨'}</span>`);
    if (sl.fixed) badges.push(`<span class="bd fx">${ic('pin', 'bd-ic')}고정</span>`);
    if (sl.place) {
      if (sl.cat !== 'sight') badges.push(`<span class="bd un" role="img" aria-label="영업 여부 확인 안 됨">${ic('circle-help', 'bd-ic')}미확인</span>`);   // 영업 여부를 확인해 주는 곳이 없다 — 모른다고 밝힌다(제품 요구 ②)
      if (sl.seen) {                                           // seen 0 = 고정 가게가 걷기 상한 밖(분모에 없음). 숫자 배지로 줄이고 원문은 aria-label에 남긴다
        const full = sl.candidates > CANDS_MANY ? `가까운 순 ${sl.seen}번째` : `근처 ${PK(sl.cat)} ${sl.candidates}곳 중 ${sl.seen}번째`;
        badges.push(`<span class="bd num" role="img" aria-label="${esc(full)}">${ic('list', 'bd-ic')}${sl.seen}/${sl.candidates || sl.seen}</span>`);
      }
    }
    if (sl.late) badges.push(`<span class="bd warn num">${ic('triangle-alert', 'bd-ic')}${esc(sl.reason || `${sl.over}분 넘겨요`)}</span>`);
    else if (sl.tight) badges.push(`<span class="bd tight num">${ic('triangle-alert', 'bd-ic')}빠듯해요</span>`);
    { const lim = planWalkMax();
      if (isN(sl.walk) && sl.walk > lim) badges.push(`<span class="bd warn" role="img" aria-label="걸어서 ${sl.walk}분, 걷기 ${lim}분을 넘어요">${ic('triangle-alert', 'bd-ic')}멀어요</span>`); }
    return badges;
  }
  /* 이동 줄 — 누르면 이동수단 시트가 열린다. slot.move 가 있으면 그 수단·분·요금을, 없으면 걷기 추정을 보여 준다.
   * 고른 수단의 시간을 아직 못 구했으면(move.unknown) '미확인' 배지를 달아 계산 근거를 숨기지 않는다. */
  function moveRow(sl) {
    const mv = sl.move || null, mode = mv && mv.mode ? mv.mode : 'walk';
    const min = mv && isN(mv.min) ? mv.min : (isN(sl.walk) ? sl.walk : 0);
    const body = min ? `${ItdaPlan.MOVE_KO[mode] || ''} ${min}분` : '바로 이어서';
    const fare = mv && isN(mv.fare) ? `<span class="p-meta num">${mv.fare.toLocaleString()}원</span>` : '';
    const unk = mv && mv.unknown ? `<span class="bd warn num">${ic('circle-help', 'bd-ic')}미확인</span>` : '';
    const inner = `${ic(MOVE_IC[mode] || MOVE_IC.walk)}${body}${fare}${unk}`;
    if (!sl.place || !sl.from) return `<div class="p-walk num">${inner}</div>`;   // 가게 없는 칸(동네 산책)·출발 자리 모름 → 고를 게 없으니 예전처럼 그냥 줄
    return `<button type="button" class="p-walk pick num" data-act="mode" data-id="${sl.id}" aria-label="가는 방법 ${body}. 눌러서 바꾸기">`
      + `${inner}<span class="chev" aria-hidden="true">${ic('chevron-right')}</span></button>`;
  }
  function slotRow(sl, ex, idx, total) {
    const id = `data-id="${sl.id}"`, ud = upDown(idx, total), tl = slotTop(sl);
    if (sl.skipped) return skipRow(sl, id, tl, ud);
    const walk = moveRow(sl);
    const bk = booked(sl);
    const badges = slotBadges(sl, bk);
    const bd = badges.length ? `<div class="p-badges">${badges.join('')}</div>` : '';
    if (!sl.place) {                                           // 구경(관광지 없음) = 가게 없이 동네 산책 (바꾸기·고정 없음, 순서·빼기만)
      return `${walk}<article class="p-row slot sight" ${id}><div class="p-top">${tl}${HANDLE}</div><div class="p-mid"><div class="p-num walkico" aria-hidden="true">${ic('footprints')}</div><div class="p-name plain">${esc(sl.name)}</div></div>${bd}<div class="p-acts"><button type="button" class="quiet" data-act="remove">${ic('circle-minus')}빼기</button>${ud}</div></article>`;
    }
    // 조작 줄은 2×2 그리드: 바꾸기 · 빼기 / 고정 · ▲▼ (고정 칸은 '빼기' 대신 '고정 해제'만)
    // v3 §7: 예약·결제된 칸은 '빼기/바꾸기'를 아예 안 보여준다(예약된 일정은 고정 조건) — 바꾸려면 '예약 바꾸기'로 확인부터
    const fixBtn = bk ? '' : sl.fixed ? `<button type="button" class="on" data-act="unfix">${ic('pin-off')}고정 해제</button>` : `<button type="button" data-act="fix">${ic('pin')}고정</button>`;
    const bookBtn = bk
      ? `<button type="button" class="on" data-act="cancel">${ic(bk === 'paid' ? 'credit-card' : 'calendar-check')}취소</button>`
      : `<button type="button" data-act="book">${ic('calendar-check')}예약</button>`;   // 예약·결제(설계 §4) — 예약된 칸은 배지 + '취소'
    const acts = bk
      ? `${bookBtn}<button type="button" data-act="swap">${ic('arrow-left-right')}바꾸기</button>${ud}`
      : `${bookBtn}<button type="button" data-act="swap">${ic('arrow-left-right')}바꾸기</button>${sl.fixed ? '' : `<button type="button" data-act="no">${ic('circle-minus')}빼기</button>`}${fixBtn}${ud}`;
    return `${walk}<article class="p-row slot${sl.fixed ? ' fixed' : ''}${bk ? ' booked' : ''}${sl.late ? ' late' : ''}" ${id}><div class="p-top">${tl}${HANDLE}</div><div class="p-mid"><div class="p-num" aria-hidden="true">${sl.n != null ? sl.n : ''}</div><button type="button" class="p-name" data-act="detail" aria-label="${esc(sl.name)} 자세히 보기">${esc(sl.name)} <span class="chev" aria-hidden="true">${ic('chevron-right')}</span></button></div>${bd}<div class="p-acts">${acts}</div></article>`;
  }
  /* 나가기 카드(기준 §4): 핵심 1문장(= ItdaPlan.exitSentence — '듣기' TTS와 같은 문장이라 데이터는 그대로) + 아이콘 메타 행 + 배지 + details.
   * 부연 문장 2개(모드별 subT, mainH 뒤에 붙던 설명 절)는 삭제하고 메타·배지로 옮겼다. */
  /* 나가기 카드의 모드별 알맹이 → { meta, badges, altQ, altT }. 사용자 문구는 여기 한곳에만 둔다 */
  function exitDetail(mode, ex, c, dn) {
    const meta = [], badges = [];
    let altQ = null, altT = null;
    if (mode === 'timetable') {
      if (ex.hub) meta.push(`${ic('train-front')}${esc(ex.hub)}`);
      if (isN(ex.board)) meta.push(`${ic('clock')}${kor(ex.board)} 탑승`);
      if (isN(ex.walkToHub)) meta.push(`${ic('footprints')}${ex.walkToHub}분`);
      badges.push(['clock', '시간표 기준'], ['circle-help', '실시간 아님']);
      altQ = '더 늦게 나가면?'; const a = ItdaPlan.altSentence(ex, kor); altT = a ? bold(a, [ex.alt ? kor(ex.alt.leave) : null]) : '다음 차는 역 여유가 안 남아요.';
    } else if (mode === 'taxi') {
      if (isN(ex.ride)) meta.push(`${ic('car-taxi-front')}${ex.ride}분`);
      meta.push(`${ic('flag')}${esc(dn)}`);
      badges.push(['car-taxi-front', '택시 기준'], ['triangle-alert', '정체 미반영']);
      altQ = '어떻게 계산했나요?'; altT = `${esc((c && c.note) || '길찾기 시간 × 1.2 + 택시 부르기 + 역 여유. 실시간 정체는 반영 못 해요.')} 밤에는 택시가 늦게 올 수 있으니 <b class="num">${kor(ex.leave - TAXI_CALL_EARLY)}</b>쯤 미리 부르세요.`;
    } else if (mode === 'time') {
      badges.push(['clock', '정하신 시각']);
      if (state.who !== 'citizen') { badges.push(['circle-help', '타는 곳 미정']); altQ = '타는 곳을 정하면?'; altT = '확인 화면에서 ‘광주송정역’이나 ‘유스퀘어’를 고르면 가는 시간을 빼고 다시 계산해요.'; }
    } else if (mode === 'free') {
      badges.push(['clock', '저희가 잡은 값']);
      altQ = '시각을 정하면?'; altT = '홈에서 시각을 정하면 다시 계산해요.';
    } else {                                                   // unknown: 가는 시간 확인 못 함 — 역 여유만 뺀 시각
      meta.push(`${ic('flag')}${esc(dn)}`, `${ic('clock')}여유 ${state.buffer}분`);
      badges.push(['triangle-alert', '가는 시간 미확인']);
      altQ = '왜 확인 못 했나요?'; altT = esc((c && c.reason) || `이 동네에서 ${dn}까지 가는 길은 아직 확인 못 했어요. 1330에 물어보세요.`);
    }
    return { meta, badges, altQ, altT };
  }
  function exitRow(pl) {
    const ex = pl.exit, mode = ex.mode, c = state.card, leaveK = isN(ex.leave) ? kor(ex.leave) : '아직 몰라요', dn = destName(), dk = destKind();
    const st = { timetable: '역', taxi: '택시', time: '시각', free: '시간', unknown: '역' }[mode] || '역';
    const sent = ItdaPlan.exitSentence(ex, kor, dk) || '';
    const mainH = bold(sent, [leaveK, isN(ex.arrive) ? kor(ex.arrive) : null]);
    const { meta, badges, altQ, altT } = exitDetail(mode, ex, c, dn);
    const warns = [];
    if (ex.late) warns.push(`${ex.over}분 넘겨요`);
    if (ex.past) warns.push('지금 바로 나가세요');
    const ebk = exitBooked();
    const bd = (ebk ? `<span class="bd fx">${ic(ebk === 'paid' ? 'credit-card' : 'calendar-check', 'bd-ic')}${ebk === 'paid' ? '결제됨 · 테스트' : '예매됨'}</span>` : '')
      + badges.map(b => `<span class="bd">${ic(b[0], 'bd-ic')}${b[1]}</span>`).concat(warns.map(w => `<span class="bd warn num">${ic('triangle-alert', 'bd-ic')}${w}</span>`)).join('');
    const eact = mode === 'timetable' || mode === 'taxi' || mode === 'unknown'   // 차편이 있는 나가기에만 예매 버튼(시각만 정한 칸은 예매할 게 없다)
      ? `<div class="p-acts one">${ebk ? `<button type="button" class="on" data-act="cancel">${ic(ebk === 'paid' ? 'credit-card' : 'calendar-check')}취소</button>` : `<button type="button" data-act="book">${ic('calendar-check')}예매</button>`}</div>` : '';
    return `<article class="p-row exit${ex.late ? ' late' : ''}${ebk ? ' booked' : ''}" data-id="exit"><div class="p-top"><div class="p-num st">${st}</div><div class="p-time num">${ic('arrow-right-from-line')}${leaveK} <small>${mode === 'timetable' || mode === 'taxi' ? '나가기' : '마무리'}</small></div></div><div class="p-ret-main num">${mainH}</div>${meta.length ? `<div class="p-meta num">${meta.join('')}</div>` : ''}<div class="p-badges">${bd}</div>${altQ ? `<details><summary>${altQ}</summary><div class="p-alt num">${altT}</div></details>` : ''}${eact}</article>`;
  }

  // ---------- 편집 (모든 편집은 op로 — 되돌리기 1단계·재생성·저장) ----------
  /* 이동 전후 비교용 요약(§2b): 총 소요·나갈 시각·늦는 칸·비운 칸 — 칸 번호는 화면에 보이는 순서(1부터) */
  function planStats(pl) {
    if (!pl || !Array.isArray(pl.slots)) return null;
    const pos = {}; pl.slots.forEach((s, i) => { pos[s.id] = i + 1; });
    const filled = pl.slots.filter(s => !s.skipped && isN(s.arrive) && isN(s.end));
    const first = filled[0], last = filled[filled.length - 1];
    return {
      leave: pl.exit && isN(pl.exit.leave) && pl.exit.mode !== 'free' ? pl.exit.leave : null,   // free는 마무리 시각이 없다 — 이동 요약·토스트에도 안 넣는다
      total: first && last ? last.end - first.arrive : 0,
      start: first ? first.arrive : null, end: last ? last.end : null, done: filled.length, pos,
      late: pl.slots.filter(s => s.late).map(s => ({ id: s.id, over: isN(s.over) ? s.over : 0, n: pos[s.id] })),
      skipped: pl.slots.filter(s => s.skipped).map(s => ({ id: s.id, cat: s.cat, n: pos[s.id] })),
    };
  }
  /* (§2a) 옮긴 결과로 늦어지거나 비워진 칸이 생기면 정확히 알린다 + (§2b) 총 소요·나갈 시각 변화 요약 */
  function moveReport(a, b) {
    if (!a || !b) return null;
    const had = (l, id) => l.some(x => x.id === id);
    const warns = b.late.filter(x => !had(a.late, x.id)).map(x => `${x.n}번 칸 ${x.over}분 늦어요`)
      .concat(b.skipped.filter(x => !had(a.skipped, x.id)).map(x => `${x.n}번 칸 비워졌어요`));
    const dT = b.total - a.total, sum = [];
    if (b.total) sum.push(`총 ${dur(b.total)}${dT ? ` (${dT > 0 ? '+' : '−'}${Math.abs(dT)}분)` : ''}`);
    if (b.leave !== null) sum.push(`나가기 ${kor(b.leave)}`);
    return { warn: warns.join(' · '), sum: sum.join(' · ') };
  }
  function flash(el) {                                          // flash 클래스는 flow.css(H1). 다시 붙이려면 한 번 떼고 리플로를 강제해야 애니메이션이 재생된다
    if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), FLASH_MS);
  }
  function flashSlot(id) {                                       // (§2c) 놓은 카드 강조
    const list = $('planList'); if (!list || id === null || id === undefined) return;
    flash(list.querySelector(`.p-row[data-id="${id}"]`));
  }
  // ---------- GPS 진행 강조 (설계 §3: 텍스트는 안 붙이고 클래스만) ----------
  let userScrollAt = 0, autoScrollAt = 0;
  /* '여기'(state.progress.atId)·'다음'(nextId)·지나온 칸(visited)에 클래스를 붙인다. flow.js가 판정을 바꿀 때와 renderPlan 끝에서 부른다 */
  function applyProgress(doScroll) {
    const list = $('planList'); if (!list) return;
    const pr = (state && state.progress) || {};
    const atId = pr.atId == null ? null : String(pr.atId), nextId = pr.nextId == null ? null : String(pr.nextId);
    const visited = Array.isArray(pr.visited) ? pr.visited.map(String) : [];
    list.querySelectorAll('.p-row[data-id]').forEach(el => {
      const id = el.dataset.id, here = id === atId, next = !here && id === nextId;
      el.classList.toggle('here', here);
      el.classList.toggle('next', next);
      el.classList.toggle('done', !here && !next && visited.indexOf(id) >= 0);
    });
    if (doScroll) scrollToProgress(atId || nextId);
  }
  /* '여기'가 있으면 그 칸, 없으면 '다음' 칸을 sticky 요약 바로 아래로(scroll-margin-top 104px 규칙을 그대로 쓴다) */
  function scrollToProgress(id) {
    if (!id || drag) return;                                   // 끌고 있는 중엔 화면을 움직이지 않는다
    if (Date.now() - userScrollAt < SCROLL_HOLD_MS) return;     // 방금 손으로 스크롤했으면 양보
    const list = $('planList'); if (!list) return;
    const el = list.querySelector(`.p-row[data-id="${id}"]`); if (!el) return;
    autoScrollAt = Date.now();
    try { el.scrollIntoView({ block: 'start', behavior: REDUCED() ? 'auto' : 'smooth' }); } catch (e) { el.scrollIntoView(true); }
  }
  function enterPlan() { userScrollAt = 0; autoScrollAt = Date.now(); applyProgress(true); }   // 일정 탭 진입: 손 스크롤 기록을 비우고 한 번 맞춘다
  function onPlanScroll() {
    if (getCur() !== 'scrPlan' || drag) return;
    if (Date.now() - autoScrollAt < AUTO_SETTLE_MS) return;     // 우리가 시킨 스크롤
    userScrollAt = Date.now();
  }
  function op(o, label, msg) {
    if (state.cardPending) { toast('계산 중이에요'); return false; }
    if (state.plan && o && o.id !== undefined && o.id !== null && !Array.isArray(o.order)) o = Object.assign({}, o, { order: state.plan.slots.map(s => s.id) });   // 엔진이 '지금 있는 칸'을 판별할 수 있게 항상 현재 순서를 넘긴다(레드팀 RT-01)
    const beforeStats = planStats(state.plan), before = beforeStats ? beforeStats.leave : null;
    const prevJson = JSON.stringify(state.planEdits || null);
    state.planUndo = ItdaPlan.pushUndo(state.planUndo || [], state.planEdits, label);
    state.planEdits = ItdaPlan.applyEdit(state.planEdits, o);
    if ((o.t === 'move' || o.t === 'up' || o.t === 'down') && state.plan) {   // 순서를 옮겨도 그 칸의 가게는 따라간다(블록 이동 = 같은 가게). 고정 칸은 fixed가 이미 잡는다
      const sl = state.plan.slots.find(x => x.id === o.id);
      if (sl && sl.place && !sl.fixed) { const pick = Object.assign({}, state.planEdits.pick || {}); pick[String(o.id)] = sl.place.id; state.planEdits = Object.assign({}, state.planEdits, { pick }); }
    }
    if (JSON.stringify(state.planEdits) === prevJson) {          // 엔진이 모르는 op(applyEdit는 복사본만 돌려준다) — 되돌리기 항목을 남기지 않고 알린다
      const r = ItdaPlan.popUndo(state.planUndo); state.planUndo = r.stack;
      console.warn('[plan-ui] applyEdit이 바꾼 게 없음 — plan.js가 아직 이 op를 모르나요?', o);
      toast('이건 아직 안 돼요', undefined, 'triangle-alert'); renderPlan(); return false;
    }
    state.planConfirmed = false; rebuild(); renderPlan();
    const isMove = o.t === 'move' || o.t === 'up' || o.t === 'down';
    const rep = isMove ? moveReport(beforeStats, planStats(state.plan)) : null;
    snack(rep ? [msg || '순서를 바꿨어요', rep.warn || rep.sum].filter(Boolean).join(' · ') : (msg || label), 'check'); persist();
    if (isMove) flashSlot(o.id);
    const after = state.plan && state.plan.exit ? state.plan.exit.leave : null;
    if (rep && rep.warn) toast(rep.warn, undefined, 'triangle-alert');                        // 늦어진·비워진 칸이 있으면 그게 제일 급한 소식
    else if (after !== null && before !== null && before !== after) { flashExit(); toast(`나가기 ${kor(after)}`); }
    return true;
  }
  function undo() {
    const r = ItdaPlan.popUndo(state.planUndo || []); state.planUndo = r.stack;
    if (!r.entry) { hideSnack(); return; }
    state.planEdits = r.entry.edits; state.planConfirmed = false; rebuild(); renderPlan(); hideSnack(); persist(); toast('되돌렸어요', undefined, 'undo-2');
  }
  function act(a, id) {
    const pl = state.plan; if (!pl) return;
    const sl = slotOf(id);
    if (a === 'add') { openAddSheet(); return; }
    if (a === 'drag') return;                                  // 핸들은 pointer 이벤트로만(클릭은 아무것도 안 함)
    if (a === 'book') { openBookSheet(id); return; }            // 예약·예매 시트(나가기 칸 id='exit')
    if (a === 'cancel') { askCancel(id); return; }              // 예약된 칸은 승인부터(제품 요구)
    if (!sl) return;
    if (a === 'unbook') { askUnbook(sl); return; }             // v3 §7: 예약된 칸은 확인부터
    if (booked(sl) && (a === 'no' || a === 'swap' || a === 'remove')) { askUnbook(sl); return; }   // 예약된 일정은 고정 조건 — 변경은 사용자 승인 후
    if (a === 'no') { if (sl.place) op({ t: 'reject', id, placeId: sl.place.id }, '빼기', `${josa(sl.name, '을', '를')} 뺐어요`); }
    else if (a === 'fix') { if (sl.place) { op({ t: 'fix', id, placeId: sl.place.id }, '고정', `${josa(sl.name, '을', '를')} 정해뒀어요`); toast('정해뒀어요', undefined, 'check'); } }
    else if (a === 'unfix') openConfirm(sl, null);
    else if (a === 'swap') { if (sl.fixed) openConfirm(sl, 'swap'); else openSwap(sl); }   // 고정 칸은 고정 풀기 확인 뒤에 바꾸기 시트
    else if (a === 'up' || a === 'down') moveStep(sl, a);
    else if (a === 'remove') op({ t: 'remove', id }, '이 칸 빼기', '이 칸을 뺐어요');
    else if (a === 'clear') op({ t: 'clearRejected', id }, '처음부터', '처음 후보부터 다시 봤어요');
    else if (a === 'detail') openDetail(sl);
    else if (a === 'mode') openMoveSheet(sl);                  // 이동 줄 = 이 칸으로 오는 길의 이동수단 고르기
  }
  function moveStep(sl, dir) {                                  // ▲▼: 한 칸 위/아래. 맨 위/아래면 버튼이 disabled라 여기 안 온다
    const ids = state.plan.slots.map(s => s.id), i = ids.indexOf(sl.id);
    if ((dir === 'up' && i <= 0) || (dir === 'down' && i >= ids.length - 1)) return;
    op({ t: dir, id: sl.id, order: ids }, '순서 바꾸기', `${josa(sl.name || KO(sl.cat), '을', '를')} ${dir === 'up' ? '위' : '아래'}로 옮겼어요`);   // order = 현재 표시 순서(E: 보조 칸·intents 순서는 엔진이 모름)
  }
  function redoPlan() {                                        // '다시 짜기' = 고정 아닌 칸의 가게를 전부 다음 후보로(reshuffle). 되돌리기 가능
    if (state.cardPending) { renderPlan(); toast('계산 중이에요'); return; }
    if (!state.plan) rebuild(); const prev = state.plan; if (!prev) { renderPlan(); return; }
    const ids = pl => pl.slots.map(s => s.place ? s.place.id : '-').join('|');
    const movable = prev.slots.some(s => s.place && !s.fixed), fixedN = fixedCount();
    state.planAi = null;   // 다시 짜기 = 규칙 엔진으로 한 번 섞고, AI도 다시 부른다(설계 §6)
    state.planUndo = ItdaPlan.pushUndo(state.planUndo || [], state.planEdits, '다시 짜기');
    state.planEdits = ItdaPlan.reshuffle(state.planEdits, prev, ed => buildPlanWith(ed));
    state.planConfirmed = false; rebuild(); renderPlan(); persist();
    if (refreshAi) { try { Promise.resolve(refreshAi()).then(ok => { if (ok) persist(); }, () => {}); } catch (e) { /* AI가 없어도 규칙 엔진 결과로 간다 */ } }
    if (ids(state.plan) !== ids(prev)) snack('다시 짰어요', 'arrow-left-right');
    else { const r = ItdaPlan.popUndo(state.planUndo); state.planUndo = r.stack; if (r.entry) state.planEdits = r.entry.edits; rebuild(); renderPlan(); persist(); toast(movable ? '바꿀 곳이 없어요' : fixedN ? '다 고정돼 있어요' : '바꿀 칸이 없어요', undefined, 'triangle-alert'); }
  }
  function confirmPlan() {
    if (state.cardPending || !state.plan) { renderPlan(); return; }
    state.planConfirmed = true; wasConfirmed = true; persist(); hideSnack(true); renderPlan();
    const c = state.card, ex = state.plan.exit;
    if (c && !c.none && !c.noDest && c.leave !== undefined && ex) scheduleAlarm({ ...c, leave: ex.leave }, ItdaPlan.exitSentence(ex, kor, destKind()));   // 알람 본문 = 나가기 문장
    else if (ex && ex.mode === 'time' && ex.leave > nowMin()) scheduleAlarm({ leave: ex.leave, taxi: false, dest: destName() }, `${kor(ex.leave)}까지예요. 정하신 시각이 다 됐어요.`);   // 시민·타는 곳 없음: 정하신 시각 기준 알람
    else toast('이 일정으로 갈게요', undefined, 'check');
  }
  function persist() {                                         // §5-10 형식. 편집·확인 때마다 (v3: sig.intents 추가 — 구 필드 intent는 그대로)
    try {
      const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const locKey = state.loc.key || (state.loc.lat ? `${state.loc.lat.toFixed(3)},${state.loc.lon.toFixed(3)}` : null);
      localStorage.setItem(PLAN_KEY, JSON.stringify({ v: 1, day, savedAt: nowMin(), sig: { intent: state.intent, intents: intentsOf(), dest: state.dest, hour: state.hour, minute: state.minute, buffer: state.buffer, locKey }, edits: state.planEdits, confirmed: !!state.planConfirmed, ai: state.planAi || null }));
    } catch (e) { /* 저장 못 해도 화면은 정상 */ }
  }
  /* 홈 위젯용 한 줄 요약(H2가 #homePlan에 씀). state.plan 없으면 null — 단 저장 편집이 있고 계산 가능하면 한 번 짜 본다 */
  function summary() {
    if (!state.plan && state.loc && state.loc.lat && !state.cardPending && state.planEdits) { try { rebuild(); } catch (e) { state.plan = null; } }
    const pl = state.plan; if (!pl || !pl.exit) return null;
    const filled = pl.slots.filter(s => !s.skipped), names = filled.map(s => s.name).filter(Boolean);
    const leave = pl.exit.leave != null ? kor(pl.exit.leave) : null;
    const first = filled[0], last = filled[filled.length - 1], endM = pl.exit.leave != null ? pl.exit.leave : last ? last.end : null;
    const st = planStats(pl);                                    // 홈 위젯 밖에서도 쓰는 값(총 소요·나갈 시각·늦음) — 이동 뒤 갱신 확인용
    const text = pl.exit.mode === 'free' ? (st && st.total ? `오늘 일정 · 약 ${dur(st.total)}` : '오늘 일정')   // free는 끝 시각 대신 소요(2026-09-04 결정)
      : first && isN(first.arrive) && endM != null ? `오늘 일정 · ${span(first.arrive, endM)}` : leave ? `오늘 일정 · ${leave}${pl.exit.mode === 'timetable' || pl.exit.mode === 'taxi' ? ' 나가기' : '까지'}` : '오늘 일정';
    return { text, sub: names.length ? names.slice(0, SUM_NAMES).join(' → ') + (names.length > SUM_NAMES ? ' → …' : '') : '아직 채운 칸이 없어요',
      total: st ? st.total : 0, totalText: st && st.total ? dur(st.total) : '', leave: st ? st.leave : null, done: st ? st.done : 0, late: !!pl.late,
      booked: pl.slots.filter(s => booked(s)).length + (exitBooked() ? 1 : 0),
      reserved: pl.slots.filter(s => booked(s) === 'reserved').length + (exitBooked() === 'reserved' ? 1 : 0),
      paid: pl.slots.filter(s => booked(s) === 'paid').length + (exitBooked() === 'paid' ? 1 : 0) };
  }

  // ---------- 스낵바·강조 ----------
  function snack(msg, icon) { $('planSnackText').innerHTML = `${icon ? ic(icon) : ''}${esc(msg)}`; $('planSnackUndo').hidden = !(state.planUndo && state.planUndo.length); $('planSnack').hidden = false; }
  function hideSnack(clearUndo) { const s = $('planSnack'); if (s) s.hidden = true; if (clearUndo) state.planUndo = []; }
  /* '듣기' — 화면에서 지운 안내 문장(slotText)과 나가기 문장(exitSentence)을 이어 읽는다(기준 §1: 데이터는 남긴다) */
  function speakPlan() {
    const pl = state.plan, parts = [];
    if (slotText) { const t = slotText(); if (t) parts.push(t); }
    if (pl && pl.exit && pl.exit.mode !== 'free') { const t = ItdaPlan.exitSentence(pl.exit, kor, destKind()); if (t) parts.push(t); }
    if (!parts.length) parts.push('오늘 일정이에요.');
    if (!speak(parts.join(' '))) toast('소리 읽기 안 됨', 3500, 'volume-2');
  }
  function flashExit() { [$('planHead'), $('planList').querySelector('.p-row.exit')].forEach(el => flash(el)); }

  // ---------- 끌어서 순서 바꾸기 (Pointer Events · 롱프레스 600ms · 8px 넘게 움직이면 스크롤로 간주) ----------
  /* apple-design: 눌린 자리(grab offset)를 지켜 1:1 추적, 놓을 자리는 다른 칸 중심선 기준, 취소 시 임계감쇠 스프링으로 원복(현재 값·속도에서 시작), reduced-motion이면 즉시.
   * 상태 머신 — idle → pressing(누름·롱프레스 대기) → dragging(끌기) → dropping(놓음: op 적용) | cancelling(원복) → idle.
   *   모든 전이는 dragTeardown()을 지나간다: 포인터 캡처 해제 · 롱프레스 타이머 clearTimeout · 자동 스크롤 rAF cancel · dragging/drop-* 클래스 제거 · 전역 리스너 해제.
   *   경계 이탈(포인터가 창 밖·pointercancel·창 blur·탭 전환·화면 회전·Escape·다시 그리기)은 전부 cancelling → idle.
   *   포인터 추적은 리스트가 아니라 window에 건다(capture) — 손가락이 카드·리스트 밖으로 나가도 놓침이 없다.
   * 핸들에만 touch-action:none(H1 CSS). 놓으면 op({t:'move', id, to}) — to = 자기 칸을 뺀 순서 배열에 끼워 넣을 index(splice 의미). */
  const LONG_MS = 600, SLOP = 8, EDGE = 72, EDGE_DIV = 6, EDGE_MAX = 24;
  const HIST_MAX = 6;        // 속도 추정에 쓰는 최근 포인터 위치 수
  const VH_MIN = 200;        // 뷰포트 높이를 이보다 작게 읽으면 자동 스크롤 안 함(값을 못 믿는다)
  const SPRING_S = 0.35;     // 원복 스프링 response(초) — apple-design 임계감쇠
  const SPRING_EPS = 0.5;    // 이보다 가까우면 끝난 것으로 보고 transform을 지운다(px)
  let drag = null;          // { id, card, handle, pid, x0, y0, y, sc0, scroller, timer, raf, hist:[{y,t}], rows:[], target:{row,before}|null }
  let dragPhase = 'idle';   // 'idle' | 'pressing' | 'dragging' | 'dropping' | 'cancelling'
  let dragGuards = false;
  const dragState = () => dragPhase;                                        // 검증용(?debug=1 콘솔)
  function scrollerOf(el) { let n = el.parentElement; while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if (/(auto|scroll)/.test(o) && n.scrollHeight > n.clientHeight) return n; n = n.parentElement; } return document.scrollingElement || document.documentElement; }

  const onBoundary = () => dragCancel('boundary');                          // 창 blur·화면 회전
  const onPointerCancel = (e) => { if (!drag || e.pointerId === drag.pid) dragCancel('pointercancel'); };
  const onVisibility = () => { if (document.hidden) dragCancel('hidden'); };
  const onEsc = (e) => { if (e.key === 'Escape') dragCancel('escape'); };
  function bindDragGuards() {
    if (dragGuards) return; dragGuards = true;
    window.addEventListener('pointermove', dragMove, { capture: true, passive: false });
    window.addEventListener('pointerup', dragUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onBoundary);
    window.addEventListener('orientationchange', onBoundary);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onEsc, true);
  }
  function unbindDragGuards() {
    if (!dragGuards) return; dragGuards = false;
    window.removeEventListener('pointermove', dragMove, true);
    window.removeEventListener('pointerup', dragUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    window.removeEventListener('blur', onBoundary);
    window.removeEventListener('orientationchange', onBoundary);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('keydown', onEsc, true);
  }

  // idle → pressing
  function dragDown(e) {
    if (dragPhase !== 'idle' || drag || (e.button !== undefined && e.button !== 0)) return;
    const h = e.target && e.target.closest ? e.target.closest('.p-handle') : null; if (!h) return;
    const card = h.closest('.p-row[data-id]'); if (!card || card.dataset.id === 'exit' || !state.plan) return;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id) || !state.plan.slots.some(s => s.id === id)) return;                 // 이미 사라진 칸의 핸들
    const scroller = scrollerOf(card);
    drag = { id, card, handle: h, pid: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, sc0: scroller.scrollTop, scroller, timer: null, raf: 0, hist: [], rows: [], target: null };
    dragPhase = 'pressing';
    try { h.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 못 해도 window 추적으로 이어진다 */ }
    bindDragGuards();
    drag.timer = setTimeout(dragStart, LONG_MS);
  }
  // pressing → dragging
  function dragStart() {
    const d = drag; if (!d || dragPhase !== 'pressing') return;
    d.timer = null; dragPhase = 'dragging';
    d.card.classList.add('dragging'); d.card.style.willChange = 'transform';
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (err) { /* 무시 */ } }
    d.rows = [...$('planList').querySelectorAll('.p-row[data-id]')].filter(r => r !== d.card && r.dataset.id !== 'exit');
    hideSnack(false);
    d.raf = requestAnimationFrame(autoScroll);
    trackDrag();
  }
  function dragMove(e) {
    const d = drag; if (!d || e.pointerId !== d.pid) return;
    if (dragPhase === 'pressing') { if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > SLOP) dragCancel('scroll'); return; }   // 롱프레스 전 움직임 = 스크롤 의도
    if (dragPhase !== 'dragging') return;
    if (e.cancelable) e.preventDefault();
    d.y = e.clientY;
    d.hist.push({ y: e.clientY, t: isN(e.timeStamp) ? e.timeStamp : Date.now() }); if (d.hist.length > HIST_MAX) d.hist.shift();
    trackDrag();
  }
  /* 포인터 1:1 추적(누른 자리 유지) + 스크롤 보정 + 놓을 자리 표시. 자동 스크롤도 이 함수를 다시 부른다 */
  function trackDrag() {
    const d = drag; if (!d || dragPhase !== 'dragging') return;
    d.card.style.transform = `translateY(${(d.y - d.y0) + (d.scroller.scrollTop - d.sc0)}px)`;
    let tgt = null;
    for (const r of d.rows) { const b = r.getBoundingClientRect(); if (d.y < b.top + b.height / 2) { tgt = { row: r, before: true }; break; } }   // 포인터가 그 칸 중심선 위면 그 앞에
    if (!tgt && d.rows.length) tgt = { row: d.rows[d.rows.length - 1], before: false };
    markDrop(tgt);
  }
  /* 가장자리 자동 스크롤: rAF 한 줄만 돌고, dragging이 아니게 되는 순간 스스로 멈춘다(teardown에서도 cancel — 이중 안전망) */
  function autoScroll() {
    const d = drag;
    if (!d || dragPhase !== 'dragging') { if (d) d.raf = 0; return; }
    d.raf = requestAnimationFrame(autoScroll);
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vh < VH_MIN) return;                                                   // 뷰포트 높이를 모르면 자동 스크롤 안 함
    let v = 0;
    if (d.y < EDGE) v = -Math.min(EDGE_MAX, Math.ceil((EDGE - d.y) / EDGE_DIV));
    else if (d.y > vh - EDGE) v = Math.min(EDGE_MAX, Math.ceil((d.y - (vh - EDGE)) / EDGE_DIV));
    if (!v) return;
    const el = d.scroller, before = el.scrollTop;
    el.scrollTop = before + v;
    if (el.scrollTop !== before) trackDrag();                               // 실제로 스크롤됐을 때만 다시 그린다
  }
  function markDrop(tgt) {
    const d = drag; if (!d) return;
    if (d.target && d.target.row === (tgt && tgt.row) && d.target.before === (tgt && tgt.before)) return;
    for (const r of d.rows) r.classList.remove('drop-before', 'drop-after');
    if (tgt) tgt.row.classList.add(tgt.before ? 'drop-before' : 'drop-after');
    d.target = tgt;
  }
  function dropIndex(d) {                                      // 자기 칸을 뺀 배열에서의 목표 index. 제자리면 null
    if (!state.plan || !d.target) return null;
    const ids = state.plan.slots.map(s => s.id), i = ids.indexOf(d.id), rest = ids.filter(x => x !== d.id);
    const to = d.target.before ? rest.indexOf(Number(d.target.row.dataset.id)) : rest.length;
    return to < 0 || to === i ? null : to;
  }
  // dragging → dropping → idle
  function dragUp(e) {
    const d = drag; if (!d || e.pointerId !== d.pid) return;
    if (dragPhase !== 'dragging') { dragCancel('tap'); return; }             // 롱프레스 전에 떼면 그냥 탭
    const to = dropIndex(d), id = d.id, order = state.plan ? state.plan.slots.map(s => s.id) : null;
    if (to === null || !order) { dragCancel('same'); return; }               // 제자리
    dragPhase = 'dropping';
    dragTeardown(false);                                                     // 놓았으니 원복 스프링 없이 정리 — renderPlan이 새 순서로 다시 그린다
    dragPhase = 'idle';
    const sl = state.plan.slots.find(s => s.id === id), nm = sl ? (sl.name || KO(sl.cat)) : '이 칸';
    op({ t: 'move', id, to, order }, '순서 바꾸기', `${josa(nm, '을', '를')} 옮겼어요`);
  }
  // 어떤 상태에서든 → cancelling → idle
  function dragCancel(reason) {
    if (!drag) { dragPhase = 'idle'; unbindDragGuards(); return; }
    const wasDragging = dragPhase === 'dragging';
    dragPhase = 'cancelling';
    dragTeardown(wasDragging);                                               // 끌던 중이었으면 스프링으로 원복
    dragPhase = 'idle';
  }
  /* 유일한 정리 지점: 타이머·rAF·포인터 캡처·전역 리스너·클래스·transform을 빠짐없이 되돌린다 */
  function dragTeardown(spring) {
    const d = drag;
    unbindDragGuards();
    if (!d) return;
    drag = null;
    if (d.timer) { clearTimeout(d.timer); d.timer = null; }
    if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
    try { d.handle.releasePointerCapture(d.pid); } catch (err) { /* 이미 풀림 */ }
    for (const r of d.rows) r.classList.remove('drop-before', 'drop-after');
    d.card.classList.remove('dragging'); d.card.style.willChange = '';
    const m = /translateY\((-?[\d.]+)px\)/.exec(d.card.style.transform), from = m ? parseFloat(m[1]) : 0;
    if (!spring || !from || REDUCED()) { d.card.style.transform = ''; return; }     // 놓았으면 renderPlan이 새로 그린다 · reduced-motion은 즉시
    const h = d.hist, v0 = h.length >= 2 ? (h[h.length - 1].y - h[0].y) / Math.max(1, h[h.length - 1].t - h[0].t) * 1000 : 0;
    springBack(d.card, from, v0);
  }
  function springBack(el, from, v0) {                          // 임계감쇠 스프링(response .35s): 현재 위치·속도에서 0으로. x(t) = (x0 + (v0 + ω·x0)·t)·e^(−ω·t)
    const w = 2 * Math.PI / SPRING_S; let t0 = null; const gen = (el._spring = (el._spring || 0) + 1);
    const step = (ts) => {
      if (el._spring !== gen) return;                          // 새 끌기가 시작되면 이 애니메이션은 손을 뗀다(중단 가능)
      if (t0 === null) t0 = ts; const t = (ts - t0) / 1000;
      const x = (from + (v0 + w * from) * t) * Math.exp(-w * t);
      if (t > 0.08 && Math.abs(x) < SPRING_EPS) { el.style.transform = ''; return; }
      el.style.transform = `translateY(${x}px)`; requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- 시트: 한 곳 더 넣기 / 고정 풀기 확인 / 이 가게 자세히 / 바꾸기 ----------
  const openSheet = (id) => { hideSnack(false); $(id).classList.add('on'); }, closeSheet = (id) => $(id).classList.remove('on');   // 시트가 열리면 스낵바는 숨긴다(되돌리기 기록은 유지)
  function resetAddSheet() { addCat = null; swapId = null; $('planSheetQ').textContent = '뭘 더 넣을까요?'; $('planSheetCats').hidden = false; $('planSheetCands').hidden = true; $('planSheetCands').innerHTML = ''; $('planSheetBack').hidden = true; }
  function openAddSheet() { if (!state.plan) return; resetAddSheet(); openSheet('planSheet'); }
  function lastPos(pl) { const last = [...pl.slots].reverse().find(s => s.place && !s.skipped); return last ? last.place : (pl.lastPos || pl.startPos); }
  function usedIds(pl, exceptId) {                              // 다른 칸이 쓴 곳 + 고정 예약분
    const used = new Set(pl.slots.filter(s => s.place && s.id !== exceptId).map(s => s.place.id));
    Object.entries(state.planEdits.fixed || {}).forEach(([k, v]) => { if (+k !== exceptId) used.add(v); }); return used;
  }
  const candOpts = () => ({ places: placesList(), walkMin: ItdaMap.walkMin, companion: companionOf(), maxWalk: walkMaxOf(), prefs: prefsForPlan(), tasteMap: state.tasteMap || null });   // ItdaPlan.candidates·candidatesNear 공용 입력
  function showCands(cat) {                                    // 마지막 칸 자리에서 거리순 5곳 (다른 칸이 쓴 곳·고정 예약분 제외)
    addCat = cat; const pl = state.plan, pos = lastPos(pl);
    const cands = ItdaPlan.candidates(cat, pos, candOpts(), usedIds(pl, null)).slice(0, ADD_MAX);
    $('planSheetQ').textContent = cands.length ? `${KO(cat)} — 어디로 할까요?` : `걸어서 ${walkMaxOf()}분 안에 ${josa(PK(cat), '이', '가')} 없어요`;
    $('planSheetCands').innerHTML = cands.map(x => `<button type="button" class="choice" data-pick="${esc(x.p.id)}"><span>${esc(x.p.name)}</span><small class="num">${ic('footprints')}${x.walk}분 · ${ic('circle-help')}미확인</small></button>`).join('')
      + (cands.length ? '<button type="button" class="choice" data-pick=""><span>가까운 곳으로</span></button>' : '');
    $('planSheetCats').hidden = true; $('planSheetCands').hidden = false; $('planSheetBack').hidden = false;
  }
  function doAdd(cat, placeId) {
    const pl = state.plan; if (!pl) return;
    const after = pl.slots.length ? pl.slots[pl.slots.length - 1].id : null;   // 마지막 칸 뒤에
    closeSheet('planSheet');
    op({ t: 'add', cat, after, placeId: placeId || null }, '칸 추가', `${KO(cat)} 칸을 넣었어요`);
  }
  function openConfirm(sl, next) {                             // 앱의 유일한 확인창 — 가게 이름·시각을 문구에 넣는다. next='swap'이면 풀고 나서 바꾸기 시트, 'book'이면 예약 풀기
    if (!sl) return; confirmId = sl.id; confirmNext = next || null;
    const nm = sl.name || (sl.place && sl.place.name) || '고정한 곳', when = !sl.skipped && isN(sl.arrive) ? `(${kor(sl.arrive)})` : '';
    if (next === 'book') {                                     // v3 §7: 예약된 일정은 고정 조건 — 바꾸려면 사용자 승인부터
      $('planConfirmText').textContent = `${nm}${when} — 예약해 두신 곳이에요. 예약 표시를 풀고 다른 곳으로 바꿀까요?`;
      $('planConfirmSub').textContent = '예약처에는 저희가 알리지 못해요. 바꾸시려면 예약을 직접 취소해 주세요.';
      $('btnPlanUnfix').innerHTML = `${ic('pin-off')}예약 풀고 바꾸기`;
      openSheet('planConfirm'); return;
    }
    $('planConfirmText').textContent = next === 'swap' ? `${nm}${when} 고정을 풀고 다른 곳으로 바꿀까요?` : `${nm}${when} 고정을 풀까요?`;
    $('planConfirmSub').textContent = next === 'swap' ? '예약하신 곳이면 그대로 두세요. 풀면 이 자리 근처 다른 곳을 골라 드려요.' : `풀면 ‘다시 짜기’ 때 다른 ${josa(PK(sl.cat), '으로', '로')} 바뀔 수 있어요. 예약하신 곳이면 그대로 두세요.`;
    $('btnPlanUnfix').innerHTML = `${ic('pin-off')}${next === 'swap' ? '풀고 바꾸기' : '고정 해제'}`;
    openSheet('planConfirm');
  }
  /* 예약된 칸을 바꾸려 할 때. 앱에서 잡은 예약(edits.booking)만 풀 수 있고, 가게 자료에 붙어 온 예약은 예약처에서 취소해야 한다 */
  function askUnbook(sl) {
    if (!sl) return;
    const mine = ItdaPlan.isBooked && ItdaPlan.isBooked(state.planEdits, sl.id);
    if (mine) { openConfirm(sl, 'book'); return; }
    toast('예약처에서 취소하세요', undefined, 'triangle-alert');
  }
  const mineBooked = (id) => !!(ItdaPlan.isBooked && ItdaPlan.isBooked(state.planEdits, id));   // 앱이 잡은 예약만 풀 수 있다(가게 자료에 붙어 온 건 예약처에서)
  function askCancel(id) {                                     // 예약·결제 취소도 승인부터(제품 요구: 예약된 일정은 고정 조건)
    const bk = bookedOf(id); if (!bk) return;
    if (!mineBooked(id)) { toast('예약처에서 취소하세요', undefined, 'triangle-alert'); return; }
    confirmId = id; confirmNext = 'cancel';
    const nm = id === EXIT_ID ? destName() : ((slotOf(id) || {}).name || '이 칸');
    $('planConfirmText').textContent = `${nm} — ${bk === 'paid' ? '결제한' : '예약한'} 자리예요. 취소할까요?`;
    $('planConfirmSub').textContent = bk === 'paid' ? '테스트 결제라 실제 돈은 안 움직였어요.' : '예약처에는 저희가 알리지 못해요.';
    $('btnPlanUnfix').innerHTML = `${ic('circle-minus')}${bk === 'paid' ? '결제 취소' : '예약 취소'}`;
    openSheet('planConfirm');
  }
  function openDetail(sl) {
    if (!sl || !sl.place) return; detailId = sl.id; const p = sl.place;
    $('planDetailName').textContent = p.name; $('planDetailSub').textContent = `${PK(p.category)}${p.sub ? ' · ' + p.sub : ''}`;
    $('planDetailTime').textContent = `${kor(sl.arrive)} ~ ${kor(sl.end)}`;
    $('planDetailWalk').textContent = sl.walk ? `앞 자리에서 ${sl.walk}분` : '바로 이어서';
    $('planDetailStay').textContent = `${KO(sl.cat)} ${sl.stay}분${booked(sl) ? ` · ${booked(sl) === 'paid' ? '결제됨' : '예약됨'}` : ''}`;
    $('planDetailRemove').hidden = !!sl.fixed || !!booked(sl);   // 고정 칸은 '고정 풀기'부터 · 예약 칸은 예약부터 풀어야 한다
    openSheet('planDetail');
  }
  const detailPlace = () => { const sl = state.plan && state.plan.slots.find(s => s.id === detailId); return sl && sl.place; };

  /* 바꾸기 시트(#swapSheet, H1). 마크업이 아직 없으면 #planSheet의 후보 영역을 빌려 쓴다(검증용 폴백) */
  const swapEls = () => $('swapSheet')
    ? { sheet: 'swapSheet', title: $('swapSheetTitle'), sub: $('swapSheetSub'), cands: $('swapCands'), fallback: false }
    : { sheet: 'planSheet', title: $('planSheetQ'), sub: null, cands: $('planSheetCands'), fallback: true };
  function distM(a, b) { const R = EARTH_R_M, r = Math.PI / 180, dp = (b.lat - a.lat) * r, dl = (b.lon - a.lon) * r, h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  function nearCands(cat, pos, used, radius) {                 // ItdaPlan.candidatesNear(E) — 아직 없으면 candidates + 직선거리로 같은 모양을 만든다
    const o = candOpts();
    if (typeof ItdaPlan.candidatesNear === 'function') return ItdaPlan.candidatesNear(cat, pos, o, used, radius).slice(0, SWAP_MAX);
    return ItdaPlan.candidates(cat, pos, o, used).map(x => Object.assign({}, x, { dist: distM(pos, x.p) })).filter(x => x.dist <= radius).sort((a, b) => a.dist - b.dist).slice(0, SWAP_MAX);
  }
  const radiusWalk = (pos, m) => Math.max(1, Math.round(ItdaMap.walkMin(pos, { lat: pos.lat + m / M_PER_DEG_LAT, lon: pos.lon }, 'senior')));   // 반경 m를 걸어서 몇 분(어르신 걸음)
  /* 바꾸기 후보 목록. 없으면 '더 멀리 보기'(반경을 넓혀 다시 연다) */
  function swapCandsHtml(cands, pos, radius) {
    if (cands.length) {
      const lim = planWalkMax();
      return cands.map(x => { const far = isN(x.walk) && x.walk > lim;   // 취향에서 정한 걷기 상한을 넘는 후보는 배지로 표시(계약 §4)
        return `<button type="button" class="choice${far ? ' far' : ''}" data-pick="${esc(x.p.id)}"><span>${esc(x.p.name)}</span><small class="num">${ic('footprints')}${isN(x.walk) ? x.walk : '?'}분${far ? ` <span class="bd warn num">${ic('triangle-alert', 'bd-ic')}멀어요</span>` : ''}</small></button>`; }).join('');
    }
    const empty = `<div class="swap-empty">${ic('circle-help')}다른 곳 없어요</div>`;
    return radius < SWAP_R_WIDE
      ? `${empty}<button type="button" class="choice" data-widen="${SWAP_R_WIDE}"><span>더 멀리 보기</span><small class="num">${ic('footprints')}${radiusWalk(pos, SWAP_R_WIDE)}분</small></button>`
      : empty;
  }
  function openSwap(sl, radius) {
    if (!sl || !state.plan) return;
    if (!sl.place || !isN(sl.place.lat) || !isN(sl.place.lon)) { toast('자리 정보 없음', undefined, 'triangle-alert'); return; }   // 좌표 없는 칸: 무해하게 무시
    if (booked(sl)) { askUnbook(sl); return; }                // 예약된 칸은 확인부터(제품 요구)
    swapId = sl.id; swapRadius = radius || SWAP_R; const pl = state.plan, pos = sl.place, cat = sl.cat, E = swapEls();
    const used = usedIds(pl, sl.id); used.add(sl.place.id);   // 다른 칸이 쓴 곳·고정 예약분 + 지금 이 칸의 가게(자기 자신은 후보가 아니다)
    for (const rid of ((state.planEdits.rejected || {})[String(sl.id)] || [])) used.add(rid);   // 이 칸에서 '여긴 말고' 한 곳도 뺀다(계약 §4b)
    const cands = nearCands(cat, pos, used, swapRadius).slice()
      .sort((a, b) => (isN(a.walk) ? a.walk : WALK_FAR) - (isN(b.walk) ? b.walk : WALK_FAR) || a.dist - b.dist);   // 걷기 시간 오름차순(계약 §4a), 같으면 가까운 순
    E.title.textContent = '대신 갈 곳';
    if (E.sub) E.sub.innerHTML = `<span class="p-meta num">${ic('footprints')}${radiusWalk(pos, swapRadius)}분</span>`;   // 부제 문장 → footprints 배지(기준 §4)
    E.cands.innerHTML = swapCandsHtml(cands, pos, swapRadius);
    if (E.fallback) { $('planSheetQ').textContent = '대신 갈 곳'; $('planSheetCats').hidden = true; $('planSheetCands').hidden = false; $('planSheetBack').hidden = true; addCat = null; }
    openSheet(E.sheet);
  }
  /* 스왑 실행. 모든 이상 입력(사라진 칸·같은 곳·모르는 id·좌표 없음·다른 칸이 쓰는 곳)은 무해하게 무시 + 토스트 — 계약 §4c */
  function doSwap(placeId) {
    const id = swapId, sl = state.plan && state.plan.slots.find(s => s.id === id); const E = swapEls();
    closeSheet(E.sheet); if (E.fallback) resetAddSheet();
    swapId = null;
    if (!placeId) return;                                                     // 닫기·빈 선택
    if (id === null || !sl) { toast('그 칸이 없어졌어요', undefined, 'triangle-alert'); return; }             // 이미 빠진 칸(remove·undo 뒤 시트가 열려 있던 경우)
    if (booked(sl)) { askUnbook(sl); return; }                                 // 예약된 칸은 승인 후에만
    if (sl.place && sl.place.id === placeId) { toast('지금 그 곳이에요', undefined, 'triangle-alert'); return; }   // 같은 placeId
    const p = placesList().find(q => q.id === placeId);
    if (!p) { toast('그 곳을 못 찾았어요', undefined, 'triangle-alert'); return; }                             // 알 수 없는 placeId
    if (!isN(p.lat) || !isN(p.lon)) { toast('자리 정보 없음', undefined, 'triangle-alert'); return; }   // 좌표 없는 장소
    if (usedIds(state.plan, id).has(placeId)) { toast('이미 들어 있어요', undefined, 'triangle-alert'); return; }
    op({ t: 'swap', id, placeId, prevPlaceId: sl.place ? sl.place.id : null }, '바꾸기', `${josa(p.name, '으로', '로')} 바꿨어요`);   // prevPlaceId → rejected[id](E) · 되돌리기 1회로 원상 복귀
  }
  /* ---------- 이동수단 시트(#moveSheet) ----------
   * 열 때 서버 /move 를 한 번만 부르고(같은 구간은 세션 캐시), 답이 오면 일정을 다시 계산해 화면과 시트를 갱신한다. */
  const MOVE_SENT = { walk: '걸어서 가는 걸로 바꿨어요', taxi: '택시로 가는 걸로 바꿨어요', transit: '버스·지하철로 가는 걸로 바꿨어요' };
  const chosenMove = (id) => ((state.planEdits && state.planEdits.mode) || {})[String(id)] || null;
  function renderMoveOpts(sl) {
    const box = $('moveOpts'); if (!box || !sl) return;
    const k = mkey(sl.from, sl.place) || '', modes = moveCache[k] || null, chosen = chosenMove(sl.id);
    const sub = $('moveSheetSub');
    if (sub) sub.innerHTML = `<span class="p-meta num">${moveFull[k] ? ic('check') + '실제 경로로 잰 시간이에요' : moveBusy ? ic('clock') + '알아보는 중…' : ic('circle-help') + '직선 거리 기준'}</span>`;
    box.innerHTML = ItdaPlan.MOVE_MODES.map(m => {
      const d = modes ? modes[m] : null, ok = !!(d && d.ok && isN(d.min));
      const est = m === 'walk' && !ok && isN(sl.walk) ? sl.walk : null;      // 도보는 값이 없어도 직선 추정이 있다
      const min = ok ? d.min : est;
      const why = ok ? (MOVE_WHY[d.source] || '') : est !== null ? MOVE_WHY.straight
        : moveBusy ? '알아보는 중…' : (MOVE_FAIL[(d && d.reason) || ''] || '미확인');
      const fare = ok && isN(d.fare) ? ` · ${d.fare.toLocaleString()}원` : '';
      const on = chosen === m || (!chosen && m === 'walk');
      const label = min === null ? '미확인' : `${min}분${fare}`;
      return `<button type="button" class="choice move-opt${on ? ' on' : ''}" data-move="${m}"${min === null ? ' disabled' : ''} aria-pressed="${on ? 'true' : 'false'}">`
        + `<span>${ic(MOVE_IC[m])}${ItdaPlan.MOVE_KO[m]}</span><small class="num">${label}${why ? ' · ' + why : ''}</small></button>`;
    }).join('');
  }
  function openMoveSheet(sl) {
    if (!sl || !sl.place || !sl.from) { toast('자리 정보 없음', undefined, 'triangle-alert'); return; }   // 첫 칸 앞·좌표 없는 칸: 무해하게 무시
    moveId = sl.id;
    $('moveSheetTitle').textContent = `${sl.name}까지 어떻게 갈까요?`;
    renderMoveOpts(sl);
    openSheet('moveSheet');
    askMove(sl);
  }
  async function askMove(sl) {                                 // 서버에 세 수단을 한 번 물어본다(이미 받은 구간이면 아무 일도 안 한다)
    const k = mkey(sl.from, sl.place);
    if (!k || moveFull[k] || moveBusy) return;
    moveBusy = true; renderMoveOpts(sl);
    try { await loadMove(sl.from, sl.place); } catch (e) { console.warn('move fail', e && e.message); }
    moveBusy = false;
    rebuild(); renderPlan();                                   // 실제 값이 들어왔으니 일정 시각을 다시 잰다
    const cur = state.plan && state.plan.slots.find(s => s.id === moveId);
    if (cur && $('moveSheet').classList.contains('on')) renderMoveOpts(cur);
  }
  function pickMove(mode) {
    const id = moveId; closeSheet('moveSheet'); moveId = null;
    if (id === null || ItdaPlan.MOVE_MODES.indexOf(mode) < 0) return;
    const sl = state.plan && state.plan.slots.find(s => s.id === id);
    if (!sl) { toast('그 칸이 없어졌어요', undefined, 'triangle-alert'); return; }
    if ((chosenMove(id) || 'walk') === mode) return;            // 지금 그 수단 — 되돌리기 기록을 남기지 않는다
    op({ t: 'mode', id, mode }, '가는 방법', MOVE_SENT[mode]);
  }
  function onCandsClick(e) {                                   // 바꾸기 후보(둘 다: #swapCands · 폴백 #planSheetCands)
    const w = e.target.closest('[data-widen]'); if (w) { const sl = state.plan && state.plan.slots.find(s => s.id === swapId); if (sl) openSwap(sl, +w.dataset.widen); return true; }
    const b = e.target.closest('[data-pick]'); if (!b) return false;
    if (swapId !== null) { doSwap(b.dataset.pick || null); return true; }
    return false;
  }

  // ---------- 예약·결제 (docs/예약결제_구현설계_2026-09-04 §1·§2·§4) ----------
  /* 1단계: 공식 창구(네이버·코레일톡·고속버스 앱)로 넘어가 예약하고 돌아오면 상태를 기록.
   * 2단계: 우리가 파는 '예약금'을 토스페이먼츠 테스트 모드로 결제(실제 돈은 움직이지 않는다 — 화면에 항상 '테스트').
   * 서버 계약은 §3. A가 아직이면 GET /payments/config가 404 → 결제 행은 '준비 중'으로 비활성. */
  const BOOK_PENDING = 'itda.book.pending';       // 창구를 열고 앱을 떠난 기록 {id, provider, at}
  const PAY_PENDING = 'itda.pay.pending';         // 결제창을 열고 앱을 떠난 기록 {orderId, id, reservationId, amount, at}
  const CK_KEY = 'itda.pay.ck';                   // 토스 customerKey(단말 고정, 개인정보 아님)
  const BOOK_BACK_MS = 10 * 60 * 1000;            // 복귀 확인은 10분 안에만 묻는다(설계 §1)
  const DEPOSIT_KRW = 10000;                      // 예약금(데모). 서버가 depositKrw를 주면 그 값
  const TOSS_SDK = 'https://js.tosspayments.com/v2/standard';
  const NET_BOOK_MS = 6000;                       // 예약·결제 서버 호출 제한 시간
  const PARTY = 2;                                // 기준 사용자(60대 부부) — 인원 고정
  const RETURN_DELAY = 300;                       // 복귀 직후엔 화면이 아직 정리 중 — 조금 뒤에 묻는다
  /* 앱 패키지명은 Play 스토어 URL로 실제 확인한 것만 쓴다(2026-09-04 확인, HTTP 200):
   *   코레일톡  https://play.google.com/store/apps/details?id=com.korail.talk    ('Korail+')
   *   고속버스  https://play.google.com/store/apps/details?id=com.kscc.scxb.mbl  ('고속버스 티머니')
   * 설계 초안의 com.tmoney.tmoneygo는 404(없는 패키지)라 쓰지 않는다. 예매 화면으로 바로 가는 딥링크는 공개 규격이 없어
   * market:// 로 그 앱 화면을 띄우고(설치돼 있으면 '열기'), 그마저 못 열면 공식 웹으로 떨어진다. */
  const APPS = {
    korail: { pkg: 'com.korail.talk', web: 'https://www.letskorail.com', label: '코레일톡 열기', icon: 'train-front' },
    kobus: { pkg: 'com.kscc.scxb.mbl', web: 'https://www.kobus.co.kr', label: '고속버스 앱 열기', icon: 'bus-front' },
  };
  const WIDGET_KEY = /^(test|live)_gck_/;                       // 이 접두사는 결제위젯용 키 — payment() 대신 widgets()를 써야 한다(A 서버 공지 2026-09-04)
  const CANCEL_CODES = ['USER_CANCEL', 'PAY_PROCESS_CANCELED'];  // 그만둔 건 실패가 아니다
  const EXIT_ID = 'exit';
  let bookId = null;              // 지금 시트가 다루는 칸 id(숫자) 또는 'exit'
  let payCfg = null;              // GET /payments/config: null=아직 안 봄, false=없음, 객체=쓸 수 있음
  let askPend = null;             // 복귀 확인 시트가 다루는 pending

  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  const hm24 = (m) => isN(m) ? `${String(Math.floor((((m % DAY_MIN) + DAY_MIN) % DAY_MIN) / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}` : '00:00';
  const ymd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function customerKey() {                                     // 토스 customerKey: 단말마다 하나(2~50자). 개인정보를 넣지 않는다
    let k = null; try { k = localStorage.getItem(CK_KEY); } catch (e) {}
    if (!k) { k = 'itda-' + Math.random().toString(36).slice(2, 12); try { localStorage.setItem(CK_KEY, k); } catch (e) {} }
    return k;
  }
  async function netJson(url, opt, ms) {                       // 정해진 시간 안에 답이 없으면 스스로 끊는다(flow.js getJson과 같은 규칙)
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms || NET_BOOK_MS);
    try { const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opt || {})); return r.ok ? await r.json() : null; }
    finally { clearTimeout(t); }
  }
  const postJson = (url, body) => netJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function payConfig(force) {                            // A 서버가 없으면 false로 기억했다가 '준비 중'으로 보여 준다
    if (payCfg !== null && !force) return payCfg;
    try { const d = await netJson(`${SERVER}/payments/config`); payCfg = d && d.ok && d.clientKey ? d : false; }
    catch (e) { payCfg = false; }
    return payCfg;
  }
  function loadToss() {                                        // 토스 SDK는 결제를 누른 그 순간에만 받는다(평소 통신 0)
    if (window.TossPayments) return Promise.resolve(window.TossPayments);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = TOSS_SDK; s.async = true;
      s.onload = () => window.TossPayments ? res(window.TossPayments) : rej(new Error('sdk'));
      s.onerror = () => rej(new Error('sdk'));
      document.head.appendChild(s);
    });
  }
  /* 결제창은 index.html이 있는 폴더의 pay-return.html로 돌아온다(Capacitor: https://localhost/, 브라우저: 그 경로).
   * 앱을 어떻게 열었는지(?server=·?debug=)는 그대로 물려준다 — 돌아온 뒤에도 같은 서버를 본다. */
  const KEEP_PARAMS = ['server', 'at', 'now', 'debug'];
  function keepQuery() {
    const p = new URLSearchParams(location.search), out = new URLSearchParams();
    for (const k of KEEP_PARAMS) if (p.get(k)) out.set(k, p.get(k));
    const s = out.toString(); return s ? '?' + s : '';
  }
  const returnUrl = () => location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, 'pay-return.html') + keepQuery();

  const slotOf = (id) => (id === EXIT_ID || id === null || id === undefined) ? null : (state.plan && state.plan.slots.find(s => s.id === id)) || null;
  const exitBooking = () => (state.plan && state.plan.exit && state.plan.exit.booking) || null;
  const exitBooked = () => { const b = exitBooking(); return b && (b.status === 'reserved' || b.status === 'paid') ? b.status : null; };
  const bookedOf = (id) => id === EXIT_ID ? exitBooked() : booked(slotOf(id));
  const exitProvider = () => state.dest === 'terminal' ? 'kobus' : 'korail';   // 타는 곳이 유스퀘어면 고속버스, 그 밖(광주송정역·미정)은 기차
  /* 나가기 칸 복사용 문장: "광주송정역 오후 7:30 서울 KTX" — 창구 앱에 손으로 옮겨 적을 값만, 모르는 값은 넣지 않는다 */
  function exitCopyText() {
    const ex = state.plan && state.plan.exit, c = state.card, tr = state.train;
    const parts = [destName()];
    const dep = tr && tr.dep ? tr.dep : (c && isN(c.board) ? kor(c.board) : (ex && isN(ex.board) ? kor(ex.board) : null));
    if (dep) parts.push(dep);
    if (tr && tr.to) parts.push(tr.to);
    if (tr && tr.grade) parts.push(tr.grade);
    return parts.join(' ');
  }
  const bookRow = (act, icon, label, o) => `<button type="button" class="choice" data-bk="${act}"${o && o.disabled ? ' disabled' : ''}>${ic(icon, 'ic-l')}<span>${esc(label)}</span>${o && o.small ? `<small>${esc(o.small)}</small>` : ''}</button>`;
  async function openBookSheet(id) {
    if (!state.plan) return;
    const sl = slotOf(id);
    if (id !== EXIT_ID && (!sl || !sl.place)) { toast('자리 정보 없음', undefined, 'triangle-alert'); return; }
    bookId = id;
    const isExit = id === EXIT_ID;
    $('bookSheetTitle').textContent = isExit ? destName() : sl.name;
    $('bookSheetBadges').innerHTML = `<span class="bd un">${ic('circle-help', 'bd-ic')}테스트 결제 · 실제 결제 아님</span>`;
    const copy = $('bookCopy');
    if (isExit) { const t = exitCopyText(); $('bookCopyText').textContent = t; copy.hidden = !t; }
    else copy.hidden = true;
    const rows = $('bookRows');
    if (isExit) {
      const a = APPS[exitProvider()];
      rows.innerHTML = bookRow('app', a.icon, a.label) + bookRow('mark', 'check', '예매했어요');
      return;
    }
    rows.innerHTML = bookRow('naver', 'external-link', '네이버에서 예약')
      + bookRow('pay', 'credit-card', `예약금 결제 · 테스트 ${DEPOSIT_KRW.toLocaleString()}원`, { disabled: true, small: '준비 중' })
      + bookRow('mark', 'check', '예약했어요');
    openSheet('bookSheet');
    const cfg = await payConfig();                             // 서버가 살아 있으면 결제 행을 켠다(응답 전엔 '준비 중')
    if (bookId !== id || !$('bookSheet').classList.contains('on')) return;
    const btn = rows.querySelector('[data-bk="pay"]'); if (!btn || !cfg) return;
    btn.disabled = false;
    btn.innerHTML = `${ic('credit-card', 'ic-l')}<span>예약금 결제 · 테스트 ${(cfg.depositKrw || DEPOSIT_KRW).toLocaleString()}원</span>`;
  }
  function closeBookSheet() { closeSheet('bookSheet'); bookId = null; resetPayUi(); }
  function resetPayUi() {                                      // 위젯 자리를 비우고 행 목록을 되돌린다
    const p = $('bookPay'); if (!p || p.hidden) return;
    p.hidden = true; $('bookRows').hidden = false;
    $('payMethods').innerHTML = ''; $('payAgree').innerHTML = ''; $('btnPayGo').onclick = null; $('btnPayGo').disabled = false;
  }
  /* 창구를 열기 전에 '어디로 나갔는지'를 남긴다 — 돌아왔을 때(10분 안) 한 번만 묻기 위해. 지금 일정도 저장해 둔다(앱이 새로 뜰 수 있다) */
  function leaveFor(id, provider) { lsSet(BOOK_PENDING, { id, provider, at: Date.now() }); persist(); }
  function openApp(provider) {                                 // 설치돼 있으면 그 앱 화면, 못 열면 공식 웹(설계 §4)
    const a = APPS[provider]; if (!a) return;
    const CapA = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
    if (CapA && CapA.openUrl) CapA.openUrl({ url: `market://details?id=${a.pkg}` }).catch(() => window.open(a.web, '_blank'));
    else window.open(a.web, '_blank');
  }
  function selectCopyText() {                                  // 복사가 막힌 환경(권한·http): 글자를 선택 상태로 만들어 직접 복사하게
    try { const r = document.createRange(); r.selectNodeContents($('bookCopyText')); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
    toast('길게 눌러 복사', undefined, 'circle-help');
  }
  function copyExitText() {
    const t = $('bookCopyText').textContent || ''; if (!t) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('복사했어요', undefined, 'check'), selectCopyText);
    else selectCopyText();
  }
  function markBooked(id, provider) {                          // '예약했어요' — 앱이 잡은 예약 표시(예약처에는 우리가 못 알린다)
    return op({ t: 'book', id, status: 'reserved', provider }, '예약', id === EXIT_ID ? '예매 표시했어요' : '예약 표시했어요');
  }
  function onBookRow(e) {
    const b = e.target.closest('[data-bk]'); if (!b || b.disabled) return;
    const id = bookId, sl = slotOf(id), act = b.dataset.bk;
    if (act === 'naver') { if (!sl || !sl.place) return; leaveFor(id, 'naver'); closeBookSheet(); openNaverPlace(sl.name, sl.place.lat, sl.place.lon, sl.place.dong || sl.place.zone); return; }
    if (act === 'app') { const pv = exitProvider(); leaveFor(id, pv); closeBookSheet(); openApp(pv); return; }
    if (act === 'mark') { closeBookSheet(); lsDel(BOOK_PENDING); markBooked(id, 'manual'); return; }
    if (act === 'pay') startPay(id);
  }
  /* 2단계 결제: /reservations로 주문을 만들고 → 토스 결제창. 결제창은 앱을 떠나므로 그 전에 일정과 pending을 저장한다. */
  async function startPay(id) {
    const sl = slotOf(id); if (!sl || !sl.place) return;
    const cfg = await payConfig(true);
    if (!cfg) { toast('결제 준비 중', undefined, 'circle-help'); return; }
    const amount = cfg.depositKrw || DEPOSIT_KRW;
    let r = null;
    try { r = await postJson(`${SERVER}/reservations`, { placeId: sl.place.id, placeName: sl.name, slotId: String(sl.id), date: ymd(), time: hm24(sl.arrive), party: PARTY, amount, customerKey: customerKey() }); }
    catch (e) { r = null; }
    if (!r || !r.ok || !r.orderId) { toast('예약을 못 잡았어요', undefined, 'triangle-alert'); return; }
    persist();
    lsSet(PAY_PENDING, { orderId: r.orderId, id: sl.id, reservationId: r.id || null, amount: r.amount || amount, at: Date.now() });
    let T = null;
    try { T = await loadToss(); } catch (e) { lsDel(PAY_PENDING); toast('결제창을 못 열었어요', undefined, 'triangle-alert'); return; }
    const req = { orderId: r.orderId, orderName: r.orderName || `${sl.name} 예약금`, successUrl: returnUrl(), failUrl: returnUrl() };
    const value = r.amount || amount;
    if (WIDGET_KEY.test(String(cfg.clientKey))) { await openPayWidget(T, cfg, value, req); return; }   // 결제위젯용 키는 payment()가 INVALID_API_KEY로 막힐다
    closeBookSheet();
    try {
      const pay = T(cfg.clientKey).payment({ customerKey: customerKey() });
      await pay.requestPayment(Object.assign({ method: 'CARD', amount: { currency: 'KRW', value } }, req));
    } catch (e) { lsDel(PAY_PENDING); payErr(e); }
  }
  /* 결제위젯(test_gck_…): 시트 안에 결제수단·약관을 그리고 '결제하기'로 넘긴다(토스 v2 표준) */
  async function openPayWidget(T, cfg, value, req) {
    $('bookRows').hidden = true; $('bookCopy').hidden = true; $('bookPay').hidden = false;
    const go = $('btnPayGo'); go.disabled = true;
    try {
      const w = T(cfg.clientKey).widgets({ customerKey: customerKey() });
      await w.setAmount({ currency: 'KRW', value });
      await Promise.all([w.renderPaymentMethods({ selector: '#payMethods' }), w.renderAgreement({ selector: '#payAgree' })]);
      go.disabled = false;
      go.onclick = async () => { go.disabled = true; try { await w.requestPayment(req); } catch (e) { go.disabled = false; lsDel(PAY_PENDING); payErr(e); } };
    } catch (e) { lsDel(PAY_PENDING); payErr(e); closeBookSheet(); }
  }
  function payErr(e) {                                          // 오류 코드는 콘솔에 그대로, 화면엔 12자 안(기준 §4)
    const code = String((e && (e.code || e.name)) || '');
    console.warn('[pay]', code, e && e.message);
    toast(CANCEL_CODES.indexOf(code) >= 0 ? '결제를 그만떇어요' : '결제가 안 됐어요', undefined, 'triangle-alert');
  }
  /* 예약·결제 취소: 서버가 있으면 먼저 알리고, 어느 쪽이든 앱의 예약 표시는 푼다(못 알렸으면 정직하게 말한다) */
  async function cancelBooking(id) {
    const b = id === EXIT_ID ? exitBooking() : (slotOf(id) || {}).booking;
    const rid = b && b.reservationId;
    let told = !rid;
    if (rid) { try { const d = await postJson(`${SERVER}/reservations/${encodeURIComponent(rid)}/cancel`, { reason: 'user' }); told = !!(d && d.ok); } catch (e) { told = false; } }
    op({ t: 'unbook', id, force: true }, '예약 취소', told ? '예약을 취소했어요' : '예약 표시를 풀었어요');
    if (!told) toast('예약처에서 취소하세요', undefined, 'triangle-alert');
  }
  /* 창구에서 돌아왔을 때(10분 안) 한 번만 "예약하셨어요?" — 예면 예약 표시, 아니오면 그냥 지운다 */
  function checkBookReturn() {
    const p = lsGet(BOOK_PENDING); if (!p) return;
    lsDel(BOOK_PENDING);
    const dt = Date.now() - (+p.at || 0);
    if (!(dt >= 0 && dt <= BOOK_BACK_MS)) return;
    if (!state.plan) return;
    if (p.id !== EXIT_ID && !slotOf(p.id)) return;             // 그 사이 빠진 칸
    if (bookedOf(p.id)) return;                                // 이미 표시돼 있으면 묻지 않는다
    askPend = p;
    $('bookAskText').textContent = p.id === EXIT_ID ? '예매하셨어요?' : '예약하셨어요?';
    openSheet('bookAsk');
  }
  function answerBooked(yes) {
    closeSheet('bookAsk'); const p = askPend; askPend = null;
    if (yes && p) markBooked(p.id, p.provider || 'manual');
  }
  /* 결제 복귀(?paid): flow.js가 저장분을 되살리기 전에 부른다. edits에 직접 적는다(아직 plan이 없다) */
  function applyPaid(edits, pend, paymentKey) {
    return ItdaPlan.applyEdit(edits, { t: 'book', id: pend.id, status: 'paid', provider: 'toss', ref: paymentKey || null, reservationId: pend.reservationId || null, orderId: pend.orderId || null, amount: pend.amount || null });
  }
  function bindBook() {
    $('bookRows').addEventListener('click', onBookRow);
    $('bookSheetClose').addEventListener('click', closeBookSheet);
    $('btnBookCopy').addEventListener('click', copyExitText);
    $('btnBookYes').addEventListener('click', () => answerBooked(true));
    $('btnBookNo').addEventListener('click', () => answerBooked(false));
    ['bookSheet', 'bookAsk'].forEach(id => $(id).addEventListener('click', e => { if (e.target === $(id)) { closeSheet(id); if (id === 'bookSheet') bookId = null; else askPend = null; } }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(checkBookReturn, RETURN_DELAY); });
    const CapA = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
    if (CapA && CapA.addListener) CapA.addListener('resume', () => setTimeout(checkBookReturn, RETURN_DELAY));
  }

  function bind() {
    const list = $('planList');
    list.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (!b || b.disabled) return; const el = b.closest('[data-id]'); const id = el ? (el.dataset.id === 'exit' ? 'exit' : +el.dataset.id) : null; act(b.dataset.act, id); });
    list.addEventListener('pointerdown', dragDown);            // pointermove/up/cancel·Escape는 끌기가 시작될 때만 window에 건다(bindDragGuards) — 창 밖으로 나가도 안 놓친다
    list.addEventListener('contextmenu', e => { if (drag || e.target.closest('.p-handle')) e.preventDefault(); });   // 롱프레스에 컨텍스트 메뉴가 뜨면 끌기가 끊긴다
    $('btnPlanAdd').addEventListener('click', () => act('add', null));
    $('btnPlanRedo').addEventListener('click', guard(redoPlan));
    $('btnPlanGo').addEventListener('click', guard(confirmPlan));
    $('planMap').addEventListener('click', guard(() => go('scrMapFull')));
    { const bsp = $('btnPlanSpeak'), bmf = $('btnPlanMapFull');   // 요약 옆 듣기·지도(결과 화면 폐기로 여기로 옮김 — 설계 §1)
      if (bsp) bsp.addEventListener('click', speakPlan);
      if (bmf) bmf.addEventListener('click', guard(() => go('scrMapFull'))); }
    $('planSnackUndo').addEventListener('click', undo);
    $('planSheetCats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (!b) return; if (b.dataset.cat === 'sight') doAdd('sight', null); else showCands(b.dataset.cat); });
    $('planSheetCands').addEventListener('click', e => { if (onCandsClick(e)) return; const b = e.target.closest('[data-pick]'); if (!b || !addCat) return; doAdd(addCat, b.dataset.pick || null); });
    $('planSheetBack').addEventListener('click', resetAddSheet);
    $('planSheetClose').addEventListener('click', () => { closeSheet('planSheet'); swapId = null; });
    if ($('moveSheet')) {
      $('moveOpts').addEventListener('click', e => { const b = e.target.closest('[data-move]'); if (b && !b.disabled) pickMove(b.dataset.move); });
      $('moveSheetClose').addEventListener('click', () => { closeSheet('moveSheet'); moveId = null; });
      $('moveSheet').addEventListener('click', e => { if (e.target === $('moveSheet')) { closeSheet('moveSheet'); moveId = null; } });
    } else console.warn('[plan-ui] #moveSheet 없음 — 이동수단 고르기는 비활성');
    $('btnPlanUnfix').addEventListener('click', () => {
      closeSheet('planConfirm'); const id = confirmId, next = confirmNext; confirmId = null; confirmNext = null;
      if (id === null) return;
      if (next === 'cancel') { cancelBooking(id); return; }        // 예약·결제 취소(서버가 있으면 먼저 알린다)
      if (next === 'book') {                                 // 예약 풀기(사용자 승인 완료) → 바로 바꾸기 시트
        const done = op({ t: 'unbook', id, force: true }, '예약 풀기', '예약 표시를 풀었어요');
        if (done) { const s2 = state.plan && state.plan.slots.find(s => s.id === id); if (s2) openSwap(s2); }
        else toast('예약처에서 취소하세요', undefined, 'triangle-alert');
        return;
      }
      const ok = op({ t: 'unfix', id }, '고정 풀기', '고정을 풀었어요');
      if (ok && next === 'swap') { const sl = state.plan && state.plan.slots.find(s => s.id === id); if (sl) openSwap(sl); }
    });
    $('btnPlanKeep').addEventListener('click', () => { closeSheet('planConfirm'); confirmId = null; confirmNext = null; });
    $('planDetailNaver').addEventListener('click', () => { const p = detailPlace(); if (p) openNaverPlace(p.name, p.lat, p.lon, p.dong || p.zone); });
    $('planDetailRemove').addEventListener('click', () => { closeSheet('planDetail'); if (detailId !== null) op({ t: 'remove', id: detailId }, '이 칸 빼기', '이 칸을 뺐어요'); detailId = null; });
    $('planDetailClose').addEventListener('click', () => closeSheet('planDetail'));
    if ($('swapSheet')) {
      $('swapCands').addEventListener('click', onCandsClick);
      if ($('swapSheetClose')) $('swapSheetClose').addEventListener('click', () => { closeSheet('swapSheet'); swapId = null; });
    } else console.warn('[plan-ui] #swapSheet 없음(H1 미완) — 바꾸기 시트는 #planSheet로 대신 띄웁니다');
    ['planSheet', 'planConfirm', 'planDetail', 'swapSheet'].filter(id => $(id)).forEach(id => $(id).addEventListener('click', e => { if (e.target === $(id)) { closeSheet(id); if (id === 'swapSheet' || id === 'planSheet') swapId = null; if (id === 'planConfirm') { confirmId = null; confirmNext = null; } } }));   // 바깥(어두운 곳) 탭 = 닫기
    window.addEventListener('scroll', onPlanScroll, { passive: true });   // 손으로 스크롤하면 20초 동안 자동 스크롤을 멈춘다
    document.addEventListener('click', e => { if (e.target.closest('.nav-b,[data-back]')) hideSnack(true); });   // 화면을 떠나면 되돌리기 비움(flow.js 무접촉)
    window.addEventListener('popstate', () => setTimeout(() => { if (getCur() !== 'scrPlan') hideSnack(true); }, 0));
    bindBook();
  }

  window.ItdaPlanUI = { init, render: renderPlan, build: buildPlan, aiRequest, persist, summary, dragState, applyPaid, PAY_PENDING, applyProgress, enterPlan, stats: () => planStats(state.plan) };   // dragState·stats는 ?debug=1 콘솔 검증용
})();
