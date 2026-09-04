/* 광주잇다 — 일정 계산 엔진 (app/plan.js). 순수 함수만: 화면·window·네트워크 없음. node에서도 돈다(app/test_plan.js).
 * 계약: docs/일정_기술설계_2026-09-03.md §1(데이터 모델 Edits·Plan·Slot·Exit·Ret)·§2(API·생성 규칙 1~7). 필드·함수 이름은 그 문서가 기준.
 * 제품 규칙(재설계 4장·R3 원칙): 일정 하나 / 칸 단위 '여긴 말고'+분모 / 고정 칸은 절대 안 바꿈(시간이 안 맞아도 late로 표시만) /
 * 되돌리기 깊이 1 / 영업시간은 모른다(확인한 가게 0곳) — 판정에 안 쓰고 '영업 미확인'으로 표기 / 미확인 숫자는 지어내지 않는다.
 * 시각은 전부 '분'(0=자정) 정수. 1440을 넘어도 그대로 두고 표시(kor)에서만 정규화한다. */
(function () {
  'use strict';
  // ---------- 상수 ----------
  const STAY = { eat: 45, cafe: 30, play: 30, sight: 20 };                 // 기본 체류(분)
  const TEMPLATE = {                                                         // 첫 칸은 사용자가 고른 할 일, 뒤는 자연스러운 순서 [판단]
    eat: ['eat', 'cafe', 'sight'], cafe: ['cafe', 'eat', 'sight'], play: ['play', 'eat', 'cafe'], sight: ['sight', 'cafe', 'eat'], none: ['eat', 'cafe', 'sight'],
  };
  const KO = { eat: '식사', cafe: '카페', play: '플레이스', sight: '구경' };
  const PLACE_KO = { eat: '식당', cafe: '카페', play: '플레이스', sight: '관광지' };
  const MAX_WALK = 20;        // 한 칸 사이 걸어가는 상한(분) 기본값 [정책값] — 취향(prefs.walkMax)으로 5분 단위 조절, o.maxWalk로 들어온다
  const WALK_STEP = 5, WALK_LIMIT_MIN = 5, WALK_LIMIT_MAX = 60;   // 상한 조절 단위·허용 범위(분)
  const TIGHT_MIN = 10;       // 나갈 시각 10분 안이면 '빠듯해요'
  const BOARD_BUFFER = 3;     // 승차 전 여유(분)
  const UNDO_DEPTH = 1;       // 되돌리기 깊이(다음 조작 전까지 1개)
  const STAY_MIN = 10, STAY_MAX = 120;   // stay 편집 허용 범위(분)
  const AUX_MIN = 40;         // v3: intents 모드에서 남는 시간이 이만큼이면 보조 칸(sight 20분) 1개를 뒤에 붙인다 [정책값]
  const AUX_MAX_SLOTS = 2;    // free 모드(시각 안 정함)는 마무리 시각이 없으니 '남는 시간' 대신 칸 수로만 판정 — 채운 칸이 2개 이하면 보조 칸을 붙인다 [정책값]
  const NEAR_RADIUS_M = 600, NEAR_MAX = 10;   // v3: '바꾸기' 시트 후보 반경(m)·최대 수
  const PLACE_DEFAULT_BOOKING = Object.freeze({ status: 'none', paymentRequired: false, provider: null, ref: null, holdUntil: null });   // status: 'none'|'reserved'|'paid'
  const BOOK_STATUS = ['none', 'reserved', 'paid'];
  const BOOK_IDS = ['reservationId', 'orderId'];   // 예약금 결제 식별자 — 서버가 준 값을 그대로 들고 다닌다(docs/예약결제_구현설계 §4)
  const BOOK_ID_MAX = 64;                          // 낯선 값이 들어와도 저장분이 봇지 않게 자른다
  const LAST_MIN = 1439;        // 그날 마지막 분(23:59) — 자정 넘김은 계산하지 않는다
  const LAST_HOUR = 23;
  const FIRST_ADDED_ID = 100;   // 사용자가 넣은 칸의 id 시작값(템플릿 칸 0..과 안 겹치게)
  const RESHUFFLE_MAX = 10;     // '다시 짜기' 재시도 상한(앞 칸이 바뀌면 뒤 칸 후보도 바뀐다)
  const EARTH_R_M = 6371000;    // 하버사인 지구 반지름(m)

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const clampInt = (x, lo, hi, dflt) => (isNum(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt);
  const mergeBooking = (a, b) => Object.assign({}, a, b && typeof b === 'object' ? b : {});
  /* 걷기 상한(분) — o.maxWalk(취향 설정)가 있으면 5분 단위로 반올림해 쓰고, 없거나 이상하면 MAX_WALK(20). 범위 5~60 */
  const maxWalkOf = (o) => {
    const v = o && o.maxWalk;
    if (!isNum(v)) return MAX_WALK;
    return Math.max(WALK_LIMIT_MIN, Math.min(WALK_LIMIT_MAX, Math.round(v / WALK_STEP) * WALK_STEP));
  };
  const EXIT_KEY = 'exit';                         // edits.booking의 나가기 칸 키(generate가 exit.booking으로 읽는다)
  const MOVE_MODES = ['walk', 'taxi', 'transit'];  // 칸 사이 이동수단. edits.mode[칸id]로 사용자가 고른다(없으면 도보)
  const MOVE_KO = { walk: '걸어서', taxi: '택시', transit: '버스·지하철' };
  /* 자료 방어: 좌표·이름·종류 중 하나라도 비었으면 그 장소는 없는 셈 친다(서버 자료에 null/NaN이 섞여도 화면이 안 죽게) */
  function validPlace(p) {
    return !!p && typeof p === 'object' && p.id !== undefined && p.id !== null && p.id !== ''
      && typeof p.category === 'string' && p.category !== '' && p.name !== undefined && p.name !== null && String(p.name) !== ''
      && isNum(p.lat) && isNum(p.lon);
  }
  const validPlaces = (o) => (o && Array.isArray(o.places) ? o.places : []).filter(validPlace);
  /* 걷기 시간: 주입 함수가 없거나 던지거나 NaN을 주면 null(= 그 후보는 못 쓴다) */
  function walkOf(fn, a, b, companion) {
    if (typeof fn !== 'function') return null;
    let w; try { w = fn(a, b, companion); } catch (err) { return null; }
    return isNum(w) ? w : null;
  }
  /* 칸으로 오는 길의 이동 정보. o.moveInfo(from, to, mode, companion) → { min, mode?, fare?, source? } | null.
   * 주입 함수가 없거나 던지거나 min이 숫자가 아니면 null = '아직 못 구했다'(서버 /move 응답이 오기 전·실패). */
  function moveInfoOf(o, from, to, mode, companion) {
    const fn = o && o.moveInfo;
    if (typeof fn !== 'function' || !from || !to) return null;
    let r; try { r = fn(from, to, mode, companion); } catch (err) { return null; }
    if (!r || typeof r !== 'object' || !isNum(r.min) || r.min < 0) return null;
    return { mode: MOVE_MODES.indexOf(r.mode) >= 0 ? r.mode : mode,
      min: Math.round(r.min), fare: isNum(r.fare) ? Math.round(r.fare) : null,
      source: typeof r.source === 'string' ? r.source : null };
  }
  /* 그 칸으로 오는 길 한 줄. 사용자가 고른 수단(req)의 시간을 못 구하면 걷기 추정으로 계산하되 unknown 으로 밝힌다 —
   * 택시·버스 시간을 지어내지 않는다(제품 요구 ②). req 가 없으면 '자동' = 도보. */
  function moveFor(o, from, to, walkMin, req, companion) {
    const want = MOVE_MODES.indexOf(req) >= 0 ? req : 'walk';
    const got = moveInfoOf(o, from, to, want, companion);
    if (got) return Object.assign({ requested: req || null, unknown: false }, got);
    return { mode: 'walk', min: walkMin, fare: null, source: 'straight', requested: req || null, unknown: want !== 'walk' };
  }
  /* ?debug=1일 때만 불변식 검사(console.assert). node·배포 빌드에서는 꺼진다 — setDebug(true)로 강제 가능(테스트) */
  let DEBUG_ON = null;
  function isDebug() {
    if (DEBUG_ON !== null) return DEBUG_ON;
    try { DEBUG_ON = typeof location !== 'undefined' && !!location && /[?&]debug=1/.test(String(location.search || '')); }
    catch (e) { DEBUG_ON = false; }
    return DEBUG_ON;
  }
  function setDebug(v) { DEBUG_ON = v === null || v === undefined ? null : !!v; }
  /* 불변식(설계 §2 규칙 7): 채운 칸은 arrive ≤ end·정수·앞 칸보다 뒤, 칸 순서 = order 순서. 어기면 console.assert로만 알린다(화면은 안 죽인다) */
  function assertPlan(plan, order) {
    if (!isDebug() || typeof console === 'undefined' || !console.assert) return plan;
    const ids = plan.slots.map(s => s.id).join(), want = order.map(s => s.id).join();
    console.assert(ids === want, '[plan] 칸 순서 != order', ids, want);
    let prev = null;
    for (const s of plan.slots) {
      if (s.skipped) { console.assert(s.arrive === null && s.end === null, '[plan] 건너뛴 칸에 시각이 남음', s); continue; }
      console.assert(Number.isInteger(s.arrive) && Number.isInteger(s.end), '[plan] 시각이 정수가 아님', s);
      console.assert(s.arrive <= s.end, '[plan] arrive > end', s);
      console.assert(prev === null || s.arrive >= prev, '[plan] 앞 칸보다 이른 도착', s);
      prev = s.end;
    }
    return plan;
  }

  // ---------- 편집 상태(Edits) — 불변: 항상 새 객체를 돌려주고 입력은 손대지 않는다. JSON만(Set 금지: 되돌리기·localStorage) ----------
  function emptyEdits(intent) {
    return { v: 1, intent: intent || 'none', rejected: {}, fixed: {}, pick: {}, added: [], removed: [], stay: {}, booking: {}, swapFrom: {}, mode: {}, nextId: FIRST_ADDED_ID, order: null };
  }
  function snapshot(edits) {                        // 깊은 복사 + 빠진 필드 보정(예전 저장분·망가진 저장분 복원 대비)
    if (!edits || typeof edits !== 'object') return emptyEdits('none');
    let copy; try { copy = clone(edits); } catch (err) { copy = {}; }       // 순환 참조·함수가 섞여도 죽지 않는다
    const e = Object.assign(emptyEdits(edits.intent), copy);
    for (const k of ['rejected', 'fixed', 'pick', 'stay', 'booking', 'swapFrom', 'mode']) if (!e[k] || typeof e[k] !== 'object' || Array.isArray(e[k])) e[k] = {};
    for (const k of Object.keys(e.mode)) if (MOVE_MODES.indexOf(e.mode[k]) < 0) delete e.mode[k];   // 모르는 이동수단은 버린다(저장분 방어)
    for (const k of Object.keys(e.swapFrom)) if (!e.swapFrom[k] || typeof e.swapFrom[k] !== 'string') delete e.swapFrom[k];
    for (const k of Object.keys(e.rejected)) { const l = Array.isArray(e.rejected[k]) ? e.rejected[k].filter(x => x !== null && x !== undefined && x !== '') : []; if (l.length) e.rejected[k] = l; else delete e.rejected[k]; }
    for (const k of Object.keys(e.fixed)) if (!e.fixed[k]) delete e.fixed[k];
    for (const k of Object.keys(e.pick)) if (!e.pick[k]) delete e.pick[k];
    for (const k of Object.keys(e.stay)) { const v = clampInt(e.stay[k], STAY_MIN, STAY_MAX, null); if (v === null) delete e.stay[k]; else e.stay[k] = v; }
    for (const k of Object.keys(e.booking)) { const b = normBooking(e.booking[k]); if (b.status === 'none') delete e.booking[k]; else e.booking[k] = b; }
    e.added = (Array.isArray(e.added) ? e.added : []).filter(a => a && typeof a === 'object' && STAY[a.cat] && isNum(a.id));
    const rm = (Array.isArray(e.removed) ? e.removed : []).filter(isNum).map(x => Math.round(x));
    e.removed = rm.filter((x, i) => rm.indexOf(x) === i);
    if (!isNum(e.nextId)) e.nextId = FIRST_ADDED_ID;
    e.nextId = Math.max(FIRST_ADDED_ID, Math.round(e.nextId), ...e.added.map(a => Math.round(a.id) + 1));
    e.order = normOrder(e.order);                                           // v3: 칸 id 표시 순서(null = 생성 순서) — 정수·중복 없음
    if (e.order) { const rmSet = new Set(e.removed); e.order = e.order.filter(x => !rmSet.has(x)); }   // 뺀 칸은 순서에도 남기지 않는다(저장분에 찌꺼기 금지)
    return e;
  }
  /* order 정규화: 배열이 아니면 null. 0 이상의 정수만 남기고(소수·숫자 문자열·음수·null은 버린다), 중복은 첫 번째만 */
  function normOrder(order) {
    if (!Array.isArray(order)) return null;
    const out = [];
    for (const x of order) if (Number.isInteger(x) && x >= 0 && out.indexOf(x) < 0) out.push(x);
    return out;
  }
  /* 지금 존재하는 칸 id 집합. op.order(화면이 보여 주는 현재 순서)가 오면 그걸 믿고, 없으면 템플릿+added−removed로 추정한다.
   * 모르는·뺀·정수 아닌 칸 id로 오는 편집은 전부 무시한다(저장분·되돌리기에 찌꺼기가 남지 않게 — 레드팀 RT-01) */
  function knownIds(e, order) {
    const given = normOrder(order), rm = new Set(e.removed);
    const base = given && given.length ? given : buildOrder(TEMPLATE[e.intent] || TEMPLATE.none, e).map(s => s.id);
    const set = new Set(base.filter(x => !rm.has(x)));
    for (const a of e.added) if (isNum(a.id) && !rm.has(a.id)) set.add(Math.round(a.id));
    return set;
  }
  /* 예약 메타 정규화: 모르는 status는 none, paymentRequired는 불리언, 빠진 필드는 기본값 */
  function normBooking(b) {
    const o = mergeBooking(PLACE_DEFAULT_BOOKING, b);
    if (BOOK_STATUS.indexOf(o.status) < 0) o.status = 'none';
    o.paymentRequired = !!o.paymentRequired;
    if (!isNum(o.holdUntil)) o.holdUntil = null;
    for (const k of BOOK_IDS) { if (o[k] == null || o[k] === '') delete o[k]; else o[k] = String(o[k]).slice(0, BOOK_ID_MAX); }   // 결제 식별자는 있을 때만(기본 booking은 5필드 그대로)
    if (!isNum(o.amount) || o.amount < 0) delete o.amount; else o.amount = Math.round(o.amount);
    return o;
  }
  /* 그 칸이 예약·결제된 칸인가(edits 기준). 장소 자료에 붙은 예약은 slot.booking이 들고 있다 */
  function isBooked(edits, id) {
    const m = edits && edits.booking && typeof edits.booking === 'object' ? edits.booking : null;
    const b = m ? m[String(id)] : null;
    return !!b && typeof b.status === 'string' && b.status !== 'none';
  }
  /* 칸 목록 = 템플릿 칸(id 0..) + added(after 뒤) − removed. generate 규칙 1과 applyEdit(move·up·down의 기본 순서)이 공용. */
  function buildOrder(tplCats, edits, extra) {
    let order = tplCats.map((cat, k) => ({ id: k, cat, added: false, aux: false }));
    if (extra) order.push(extra);
    for (const a of edits.added) {
      if (!a || !STAY[a.cat] || !isNum(a.id)) continue;
      const item = { id: a.id, cat: a.cat, added: true, aux: false };
      if (a.after === null) order.unshift(item);
      else { const at = isNum(a.after) ? order.findIndex(s => s.id === a.after) : -1; if (at < 0) order.push(item); else order.splice(at + 1, 0, item); }
    }
    const removed = new Set(edits.removed.map(Number));
    return order.filter(s => !removed.has(s.id));
  }
  /* edits.order를 칸 목록에 적용: order에 있는 id는 그 순서로, 없는 id는 뒤에(원래 순서), 사라진 id는 무시 */
  function applyOrder(list, order) {
    if (!Array.isArray(order) || !order.length) return list;
    const byId = new Map(list.map(s => [s.id, s])), seen = new Set(), out = [];
    for (const id of order) { const s = byId.get(id); if (s && !seen.has(id)) { seen.add(id); out.push(s); } }
    for (const s of list) if (!seen.has(s.id)) out.push(s);
    return out;
  }
  /* op: { t:'reject', id, placeId } | { t:'fix', id, placeId } | { t:'unfix', id } | { t:'add', cat, after, placeId }
   *   | { t:'remove', id } | { t:'stay', id, min } | { t:'clearRejected', id }(id 생략 = 전부)
   *   | v3: { t:'move', id, to, order? } | { t:'up', id, order? } | { t:'down', id, order? } — order = 현재 표시 순서(plan.slots.map(s=>s.id)).
   *     생략하면 edits.order, 그것도 없으면 템플릿 기본 순서(intents 모드·보조 칸은 모르므로 U는 order를 넘길 것). 끝에서 up/down은 무변화.
   *   | { t:'swap', id, placeId, prevPlaceId? } — 그 칸 장소를 즉시 placeId로(pick 맨 앞, fixed는 건드리지 않음), prevPlaceId는 rejected[id]에 추가.
   * 모르는 op는 그대로 복사본만 돌려준다. */
  function applyEdit(edits, op) {
    const e = snapshot(edits);
    if (!op || !op.t) return e;
    // 칸 id 검사: 정수가 아니거나 이미 뺐거나 지금 없는 칸이면 아무것도 하지 않는다(상태 오염 금지)
    const hasId = op.id !== undefined && op.id !== null;
    const nid = Number.isInteger(op.id) ? op.id : (typeof op.id === 'string' && /^\d+$/.test(op.id.trim()) ? Number(op.id.trim()) : null);
    const okId = nid !== null && nid >= 0 && !e.removed.includes(nid) && knownIds(e, op.order).has(nid);
    const exitId = op.id === EXIT_KEY && (op.t === 'book' || op.t === 'unbook');   // 나가기 칸(기차·버스 예매)은 칸 id가 아니라 'exit' — book/unbook에만 허용
    if (hasId && !okId && !exitId && op.t !== 'add') return e;
    const id = okId ? String(nid) : exitId ? EXIT_KEY : null;
    const curOrder = () => {
      const given = normOrder(op.order);
      return given && given.length ? given : (e.order && e.order.length ? e.order.slice() : buildOrder(TEMPLATE[e.intent] || TEMPLATE.none, e).map(s => s.id));
    };
    // 제품 요구(2026-09-01): 예약된 일정은 고정 조건 — 장소를 바꾸거나 빼는 op는 사용자 승인(op.force) 없이는 무시한다
    if (id !== null && isBooked(e, id) && !op.force && (op.t === 'reject' || op.t === 'swap' || op.t === 'remove')) return e;
    switch (op.t) {
      case 'move': case 'up': case 'down': {
        if (id === null) break;
        const arr = curOrder(), i = arr.indexOf(nid);
        if (i < 0) break;                                                           // 지금 순서에 없는 칸: 되살리지 않는다
        let to = op.t === 'up' ? i - 1 : op.t === 'down' ? i + 1 : (isNum(op.to) ? Math.round(op.to) : i);
        to = Math.max(0, Math.min(arr.length - 1, to));
        if (to === i) break;                                                        // 맨 위 up·맨 아래 down·제자리 move: 무변화
        arr.splice(i, 1); arr.splice(to, 0, nid);
        e.order = arr;
        break;
      }
      case 'swap': {
        if (id === null || !op.placeId || op.placeId === op.prevPlaceId) break;   // 같은 곳으로 바꾸기 = 아무 일도 안 일어난 것
        e.pick[id] = op.placeId;
        const l = e.rejected[id] || (e.rejected[id] = []);
        const k = l.indexOf(op.placeId); if (k >= 0) l.splice(k, 1);              // 새 장소가 거절 목록에 있으면 풀어준다(즉시 반영)
        if (op.prevPlaceId && !l.includes(op.prevPlaceId)) l.push(op.prevPlaceId);
        if (!l.length) delete e.rejected[id];
        if (op.prevPlaceId) e.swapFrom[id] = op.prevPlaceId; else delete e.swapFrom[id];   // 고른 곳을 못 찾을 때 되돌아갈 자리(안전 저하 — 레드팀 RT-02)
        break;
      }
      case 'reject': if (id !== null && op.placeId) { const l = e.rejected[id] || (e.rejected[id] = []); if (!l.includes(op.placeId)) l.push(op.placeId); } break;
      case 'fix': if (id !== null && op.placeId) { e.fixed[id] = op.placeId; delete e.pick[id]; } break;   // 고정이 pick보다 세다
      case 'unfix': if (id !== null) delete e.fixed[id]; break;
      case 'add': {
        if (!STAY[op.cat]) break;
        const nid = e.nextId; e.nextId = nid + 1;
        const item = { id: nid, cat: op.cat };
        if (op.after === null) item.after = null;                       // null = 맨 앞
        else if (isNum(op.after)) item.after = op.after;                // 그 칸 뒤 (없는 칸이면 generate가 맨 뒤에 붙인다)
        e.added.push(item);                                              // after 생략 = 맨 뒤
        if (op.placeId) e.pick[String(nid)] = op.placeId;                // 고른 곳은 후보 순서 맨 앞으로만(고정 아님)
        break;
      }
      case 'remove': {                                                          // 뺀 칸의 찌꺼기(order·pick·거절·고정·체류·예약)는 남기지 않는다
        if (id === null) break;
        if (!e.removed.includes(nid)) e.removed.push(nid);
        if (Array.isArray(e.order)) e.order = e.order.filter(x => x !== nid);
        for (const m of [e.pick, e.rejected, e.fixed, e.stay, e.booking, e.swapFrom, e.mode]) delete m[id];
        break;
      }
      case 'stay': if (id !== null && isNum(op.min)) e.stay[id] = clampInt(op.min, STAY_MIN, STAY_MAX, null); break;
      /* 이 칸으로 오는 길의 이동수단. mode 가 walk·taxi·transit 이 아니면(널 포함) '자동'으로 되돌린다 */
      case 'mode': if (id !== null) { if (MOVE_MODES.indexOf(op.mode) >= 0) e.mode[id] = op.mode; else delete e.mode[id]; } break;
      case 'clearRejected': if (id !== null) delete e.rejected[id]; else e.rejected = {}; break;
      case 'book': {                                                        // v3: 예약·결제 표시(장소 자료의 booking과 별개 — 사용자가 이 칸에 잡은 예약)
        if (id === null) break;
        const src = op.booking && typeof op.booking === 'object' ? op.booking
          : { status: op.status || 'reserved', provider: op.provider || null, ref: op.ref || null, holdUntil: isNum(op.holdUntil) ? op.holdUntil : null,
              reservationId: op.reservationId, orderId: op.orderId, amount: op.amount };   // 결제분(§4) — 값이 없으면 normBooking이 키째 지운다
        const b = normBooking(Object.assign({}, e.booking[id] || null, src));
        if (b.status === 'none') delete e.booking[id]; else e.booking[id] = b;
        break;
      }
      case 'unbook': if (id !== null) delete e.booking[id]; break;
      default: break;
    }
    return e;
  }
  function pushUndo(stack, edits, label) {
    const s = (Array.isArray(stack) ? stack : []).concat([{ edits: snapshot(edits), label: label || '' }]);
    return s.slice(Math.max(0, s.length - UNDO_DEPTH));
  }
  function popUndo(stack) {
    const s = Array.isArray(stack) ? stack : [];
    if (!s.length) return { stack: [], entry: null };
    return { stack: s.slice(0, -1), entry: s[s.length - 1] };
  }

  // ---------- 취향(prefs)·AI 제안 (설계 docs/AI일정_취향_설계_2026-09-04.md §5) ----------
  /* 매핑표는 o.tasteMap으로 주입받는다(엔진은 data/taste_map.json을 직접 읽지 않는다). 취향은 필터가 아니라 정렬 — spicy 회피만 제외한다 */
  const PREF_ANY = 'any';
  const strList = (x) => (Array.isArray(x) ? x.filter(v => typeof v === 'string' && v !== '') : []);
  /* 키워드·sub 비교용 정규화: 유니코드 조합형 차이(NFD)와 사이 공백('국 밥')이 취향을 갈라놓지 않게 한다(레드팀 2026-09-04 #11·#12) */
  const normText = (x) => (x === null || x === undefined ? '' : String(x)).normalize('NFC').replace(/\s+/g, '');
  /* 정규화는 비싸다 → 매핑표 객체·장소 객체 하나당 한 번만 하고 기억한다(WeakMap: 자료가 바뀌면 그 객체째 새로 온다) */
  const KEY_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  const SUB_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  function normKeys(group, k) {
    if (!group || typeof group !== 'object') return [];
    let m = KEY_CACHE ? KEY_CACHE.get(group) : null;
    if (!m) { m = Object.create(null); if (KEY_CACHE) KEY_CACHE.set(group, m); }
    let v = m[k];
    if (v === undefined) {
      v = [];
      for (const w of strList(group[k])) { const t = normText(w); if (t && v.indexOf(t) < 0) v.push(t); }
      m[k] = v;
    }
    return v;
  }
  function subText(p) {
    if (!p || typeof p !== 'object') return normText(p);
    if (!SUB_CACHE) return normText(p.sub);
    let t = SUB_CACHE.get(p);
    if (t === undefined) { t = normText(p.sub); SUB_CACHE.set(p, t); }
    return t;
  }
  /* 고른 취향 키들의 키워드를 합친다. 고른 게 없거나 'any'가 섞였으면 null(= 정렬하지 않는다) */
  function tasteWords(group, keys) {
    const sel = strList(keys);
    if (!sel.length || sel.indexOf(PREF_ANY) >= 0) return null;
    const g = group && typeof group === 'object' ? group : {};
    const out = [];
    for (const k of sel) for (const w of normKeys(g, k)) if (out.indexOf(w) < 0) out.push(w);
    return out.length ? out : null;
  }
  const subHas = (p, words) => { const s = subText(p); return words.some(w => s.indexOf(w) >= 0); };
  /* 그 종류에 쓸 취향 키워드. 지금은 eat(음식 종류)뿐 —
   * 카페 취향(조용한·빵·전망)은 2026-09-04 삭제했다: 카페 3,501곳의 sub가 98%가 '카페' 한 가지라 판별할 자료가 없다[실측]. */
  function prefWords(cat, o) {
    const prefs = o && o.prefs;
    if (!prefs || typeof prefs !== 'object') return null;
    const map = o.tasteMap && typeof o.tasteMap === 'object' ? o.tasteMap : {};
    if (cat === 'eat') return tasteWords(map.food, prefs.food);
    return null;
  }
  /* avoid에 spicy가 있으면 매운 키워드가 든 sub는 후보에서 뺀다 — 엔진이 거르는 건 이것 하나뿐(stairs·queue는 자료가 없어 추측 금지) */
  function spicyWords(o) {
    const prefs = o && o.prefs;
    if (!prefs || typeof prefs !== 'object' || strList(prefs.avoid).indexOf('spicy') < 0) return null;
    const w = o.tasteMap && typeof o.tasteMap === 'object' ? normKeys(o.tasteMap, 'spicy') : [];
    return w.length ? w : null;
  }
  /* 취향에 맞는 후보를 앞으로(안정 정렬: 그룹 안에서는 걷기 시간 순 그대로 — 취향 가게가 없으면 나머지가 뒤에 남는다) */
  function sortByTaste(list, cat, o) {
    if (!o || !o.prefs || !list.length) return list;                       // 취향이 없으면 정규화 경로를 아예 타지 않는다
    const words = prefWords(cat, o);
    if (!words) return list;
    const hit = [], miss = [];
    for (const x of list) (subHas(x.p, words) ? hit : miss).push(x);
    return hit.concat(miss);
  }
  /* o.ai = { picks:{칸id: placeId}, why:{칸id: 문장}, order:[칸id…] } — 널·모르는 값은 무해하게 무시한다 */
  function aiPickOf(ai, key) {
    const m = ai && typeof ai === 'object' && ai.picks && typeof ai.picks === 'object' && !Array.isArray(ai.picks) ? ai.picks : null;
    const v = m ? m[key] : null;
    return typeof v === 'string' && v !== '' ? v : null;
  }
  function aiWhyOf(ai, key) {
    const m = ai && typeof ai === 'object' && ai.why && typeof ai.why === 'object' && !Array.isArray(ai.why) ? ai.why : null;
    const v = m ? m[key] : null;
    return typeof v === 'string' && v !== '' ? v : null;
  }
  /* ai.order는 지금 칸 id의 순열일 때만 쓴다(길이가 다르거나 모르는 id가 섞이면 통째로 무시) */
  function aiOrderOf(ai, list) {
    const raw = ai && typeof ai === 'object' ? normOrder(ai.order) : null;
    if (!raw || raw.length !== list.length) return null;
    const ids = new Set(list.map(s => s.id));
    for (const id of raw) if (!ids.has(id)) return null;
    return raw;
  }

  // ---------- 후보 (분모·k번째·칸 추가 시트 공용) ----------
  /* exclude(Set|배열|객체|없음) → 'id를 빼야 하나' 판별기. candidates·candidatesNear 공용 */
  function excluder(exclude) {
    const ex = exclude || null;
    if (!ex) return () => false;
    if (ex instanceof Set) return (id) => ex.has(id);
    if (Array.isArray(ex)) return (id) => ex.includes(id);
    return (id) => !!ex[id];
  }
  /* o.places·o.walkMin·o.companion 사용. walk ≤ MAX_WALK, walk↑ 이름순. exclude: Set|배열|객체(다른 칸이 쓴 곳·고정 예약분)
   * o.prefs·o.tasteMap이 있으면: avoid spicy는 제외, 취향에 맞는 곳은 앞으로(§5). 없거나 'any'면 예전 순서 그대로 */
  function candidates(cat, fromPos, o, exclude) {
    const has = excluder(exclude);
    const companion = (o && o.companion) || 'senior', lim = maxWalkOf(o), out = [];
    if (!o || !fromPos || !isNum(fromPos.lat) || !isNum(fromPos.lon)) return out;
    const drop = o.prefs ? spicyWords(o) : null;                            // 취향 없음 = 예전 경로 그대로(정규화 0회)
    for (const p of validPlaces(o)) {
      if (p.category !== cat || has(p.id)) continue;
      if (drop && subHas(p, drop)) continue;
      const walk = walkOf(o.walkMin, fromPos, p, companion);
      if (walk !== null && walk <= lim) out.push({ p, walk });
    }
    out.sort((a, b) => a.walk - b.walk || String(a.p.name).localeCompare(String(b.p.name)));
    return sortByTaste(out, cat, o);
  }
  /* v3 '바꾸기' 시트용: 그 칸 장소 좌표(pos) 반경 radiusM 안의 같은 cat → [{ p, walk, dist }] 거리(m) 오름차순, 최대 NEAR_MAX(10).
   * candidates()와 별개(걷기 상한이 아니라 반경). walk = o.walkMin(pos, p, companion)(없으면 null). dist는 하버사인 정수 m. */
  function distM(a, b) {
    const R = EARTH_R_M, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function candidatesNear(cat, pos, o, exclude, radiusM) {
    const radius = isNum(radiusM) ? radiusM : NEAR_RADIUS_M;
    const has = excluder(exclude);
    const companion = (o && o.companion) || 'senior', out = [];
    if (!o || !pos || !isNum(pos.lat) || !isNum(pos.lon)) return out;
    for (const p of validPlaces(o)) {
      if (p.category !== cat || has(p.id)) continue;
      const dist = Math.round(distM(pos, p));
      if (!isNum(dist) || dist > radius) continue;
      out.push({ p, walk: walkOf(o.walkMin, pos, p, companion), dist });
    }
    return out.sort((a, b) => a.dist - b.dist || String(a.p.name).localeCompare(String(b.p.name))).slice(0, NEAR_MAX);
  }
  /* 예약 메타(v3): 장소·칸·나가기 칸 공통. place.booking이 있으면 기본값 위에 덮어쓴다(빠진 필드 보정). */
  function bookingOf(place) {
    return Object.assign({}, PLACE_DEFAULT_BOOKING, place && place.booking && typeof place.booking === 'object' ? place.booking : {});
  }

  // ---------- 나가기: 카드 → Ret(정규화) → leaveBy/exitFor ----------
  /* 모드: card.taxi → taxi / card.board 있고 none·noDest 아님 → timetable / hour 있고 (dest==='none'|card.noDest) → time(at=dep)
   *      / hour 있고 (card 없음|card.none) → unknown(at = dep−buffer: 가는 시간을 모르니 그 시각엔 역에 있어야 한다) / hour 없음 → free(at = 23:59 — 마무리 시각을 만들지 않고 오늘 경계만)
   * deps: 오늘 시간표(분 배열)|null. ride = card.arrive − card.board */
  function normalizeReturn(a) {
    a = a || {};
    const card = a.card || null, now = clampInt(a.now, 0, LAST_MIN, 0);
    // 시각 클램프: hour 24·minute 60·음수·자정 넘김은 전부 그날 안(0~23:59)으로 접는다 — 자정 넘는 계산은 안 한다(추측 금지)
    const hour = isNum(a.hour) ? Math.max(0, Math.min(LAST_HOUR, Math.round(a.hour))) : null;
    const minute = clampInt(a.minute, 0, 59, 0), buffer = clampInt(a.buffer, 0, LAST_MIN, 0);
    const dep = hour === null ? null : Math.min(LAST_MIN, hour * 60 + minute), deadline = dep === null ? null : Math.max(0, dep - buffer);
    const destName = a.destName || null;
    const base = { mode: 'free', now, dep, deadline, deps: null, ride: null, board: null, hub: null, hubPos: null, line: null, dir: null, leave: null, arriveBy: null, fare: null, dest: destName, at: null, confidence: '' };
    if (card && card.taxi) {
      const arriveBy = clampInt(card.arriveBy, 0, LAST_MIN, deadline), leave = clampInt(card.leave, 0, LAST_MIN, null);
      return Object.assign(base, { mode: 'taxi', leave, arriveBy, ride: isNum(card.ride) ? card.ride : null, fare: isNum(card.fare) ? card.fare : null, dest: card.dest || destName, at: leave, confidence: card.confidence || '택시 기준(카카오 길찾기)' });
    }
    if (card && isNum(card.board) && !card.none && !card.noDest) {
      const ride = isNum(card.arrive) ? card.arrive - card.board : (isNum(card.ride) ? card.ride : null);
      return Object.assign(base, { mode: 'timetable', deps: Array.isArray(a.deps) ? a.deps.filter(isNum).slice().sort((x, y) => x - y) : null, ride, board: clampInt(card.board, 0, LAST_MIN, null), hub: card.hub || null, hubPos: card.hubPos || null, line: card.line || null, dir: card.dir || null, confidence: card.confidence || '시간표' });
    }
    if (dep !== null && (a.dest === 'none' || (card && card.noDest))) return Object.assign(base, { mode: 'time', at: dep, confidence: '정한 시각만' });
    if (dep !== null) return Object.assign(base, { mode: 'unknown', at: Math.max(0, dep - buffer), confidence: '가는 시간 확인 못 함' });
    return Object.assign(base, { mode: 'free', at: LAST_MIN, confidence: '시간 제한 없음' });   // 시각을 안 정했으면 마무리 시각을 만들지 않는다(2026-09-04 결정) — 경계는 오늘 자정(23:59) 하나뿐
  }
  /* 그 자리(pos)에서 나가야 할 시각. timetable: 승차 − 도보(pos→역) − 3 / taxi: 카드의 leave / 그 외: at */
  function leaveBy(ret, pos, walkMin, companion) {
    if (!ret) return null;
    // 정규화를 안 거친 Ret(외부 호출)에서도 NaN을 흘리지 않는다 — 유한수가 아니면 null(레드팀 RT-03)
    if (ret.mode === 'timetable') { const v = ret.board - hubWalk(ret, pos, walkMin, companion) - BOARD_BUFFER; return isNum(v) ? v : null; }
    if (ret.mode === 'taxi') return isNum(ret.leave) ? ret.leave : null;
    if (ret.mode === 'legacy') { let v; try { v = ret.leaveByFor(pos, pos); } catch (err) { v = null; } return isNum(v) ? v : null; }   // 구 plan-ui(leaveByFor) 호환
    return isNum(ret.at) ? ret.at : null;
  }
  function hubWalk(ret, pos, walkMin, companion) {
    if (!ret.hubPos || !pos || !isNum(pos.lat)) return 0;
    const w = walkOf(walkMin, pos, ret.hubPos, companion || 'senior');
    return w === null ? 0 : w;
  }
  /* '돌아가는 칸'. alt = deps에서 board보다 뒤이면서 d+ride ≤ deadline인 첫 차(카드가 ok[-2]를 고르므로 보통 존재, 그 뒤가 없으면 last:true) */
  function exitFor(ret, lastPos, lastEnd, walkMin, companion) {
    ret = ret || normalizeReturn({});
    const raw = leaveBy(ret, lastPos, walkMin, companion), leave = isNum(raw) ? raw : null;
    const ex = { mode: ret.mode === 'legacy' ? 'unknown' : ret.mode, leave, dep: isNum(ret.dep) ? ret.dep : null, arrive: null, slack: null, walkToHub: null, board: null, hub: null, hubPos: null, line: null, dir: null,
      dest: ret.dest || null, ride: null, fare: null, confidence: ret.confidence || '', alt: null, fixed: true, late: false, over: 0, past: false };
    if (ret.mode === 'timetable') {
      const w = hubWalk(ret, lastPos, walkMin, companion);
      const arrive = isNum(ret.ride) ? ret.board + ret.ride : null;
      Object.assign(ex, { walkToHub: w, board: ret.board, hub: ret.hub, hubPos: ret.hubPos, line: ret.line, dir: ret.dir, ride: ret.ride, arrive, slack: isNum(arrive) && isNum(ret.dep) ? ret.dep - arrive : null });
      if (Array.isArray(ret.deps) && isNum(ret.ride) && isNum(ret.deadline)) {
        const later = ret.deps.filter(d => d > ret.board && d + ret.ride <= ret.deadline).sort((x, y) => x - y);
        if (later.length) { const b = later[0]; ex.alt = { board: b, leave: b - w - BOARD_BUFFER, arrive: b + ret.ride, slack: isNum(ret.dep) ? ret.dep - (b + ret.ride) : null, last: later.length === 1 }; }
      }
    } else if (ret.mode === 'taxi') {
      Object.assign(ex, { arrive: isNum(ret.arriveBy) ? ret.arriveBy : null, slack: isNum(ret.dep) && isNum(ret.arriveBy) ? ret.dep - ret.arriveBy : null, ride: ret.ride, fare: ret.fare });
    }
    if (isNum(lastEnd) && isNum(leave)) { ex.late = lastEnd > leave; ex.over = Math.max(0, lastEnd - leave); }
    ex.past = isNum(ret.now) && isNum(leave) && leave < ret.now;
    return ex;
  }

  // ---------- 생성 ----------
  function legacyEdits(o) {                         // 구 plan-ui 입력(rejected:{i:Set}, fixed:{i:id}) 호환 — B 전환 후 불필요
    const e = emptyEdits(o.intent);
    for (const k of Object.keys(o.rejected || {})) e.rejected[k] = Array.from(o.rejected[k] || []);
    for (const k of Object.keys(o.fixed || {})) if (o.fixed[k]) e.fixed[k] = o.fixed[k];
    return e;
  }
  /* 칸 하나를 채운다(generate 규칙 3~5). g = 진행 상태 { o, oo, edits, walk, usedIds, slots, cur, pos, n, lbAt } —
   * 채워지면 g.slots에 칸을 밀어 넣고 g.cur(시각)·g.pos(자리)·g.n(번호)를 다음으로 옮긴다. 못 채우면 skipped 칸만 남기고 시각·자리는 그대로. */
  function fillSlot(s, g) {
    const { o, oo, edits, walk, usedIds, lbAt } = g, pos = g.pos, companion = o.companion || 'senior';
    const key = String(s.id), stay = clampInt(edits.stay[key], STAY_MIN, STAY_MAX, STAY[s.cat] || STAY.play);
    const rejList = edits.rejected[key] || [], rej = new Set(rejList), fixedId = edits.fixed[key] || null, pickId = edits.pick[key] || null;
    const aiId = fixedId || pickId ? null : aiPickOf(o.ai, key);          // 사용자 편집(고정·pick)이 AI 제안보다 세다(설계 §5)
    const base = { id: s.id, cat: s.cat, stay, added: s.added, aux: !!s.aux, n: null, place: null, name: '', walk: 0, move: null, arrive: null, end: null, from: pos && isNum(pos.lat) ? { lat: pos.lat, lon: pos.lon } : null, leaveBy: null,
      candidates: 0, seen: 0, rejected: rejList.length, fixed: false, pick: false, tight: false, late: false, over: 0, skipped: false, reason: '', booking: mergeBooking(bookingOf(null), edits.booking[key]),
      why: null, aiPicked: false, aiFallback: false };
    // 규칙 3: 후보. 고정 칸은 자기 가게를 분모에 넣는다(다른 칸엔 이미 선점돼 안 보임)
    const excl = new Set(usedIds); if (fixedId) excl.delete(fixedId);
    if (s.cat === 'sight' && !fixedId && !pickId && !candidates('sight', pos, oo, excl).some(x => !rej.has(x.p.id))) {   // 구경: 걸어갈 관광지(서버 sight)가 없을 때만 장소 없이 동네 산책(지도 번호 없음)
      const lb = lbAt(pos), end = g.cur + stay;
      Object.assign(base, { name: `${o.areaName && o.areaName !== '광주' ? o.areaName : '이 동네'} 골목 산책`, arrive: g.cur, end, leaveBy: lb });
      if (isNum(lb) && end > lb) { g.slots.push(Object.assign(base, { arrive: null, end: null, skipped: true, reason: '시간이 모자라요' })); return; }
      base.tight = isNum(lb) && end > lb - TIGHT_MIN;
      g.slots.push(base); g.cur = end; return;
    }
    const sel = pickCandidate(s, g, { excl, rej, key, fixedId, pickId, aiId });
    const cands = sel.cands, total = sel.total;
    let choice = sel.choice, aiOk = sel.aiOk;
    if (aiOk && choice) {                                                 // AI 픽 시간 재검증: 나갈 시각에 안 맞으면 다음 후보로 내린다(설계 §5)
      const lb0 = lbAt(choice.p);
      if (isNum(lb0) && g.cur + choice.walk + stay > lb0) {
        const next = cands.find(x => x.p.id !== aiId && !rej.has(x.p.id)) || null;
        if (next) { choice = next; aiOk = false; }
      }
    }
    if (aiId !== null) base.aiFallback = !aiOk;                           // AI 픽을 못 쓴 칸(무효 id·상한 밖·시간 안 맞음·사용자 거절)
    if (!choice) {                                                        // 못 채운 칸: 사유만 남기고 시각·자리는 그대로(뒤에 고정 칸·짧은 칸이 올 수 있다)
      if (fixedId) { base.fixed = true; g.slots.push(Object.assign(base, { candidates: total, skipped: true, reason: '고정한 곳이 멀어요' })); return; }
      const reason = total ? `${total}곳 다 보셨어요` : `걸어서 ${maxWalkOf(o)}분 안에 없어요`;
      g.slots.push(Object.assign(base, { candidates: total, seen: total, skipped: true, reason })); return;
    }
    if (fixedId) base.fixed = true;
    // 규칙 4: 시간 — 이 칸으로 오는 길의 이동수단(사용자 선택 또는 자동=도보)이 정한 분을 더한다
    const mv = moveFor(o, pos, choice.p, choice.walk, edits.mode[key] || null, companion);
    const arrive = g.cur + mv.min, end = arrive + stay, lb = lbAt(choice.p);
    Object.assign(base, { candidates: total, seen: cands.indexOf(choice) + 1, pick: !!pickId && choice.p.id === pickId, leaveBy: lb, booking: mergeBooking(bookingOf(choice.p), edits.booking[key]) });
    const overBy = isNum(lb) ? end - lb : 0;
    if (overBy > 0 && !base.fixed) { if (aiId !== null) base.aiFallback = true; g.slots.push(Object.assign(base, { skipped: true, reason: '시간이 모자라요' })); return; }   // break 아님: 뒤에 고정 칸·짧은 칸이 올 수 있다
    Object.assign(base, { place: choice.p, name: choice.p.name, walk: choice.walk, move: mv, arrive, end, aiPicked: !!aiOk, why: aiOk ? aiWhyOf(o.ai, key) : null });
    if (overBy > 0) Object.assign(base, { late: true, over: overBy, reason: `${overBy}분 넘겨요` });
    if ((base.fixed || base.pick) && mv.mode === 'walk' && choice.walk > maxWalkOf(o)) base.reason = (base.reason ? base.reason + ' · ' : '') + `걸어서 ${choice.walk}분이에요`;
    // 규칙 5
    base.tight = isNum(lb) && end > lb - TIGHT_MIN;
    base.n = ++g.n;
    g.slots.push(base); usedIds.add(choice.p.id); g.cur = end; g.pos = choice.p;
  }
  /* 그 칸에 넣을 곳 고르기(규칙 3). pick은 맨 앞으로, 고정은 거리·거절을 무시, AI 픽은 후보 안일 때만 맨 앞으로. → { cands, total, choice|null, aiOk } */
  function pickCandidate(s, g, w) {
    const { oo, edits, walk } = g, pos = g.pos, { excl, rej, key, fixedId, pickId, aiId } = w;
    let cands = candidates(s.cat, pos, oo, excl), pickOk = false, aiOk = false;
    if (pickId) {
      const i = cands.findIndex(x => x.p.id === pickId);
      if (i >= 0) { pickOk = true; if (i > 0) cands = [cands[i]].concat(cands.slice(0, i), cands.slice(i + 1)); }
      else if (!excl.has(pickId)) {                                       // v3 swap: 걷기 상한 밖이어도 고른 곳은 맨 앞에 넣는다(고정처럼 거리 무시, 거절은 존중)
        const p = oo.places.find(q => q.category === s.cat && q.id === pickId);
        const wk = p && pos && isNum(pos.lat) ? walk(pos, p) : null;      // 모르는 placeId·좌표 없는 장소는 조용히 무시(바꾸기 시트가 토스트로 알린다)
        if (wk !== null) { cands = [{ p, walk: wk }].concat(cands); pickOk = true; }
      }
    }
    // 안전 저하(레드팀 RT-02): 바꾸기로 고른 곳을 못 찾으면 그 바꾸기는 없던 일 — 직전 장소의 거절도 풀어 원래 자리를 지킨다
    if (pickId && !pickOk && edits.swapFrom[key]) rej.delete(edits.swapFrom[key]);
    if (aiId !== null && aiId !== undefined && !pickId && !fixedId) {     // AI 픽은 pick과 같은 효력이되 후보 안(걷기 상한 안)이어야 하고, 거절한 곳은 못 쓴다
      const i = cands.findIndex(x => x.p.id === aiId);
      if (i >= 0 && !rej.has(aiId)) { aiOk = true; if (i > 0) cands = [cands[i]].concat(cands.slice(0, i), cands.slice(i + 1)); }
    }
    const total = cands.length;
    let choice;
    if (fixedId) {
      choice = cands.find(x => x.p.id === fixedId) || null;
      if (!choice) { const p = oo.places.find(q => q.id === fixedId), wk = p && pos && isNum(pos.lat) ? walk(pos, p) : null; if (wk !== null) choice = { p, walk: wk }; }   // 거리 상한 무시
    } else choice = cands.find(x => !rej.has(x.p.id)) || null;
    return { cands, total, choice, aiOk };
  }
  /* o = { now, startAt, startPos, places, intent, intents?, companion:'senior', walkMin(a,b,companion), ret, edits, areaName, transit? }
   * 규칙(설계 §2): 1 순서=템플릿+added−removed·stay 반영(v3: edits.order가 있으면 그 순서) / 2 usedIds는 고정 가게로 선점 / 3 pick 우선, 고정은 거리·거절 무시 /
   * 4 시간 초과: 고정 칸은 late·over로 남기고 뒤 칸은 밀림, 비고정 칸은 skipped 후 continue / 5 tight·n / 6 exit·spare / 7 분 정수
   * v3 intents: o.intents(배열)가 있으면 템플릿 = 고른 순서대로 칸 1개씩(id 0..k−1). sight가 하나도 없으면 보조 칸 sight(id k, aux:true) 후보 —
   *   edits.order에 그 id가 있으면 일반 칸으로 그 자리에, 아니면 다른 칸을 다 채운 뒤 남는 시간 ≥ AUX_MIN일 때만 뒤에 붙인다(removed면 안 붙임).
   *   o.intents가 없으면 [o.intent] → 기존 TEMPLATE 동작 그대로. 모든 슬롯·exit에 booking(예약 메타) 포함.
   * 2026-09-04(§5): o.prefs·o.tasteMap = 취향(정렬·spicy 제외), o.ai = { picks, why, order } = AI 제안 → 슬롯에 why·aiPicked·aiFallback. */
  function generate(o) {
    o = o || {};
    const companion = o.companion || 'senior', walk = (a, b) => walkOf(o.walkMin, a, b, companion);
    const oo = Object.assign({}, o, { places: validPlaces(o) });            // 자료 방어: 좌표·이름이 빈 장소는 여기서 한 번만 걸러 낸다
    const now = isNum(o.now) ? o.now : 0, startAt = isNum(o.startAt) ? o.startAt : now;
    const sp0 = o.startPos || o.origin || null, startPos = sp0 && isNum(sp0.lat) && isNum(sp0.lon) ? sp0 : null;
    const ret = o.ret || (typeof o.leaveByFor === 'function' ? { mode: 'legacy', leaveByFor: o.leaveByFor, now, dep: null, deadline: null, dest: null, confidence: '' } : normalizeReturn({ now }));
    const edits = o.edits ? snapshot(o.edits) : legacyEdits(o);
    const intents = Array.isArray(o.intents) ? o.intents.filter(c => STAY[c]) : null;
    const intent = o.intent || (intents && intents[0]) || 'none';
    const tpl = intents && intents.length ? intents : (TEMPLATE[intent] || TEMPLATE.none);
    // 규칙 1: 칸 순서 (+ v3 보조 칸·order)
    const removed = new Set(edits.removed.map(Number));
    let aux = null;                                                       // 보조 sight 칸(뒤에 붙일지 마지막에 판정)
    if (intents && intents.length && !tpl.includes('sight') && !edits.added.some(a => a.cat === 'sight')) {
      const auxId = tpl.length;
      if (!removed.has(auxId)) aux = { id: auxId, cat: 'sight', added: false, aux: true };
    }
    const auxInOrder = aux && Array.isArray(edits.order) && edits.order.includes(aux.id);
    const baseOrder = buildOrder(tpl, edits, auxInOrder ? aux : null);
    let order = applyOrder(baseOrder, edits.order || aiOrderOf(o.ai, baseOrder));   // ai.order는 사용자가 정한 순서(edits.order)가 없을 때만 쓴다
    // 규칙 2: 고정 가게 선점(빠진 칸의 고정은 무시)
    const usedIds = new Set();
    for (const s of order) { const f = edits.fixed[String(s.id)]; if (f) usedIds.add(f); }
    const g = { o, oo, edits, walk, usedIds, slots: [], cur: startAt, pos: startPos, n: 0,
      lbAt: (p) => leaveBy(ret, p, o.walkMin, companion) };
    for (const s of order) fillSlot(s, g);
    if (aux && !auxInOrder) {                                             // v3 보조 칸: 남는 시간 ≥ AUX_MIN일 때만. 단 free 모드는 마무리 시각이 없으므로 칸 수로만 판정(시간 무관)
      let attach;
      if (ret.mode === 'free') attach = g.slots.filter(s => !s.skipped).length <= AUX_MAX_SLOTS;
      else { const lb = g.lbAt(g.pos); attach = isNum(lb) && lb - g.cur >= AUX_MIN; }
      if (attach) { order = order.concat([aux]); fillSlot(aux, g); }
    }
    // 규칙 6
    const slots = g.slots;
    const filled = slots.filter(s => !s.skipped);
    const lastEnd = filled.length ? filled[filled.length - 1].end : startAt;
    const exit = exitFor(ret, g.pos, lastEnd, o.walkMin, companion);
    exit.booking = mergeBooking(bookingOf(null), edits.booking.exit);     // 기차 예매 자리(v3) — edits.booking.exit이 있으면 그걸로
    const plan = {
      v: 1, builtAt: now, startAt, startPos, transit: o.transit || null, intent, intents: intents && intents.length ? intents.slice() : null, slots, exit, exitAt: exit.leave,
      maxWalk: maxWalkOf(o),                                             // 이 일정을 짤 때 쓴 걷기 상한(분) — 화면 문구·경고 배지가 이 값을 쓴다
      order: slots.map(s => s.id),
      lastPos: g.pos, lastEnd, spare: isNum(exit.leave) ? exit.leave - lastEnd : null,
      tight: slots.some(s => s.tight), late: isNum(exit.leave) && lastEnd > exit.leave,
      done: filled.length, unverified: filled.filter(s => s.place).length,
    };
    return assertPlan(plan, order);                                       // ?debug=1에서만 불변식 검사(arrive≤end·칸 순서=order)
  }

  /* '다시 짜기'(불변형): 고정 아닌 채워진 칸의 가게를 그 칸의 '여긴 말고' 목록에 넣고 다시 짠다 → 칸마다 다음 후보로.
   * 후보가 떨어져 비워진 칸(거절 목록이 남았는데 못 채운 칸)은 목록을 비워 첫 후보로 순환. 앞 칸이 바뀌면 뒤 칸 후보도 바뀌므로 반복(최대 10회).
   * gen(edits) → Plan. 돌려주는 값은 새 Edits(prevPlan·edits는 손대지 않음). */
  function reshuffle(edits, prevPlan, gen) {
    const e = snapshot(edits);
    if (typeof gen !== 'function') return e;                                   // 생성 함수가 없으면 원본 그대로(레드팀 RT-04)
    for (const s of (Array.isArray(prevPlan && prevPlan.slots) ? prevPlan.slots : [])) {
      if (!s || typeof s !== 'object' || !s.place || s.skipped || s.fixed) continue;
      if (s.booking && s.booking.status && s.booking.status !== 'none') continue;   // 예약된 칸은 '다시 짜기'에서도 안 바꾼다(제품 요구)
      const k = String(s.id), l = e.rejected[k] || (e.rejected[k] = []);
      if (!l.includes(s.place.id)) l.push(s.place.id);
    }
    let next = gen(snapshot(e));
    for (let i = 0; i < RESHUFFLE_MAX; i++) {
      const empty = (Array.isArray(next && next.slots) ? next.slots : []).find(s => s && s.skipped && !s.fixed && e.rejected[String(s.id)] && e.rejected[String(s.id)].length);
      if (!empty) break;
      delete e.rejected[String(empty.id)]; next = gen(snapshot(e));
    }
    return e;
  }

  // ---------- 문장 (60대 말투, 미확인 숫자 금지). kor(min) → '오후 6시 15분' 주입 ----------
  function exitSentence(exit, kor, destKind) {
    if (!exit) return '';
    if (exit.mode === 'free') return '';                                   // 시각을 안 정한 자유 모드: 마무리 문장을 만들지 않는다(2026-09-04 결정)
    const k = typeof kor === 'function' ? kor : String, kind = destKind || '차', dest = exit.dest || '역';
    if (!isNum(exit.leave)) return '나갈 시각을 아직 못 정했어요';
    switch (exit.mode) {
      case 'timetable': return `${k(exit.leave)}에 나가면 ${isNum(exit.arrive) ? k(exit.arrive) + ' ' : ''}${dest} 도착${isNum(exit.dep) ? `, ${kind} ${k(exit.dep)}` : ''}`;
      case 'taxi': return `${k(exit.leave)}에 택시 타면 ${isNum(exit.arrive) ? k(exit.arrive) + '까지 ' : ''}${dest} 도착${isNum(exit.dep) ? `, ${kind} ${k(exit.dep)}` : ''}`;
      case 'time': return `${k(exit.leave)}까지예요`;
      case 'unknown': return `가는 시간을 확인 못 했어요 · ${k(exit.leave)}엔 ${dest}에 계셔야 해요`;
      default: return '';                                                  // free · 그 밖: 마무리 문장 없음
    }
  }
  function altSentence(exit, kor) {
    if (!exit || exit.mode !== 'timetable' || !exit.alt) return null;
    const k = typeof kor === 'function' ? kor : String, a = exit.alt;
    return `한 대 뒤 ${k(a.board)} 차도 돼요 → ${k(a.arrive)} 도착${isNum(a.slack) ? ` · 여유 ${a.slack}분` : ''}${a.last ? ' · 이게 마지막이에요' : ''}`;
  }
  function slotSub(slot) {
    if (!slot) return '';
    if (slot.skipped) return slot.reason || '';
    if (slot.cat === 'sight' || !slot.place) return '';
    const kind = PLACE_KO[slot.cat] || KO[slot.cat] || '곳';
    const head = slot.seen ? `근처 ${kind} ${slot.candidates}곳 중 ${slot.seen}번째` : '고정한 곳';   // seen 0 = 고정 가게가 걷기 상한 밖
    return `${slot.place.sub ? slot.place.sub + ' · ' : ''}${head} · 영업 미확인`;
  }

  const api = {
    STAY, TEMPLATE, KO, PLACE_KO, MOVE_MODES, MOVE_KO, MAX_WALK, WALK_STEP, WALK_LIMIT_MIN, WALK_LIMIT_MAX, maxWalkOf, TIGHT_MIN, BOARD_BUFFER, UNDO_DEPTH, AUX_MIN, AUX_MAX_SLOTS, NEAR_RADIUS_M, NEAR_MAX, PLACE_DEFAULT_BOOKING, STAY_MIN, STAY_MAX,
    emptyEdits, applyEdit, snapshot, pushUndo, popUndo, candidates, candidatesNear, bookingOf, normalizeReturn, leaveBy, exitFor, generate, reshuffle, exitSentence, altSentence, slotSub,
    isBooked, validPlace, normBooking, normOrder, setDebug,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ItdaPlan = api;
})();
