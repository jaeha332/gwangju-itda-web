/* 광주잇다 — 지도 기본 층 (네이버 지도 JS v3 GL + places-data.js) 청사진 §3.5·§5.2
 * 마커: 종류별 같은 모양(식당·카페·플레이스·숙박). 시간 판정(judge)은 지도 색에 쓰지 않고 가게 시트의 문장에만 쓴다(2026-09-03 밤 대표 결정: 색만 보고 이해 못 하는 판정은 지도에서 뺀다).
 * 영업 여부는 전부 '확인 못 함' — 판정은 이동시간만으로.
 * 2026-09-04 카카오맵 → 네이버 지도 교체(대표 승인): 카카오 JS SDK 4.5.26에는 지도 회전 API가 아예 없다[실측 — kakao.js에 bearing 0건, pan/tilt는 로드뷰 시점용].
 *   네이버는 submodules=gl + gl:true(벡터 지도)에서 두 손가락 회전·기울임(disableRotateTilt:false)과 나침반(compassControl)이 SDK 기본 기능이다[실측 2026-09-04, v3.10.1]. */
(function () {
  'use strict';
  const NAVER_KEY_ID = 'qbz4pbslge';   // 지도 표시용 클라이언트 ID(NCP 콘솔 '서비스 URL'에 등록된 도메인에서만 뜬다). 시크릿은 .env에만.
  const NAVER_SDK = `https://oapi.map.naver.com/openapi/v3/maps.js?submodules=gl&ncpKeyId=${NAVER_KEY_ID}`;
  const GL_WAIT_MS = 4000;    // gl 서브모듈은 maps.js 뒤에 따로 붙는다 — 붙기 전에 지도를 만들면 회전이 안 되는 2D로 뜬다. 못 붙어도 지도는 그린다(회전만 없음)
  const MIN_STAY = { eat: 45, cafe: 30, play: 30, sight: 20, stay: null };
  const WALK = { detour: 1.2, speed: { senior: 45, default: 67, child: 55 } };
  const CAT_KO = { eat: '식당', cafe: '카페', play: '플레이스', stay: '숙박', sight: '관광지' };
  const EARTH_R_M = 6371000;                 // 하버사인 지구 반지름(m)
  const CENTER = { lat: 35.1487, lon: 126.9166 };   // 기본 중심(충장로) — 내 위치·동네 중심을 모를 때
  const FREE_WALK_MAX = 30;   // 나갈 시각 없음: 걸어서 이만큼 안이면 갈 만한 곳 [정책값]
  const BOARD_BUFFER = 3;     // 승차 전 여유(분)
  const TIGHT_MIN = 10;       // 나갈 시각 이만큼 안이면 '빠듯'
  /* 배율: 네이버는 카카오와 반대로 zoom이 클수록 확대다(구 카카오 level 4·3 → 네이버 zoom 16·17) */
  const ZOOM_PREVIEW = 16, ZOOM_FULL = 17;   // 고정 배율(미리보기·전체화면) — 가게가 몇 곳이든 마커가 겹치지 않는 축척
  const ZOOM_FAR = 15;        // 이보다 축소하면(zoom ≤ 15) 마커를 작은 점으로(.far)
  const ZOOM_MIN = 10, ZOOM_MAX = 20;
  const BOUNDS_PAD = 24;      // fitBounds 여백(px)
  const VIEW_PAD = 0.25;     // 화면 밖 이만큼(가로·세로 비율)까지 미리 그린다 — 살짝 밀었을 때 빈자리가 안 보이게
  const REDRAW_MS = 160;     // 지도를 멈춘 뒤 이만큼 지나면 다시 묶는다(미는 중엔 계산하지 않는다)
  const NO_CLUSTER_ZOOM = 17;   // 이 배율부터는 묶지 않고 낱개로 보여준다 [정책값] — 확대했는데도 묶이면 답답하다(2026-09-04 대표 지시). 화면이 좁아져 어차피 몇십 곳뿐이다
  const CELL_PX = 64;        // 묶는 격자 한 칸(화면 픽셀) [정책값] — 이 안에 여럿이면 한 점으로 묶는다. 확대하면 칸이 잘게 나뉘어 저절로 낱개가 된다
  const CL_STEP = [10, 50];  // 묶음 점 크기 3단계 경계(작음·중간·큼)
  const TINY_SPAN = 0.0004;   // 이보다 좁은 범위는 fitBounds가 최대 확대로 튄다 — 중심 + 고정 배율로 대신한다
  const RELAYOUT_MS = 50;     // 시트·화면 전환 직후 크기 반영
  const ICON = {
    eat: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v18"/><path d="M4 3v5a3 3 0 0 0 6 0V3"/><path d="M17 3c-2 1-3 4-3 7h3v11"/></svg>',
    cafe: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.8L12 3z"/></svg>',
    sight: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V10l7-6 7 6v11"/><path d="M10 21v-6h4v6"/></svg>',
    stay: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-7h18v7"/><path d="M3 11V7a2 2 0 0 1 2-2h6v6"/></svg>',
  };

  /* 구간별 선 모양(설계 §2): 걷기=회색 점선, 버스·지하철=파랑 실선, 택시=주황 실선 */
  const LEG_STYLE = {
    walk: { color: '#6B7A88', weight: 4, style: 'shortdash', opacity: 0.85 },
    bus:  { color: '#0B57A4', weight: 5, style: 'solid',     opacity: 0.9 },
    taxi: { color: '#E0743A', weight: 5, style: 'solid',     opacity: 0.9 },
  };
  const PREVIEW_THIN = 2;   // 미리보기(썸네일)는 이만큼 얇게
  const Z_HERE = 7;         // '여기' 번호 마커는 다른 번호보다 한 층 위

  let sdkReady = null;
  function loadSdk() {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise((res, rej) => {
      if (window.naver && naver.maps && naver.maps.Map) return res();
      window.navermap_authFailure = () => console.warn('naver map auth fail — NCP 콘솔 서비스 URL 등록 확인');
      const s = document.createElement('script');
      s.src = NAVER_SDK;
      s.onerror = () => rej(new Error('naver sdk load fail'));
      s.onload = () => {
        if (!window.naver || !naver.maps || !naver.maps.Map) return rej(new Error('naver sdk not ready'));
        const t0 = Date.now();
        const tick = () => (('glEnabled' in naver.maps) || Date.now() - t0 > GL_WAIT_MS) ? res() : setTimeout(tick, 50);
        tick();
      };
      document.head.appendChild(s);
    });
    return sdkReady;
  }

  // ---------- 데이터 ----------
  function places() {
    const d = window.PLACES_DATA; if (!d) return [];
    if (!Array.isArray(d.cols) || !Array.isArray(d.rows)) return [];
    const ix = Object.fromEntries(d.cols.map((c, i) => [c, i]));
    return d.rows
      .map(r => (r ? { id: r[ix.id], name: r[ix.name], category: r[ix.category], sub: r[ix.sub], lat: r[ix.lat], lon: r[ix.lon], zone: r[ix.zone], trust: r[ix.trust], dong: ix.dong !== undefined ? r[ix.dong] : '' } : null))
      .filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && typeof p.name === 'string' && p.name.trim().length > 0 && typeof p.category === 'string');
  }
  function distM(a, b) {   // 좌표가 유한수가 아니면 null(호출부는 null을 '거리 미상'으로 다룬다)
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
    const R = EARTH_R_M, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const walkMin = (a, b, companion = 'senior') => { const d = distM(a, b); return d === null ? null : Math.ceil(d * WALK.detour / WALK.speed[companion]); };

  /* 판정(청사진 §5.2): 도착(p) + 최소체류 ≤ 나가야 할 시각(p) = 승차시각 − walk(p→hub) − 3
   * ctx = { now(분), origin{lat,lon,zone,key}, zone(카드 권역), hub{lat,lon}, board(분)|null, inbound{walk,wait,ride,alight{lat,lon}}|null, companion } */
  const anyJudge = (ctx) => (ctx.taxiLeave !== null && ctx.taxiLeave !== undefined) || (ctx.deadline !== null && ctx.deadline !== undefined) || !!ctx.freeMode;   // 회랑 밖 판정 모드 있음
  function judge(p, ctx) {
    if (!p || typeof p.category !== 'string') return { state: 'unknown', why: '이 장소 정보를 확인 못 했어요' };
    if (p.category === 'stay') return { state: 'none', why: '숙박은 시간 판정을 안 해요' };
    if (ctx.freeMode) {                                                    // 나갈 시각 없음: 시간 제한 없이 걸어갈 만한 곳(30분 안)
      if (!ctx.origin || !ctx.origin.lat) return { state: 'unknown', why: '지금 위치를 몰라요' };
      const w = walkMin(ctx.origin, p, ctx.companion);
      if (w === null) return { state: 'unknown', why: '거리를 확인 못 했어요' };
      return w <= FREE_WALK_MAX ? { state: 'ok', arrive: ctx.now + w, free: true, tight: false, why: '' } : { state: 'late', why: `걸어서 ${w}분이라 멀어요` };
    }
    const lb = ctx.taxiLeave ?? ctx.deadline;                              // 택시 기준 나갈 시각, 또는 타는 곳 미정이면 정한 시각까지
    if (lb !== null && lb !== undefined) {                                 // 이 동네 어디서든 '나갈 시각'은 같다고 본다(택시는 가게 앞에서 부르니까)
      if (!ctx.origin || !ctx.origin.lat) return { state: 'unknown', why: '지금 위치를 몰라요' };
      const w0 = walkMin(ctx.origin, p, ctx.companion);
      if (w0 === null) return { state: 'unknown', why: '거리를 확인 못 했어요' };
      const arrive = ctx.now + w0;
      const stay = MIN_STAY[p.category] ?? 30, leaveBy = lb;
      const ok = arrive + stay <= leaveBy;
      return { state: ok ? 'ok' : 'late', arrive, leaveBy, taxi: ctx.taxiLeave != null, tight: ok && arrive + stay > leaveBy - TIGHT_MIN, why: ok ? '' : `여기까지 걸어서 ${arrive - ctx.now}분이라 ${fmt(leaveBy)}까지 ${stay}분 있기 어려워요` };
    }
    if (!ctx.zone || ctx.board === null || ctx.board === undefined) return { state: 'unknown', why: '돌아가는 길을 아직 확인 못 한 동네예요' };
    if (p.zone !== ctx.zone) return { state: 'unknown', why: '이 동네의 돌아가는 길은 아직 확인 못 했어요' };
    let arrive;
    if (ctx.origin.zone === ctx.zone) {
      const w1 = walkMin(ctx.origin, p, ctx.companion);
      if (w1 === null) return { state: 'unknown', why: '거리를 확인 못 했어요' };
      arrive = ctx.now + w1;
    } else if (ctx.inbound) {
      const w2 = walkMin(ctx.inbound.alight, p, ctx.companion);
      if (w2 === null) return { state: 'unknown', why: '거리를 확인 못 했어요' };
      arrive = ctx.now + ctx.inbound.walk + ctx.inbound.wait + ctx.inbound.ride + w2;
    } else return { state: 'unknown', why: '여기서 가는 길을 아직 확인 못 했어요' };
    const toHub = walkMin(p, ctx.hub, ctx.companion);
    if (toHub === null) return { state: 'unknown', why: '돌아가는 거리를 확인 못 했어요' };
    const leaveBy = ctx.board - toHub - BOARD_BUFFER;
    const stay = MIN_STAY[p.category] ?? 30;
    const ok = arrive + stay <= leaveBy;
    return { state: ok ? 'ok' : 'late', arrive, leaveBy, toHub, tight: ok && arrive + stay > leaveBy - TIGHT_MIN, why: ok ? '' : `걸어서 ${toHub}분이라 ${fmt(leaveBy)}까지 못 나와요` };
  }
  function fmt(m) { m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m / 60), mm = m % 60; const ap = h < 12 ? '오전' : '오후'; const h12 = h % 12 === 0 ? 12 : h % 12; return mm ? `${ap} ${h12}시 ${mm}분` : `${ap} ${h12}시`; }

  /* 무엇을 그릴지(제조사 무관): 종류별 같은 모양의 점 + 아이콘. 어떻게 그릴지(Marker 등)는 render()에만 둔다 → 지도 SDK 교체 시 render()만 바꾼다.
   * 바깥의 .mkw는 앵커 담당 — 네이버 마커는 내용의 왼쪽 위가 좌표에 놓이므로 CSS translate로 가운데(.mkw)·아래끝(.mkw.b)을 맞춘다. 내용 크기가 달라도 좌표가 안 밀린다. */
  const wrapC = (html) => `<div class="mkw">${html}</div>`;
  const wrapB = (html) => `<div class="mkw b">${html}</div>`;
  function markerHtml(p) {
    return wrapC(`<div class="mk mk-cat ${p.category}" data-id="${p.id}">${ICON[p.category] || ''}</div>`);
  }

  // ---------- 지도 인스턴스 ----------
  const maps = {};   // id → { map, overlays[], me }
  const LL = (q) => new naver.maps.LatLng(q.lat, q.lon);
  async function ensure(id, preview) {
    await loadSdk();
    if (maps[id]) return maps[id];
    const el = document.getElementById(id);
    const P = naver.maps.Position || {};
    const map = new naver.maps.Map(el, {
      center: new naver.maps.LatLng(CENTER.lat, CENTER.lon),
      zoom: preview ? ZOOM_PREVIEW : ZOOM_FULL, minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX,
      gl: true,                                  // 벡터(WebGL) 지도 — 회전·기울임은 이 모드에서만 된다
      disableRotateTilt: false,                  // 두 손가락 회전·기울임 켜기(SDK 기본값은 꺼짐)
      compassControl: !preview,                  // 돌린 지도를 북쪽으로 되돌리는 나침반(SDK 기본 제공)
      compassControlOptions: { position: P.RIGHT_CENTER !== undefined ? P.RIGHT_CENTER : P.TOP_RIGHT },
      zoomControl: false,                        // 확대·축소는 우리 큰 버튼(index.html .mf-ctl)
      scaleControl: !preview, logoControl: true, mapDataControl: true,   // 로고·저작권 표시는 네이버 이용약관상 유지
      draggable: !preview, pinchZoom: !preview, scrollWheel: !preview,
      disableDoubleClickZoom: preview, disableDoubleTapZoom: preview, disableTwoFingerTapZoom: preview,
    });
    const inst = { map, overlays: [], me: null, pins: new Map(), clusters: new Map(), pool: [], pinClickable: false };
    maps[id] = inst;
    if (!preview) {                       // 지도를 움직이면 다시 묶는다. 'idle'은 GL(벡터) 지도에서 오지 않아 쓸 수 없다[실측 2026-09-04] — 범위 변경을 받아 뒤로 미룬다
      let t = null;
      const later = () => { clearTimeout(t); t = setTimeout(() => syncPins(inst), REDRAW_MS); };   // 미는 동안엔 계산하지 않고 멈춘 뒤에 한 번만
      naver.maps.Event.addListener(map, 'bounds_changed', later);
      naver.maps.Event.addListener(map, 'idle', later);
    }
    if (!preview) naver.maps.Event.addListener(map, 'rotation_changed', () => {   // 화면(flow.js)이 '북쪽으로' 버튼을 켜고 끌 수 있게 알린다 — SDK 나침반은 이 버전에서 안 뜬다[실측 2026-09-04]
      el.dispatchEvent(new CustomEvent('itda:rotation', { detail: { deg: map.getRotation() } }));
    });
    return inst;
  }
  function clear(m) { m.overlays.forEach(o => o.setMap(null)); m.overlays = []; if (m.me) { m.me.setMap(null); m.me = null; } m.pins.forEach(o => o.setMap(null)); m.pins.clear(); m.clusters.clear(); }
  const addMarker = (m, pos, html, z, clickable) =>
    new naver.maps.Marker({ map: m.map, position: LL(pos), icon: { content: html, anchor: new naver.maps.Point(0, 0) }, zIndex: z, clickable: !!clickable });

  const esc = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const isPos = (q) => !!q && typeof q.lat === 'number' && typeof q.lon === 'number' && !isNaN(q.lat) && !isNaN(q.lon);
  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)));

  /* 에어비앤비식 묶음: 화면을 CELL_PX 격자로 잘라 한 칸에 여럿이 들면 큰 점 하나로 묶는다. 묶음을 누르면 그 안의 목록을 준다(opts.onCluster).
   * 이유 둘 — ① 1,041곳(동명동)을 전부 DOM 마커로 두면 지도를 미는 동안 SDK가 매 프레임 1,041번 위치를 다시 잡아 버벅인다[실측 2026-09-04]
   *          ② 축소하면 점들이 겹쳐 어차피 못 읽는다. 확대하면 같은 격자가 잘게 나뉘어 저절로 낱개로 풀린다.
   * 집계 줄('1,041곳')은 묶든 말든 전체 기준 그대로다. */
  const clusterHtml = (key, n) => wrapC(`<div class="mk mk-cl ${n < CL_STEP[0] ? 's1' : n < CL_STEP[1] ? 's2' : 's3'}" data-cl="${esc(key)}"><span>${n}</span></div>`);
  function syncPins(m) {
    if (!m.pool.length && !m.pins.size) return;
    const b = m.map.getBounds(); if (!b) return;
    const sw = b.getSW(), ne = b.getNE();
    const spanLat = ne.lat() - sw.lat(), spanLon = ne.lng() - sw.lng();
    if (!(spanLat > 0) || !(spanLon > 0)) return;
    /* 격자 칸 크기는 '정수 배율'로만 정한다. 화면 범위(span/size)로 계산하면 손가락으로 조금만 확대·축소해도 칸이 계속 달라져
       묶음이 매번 새로 짜인다 — 점이 사라졌다 생겼다 하는 것처럼 보인다[대표 지적 2026-09-04].
       배율 z에서 가로 한 픽셀 = 360 / (256 · 2^z) 도(웹 메르카토르). 위도 쪽은 cos(위도)만큼 좁게 잡아야 칸이 정사각형이 된다. */
    const zi = Math.round(m.map.getZoom());
    const cellLon = CELL_PX * 360 / (256 * Math.pow(2, zi));
    const cellLat = cellLon * Math.cos((sw.lat() + ne.lat()) / 2 * Math.PI / 180);
    const dLat = spanLat * VIEW_PAD, dLon = spanLon * VIEW_PAD;
    const minLat = sw.lat() - dLat, maxLat = ne.lat() + dLat, minLon = sw.lng() - dLon, maxLon = ne.lng() + dLon;
    const cells = new Map();
    const lump = zi < NO_CLUSTER_ZOOM;   // 충분히 확대했으면 격자를 쓰지 않는다(가게마다 제 자리에 선다). 켜고 끄는 기준도 같은 정수 배율이라 손가락을 떼기 전에 오락가락하지 않는다
    for (const p of m.pool) {                                   // 화면 밖(+여백)은 아예 안 그린다
      if (p.lat < minLat || p.lat > maxLat || p.lon < minLon || p.lon > maxLon) continue;
      const key = lump ? Math.floor(p.lat / cellLat) + ':' + Math.floor(p.lon / cellLon) : 'p' + p.id;
      const c = cells.get(key); if (c) c.push(p); else cells.set(key, [p]);
    }
    const want = new Map();                                     // 마커키 → {pos, html, z} — 한 칸에 하나면 낱개, 여럿이면 묶음
    m.clusters.clear();
    cells.forEach((ps, key) => {
      if (ps.length === 1) { want.set('p:' + ps[0].id, { pos: ps[0], html: markerHtml(ps[0]), z: 2 }); return; }
      let lat = 0, lon = 0;
      for (const p of ps) { lat += p.lat; lon += p.lon; }
      m.clusters.set(key, ps);
      want.set('c:' + key, { pos: { lat: lat / ps.length, lon: lon / ps.length }, html: clusterHtml(key, ps.length), z: 3 });
    });
    m.pins.forEach((mk, k) => { if (!want.has(k)) { mk.setMap(null); m.pins.delete(k); } });   // 없어진 것만 지우고
    want.forEach((v, k) => { if (!m.pins.has(k)) m.pins.set(k, addMarker(m, v.pos, v.html, v.z, m.pinClickable)); });   // 새로 생긴 것만 만든다
  }

  /* 판정 마커: 미리보기는 갈 수 있는 곳 전부, 전체화면은 전부. 일정에 든 가게(numIds)는 번호 마커가 대신 그린다. counts를 세어 돌려준다 */
  function drawJudged(m, ctx, opts, list, numIds) {
    const counts = { total: 0, ok: 0, late: 0, unknown: 0 };
    if (opts.onlyNumbered) return counts;
    const zonePlaces = list.filter(p => !ctx.zone || p.zone === ctx.zone || !opts.preview || anyJudge(ctx));
    const judged = [];
    for (const p of zonePlaces) {
      const j = judge(p, ctx);
      if (p.category !== 'stay') { counts.total++; counts[j.state === 'ok' ? 'ok' : j.state === 'late' ? 'late' : 'unknown']++; }
      judged.push(p);
    }
    m.pool = judged.filter(p => isPos(p) && !numIds.has(String(p.id)));   // 좌표가 없는 곳은 후보에서 뺀다
    m.pinClickable = !opts.preview;
    return counts;   // 실제로 그리는 건 보기(fitView)가 정해진 뒤 render 끝에서 — 범위를 모르면 무엇이 화면에 드는지 알 수 없다
  }

  /* 경로 옵션 정규화: 새 형식 [{mode, coords}]와 기존 형식 [{lat,lon},…]을 둘 다 받는다.
   * coords 한 점은 {lat,lon} 또는 [lat,lon](서버 /route 응답 형식). 이어진 같은 점은 접고, 두 점 미만인 구간은 버린다. */
  function legPts(list) {
    const pts = (Array.isArray(list) ? list : []).map(q => (Array.isArray(q) ? { lat: q[0], lon: q[1] } : q)).filter(isPos);
    return pts.filter((q, i) => i === 0 || q.lat !== pts[i - 1].lat || q.lon !== pts[i - 1].lon);
  }
  function normLegs(route) {
    if (!Array.isArray(route) || !route.length) return [];
    const legs = route[0] && Array.isArray(route[0].coords)
      ? route.map(l => ({ mode: LEG_STYLE[l && l.mode] ? l.mode : 'walk', pts: legPts(l && l.coords) }))
      : [{ mode: 'walk', pts: legPts(route) }];
    return legs.filter(l => l.pts.length >= 2);
  }
  // 범위 맞춤에 쓸 점: 걷는 구간만. 버스·택시 구간(역까지 12km)까지 넣으면 한 화면에 다 들어오느라 동네가 점만큼 작아진다.
  function routeFitPts(legs) {
    const walk = legs.filter(l => l.mode === 'walk');
    return (walk.length ? walk : legs).reduce((a, l) => a.concat(l.pts), []);
  }

  /* 여러 점을 한 화면에. 점이 하나거나 아주 좁으면 fitBounds가 최대 확대로 튀므로 중심 + 고정 배율로 대신한다 */
  function fitTo(m, pts, zoomCap) {
    const q = pts.filter(isPos); if (!q.length) return false;
    const lats = q.map(x => x.lat), lons = q.map(x => x.lon);
    const minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    const minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
    if (maxLat - minLat < TINY_SPAN && maxLon - minLon < TINY_SPAN) {
      m.map.setCenter(new naver.maps.LatLng((minLat + maxLat) / 2, (minLon + maxLon) / 2)); m.map.setZoom(zoomCap);
      return true;
    }
    m.map.fitBounds(new naver.maps.LatLngBounds(new naver.maps.LatLng(minLat, minLon), new naver.maps.LatLng(maxLat, maxLon)), BOUNDS_PAD);
    if (m.map.getZoom() > zoomCap) m.map.setZoom(zoomCap);   // 네이버는 zoom이 클수록 확대 — 너무 당겨졌으면 되돌린다
    return true;
  }

  /* 보기 맞춤. v = { hasRoute, distinct, hub, numbered, keep } — 경로가 있으면 범위, 필터 전환이면 이전 중심·배율, 아니면 고정 배율 기본 보기 */
  function fitView(m, ctx, opts, v) {
    const zoom = opts.preview ? ZOOM_PREVIEW : ZOOM_FULL;
    if (v.hasRoute) {
      // 경계 = 경로 ∪ 내 위치 ∪ 역. 내 위치는 경로 시작 동네에 있을 때만(경기장→충장로 진입이면 4km가 한 화면에 들어와 번호가 겹친다)
      const pts = v.distinct.slice();
      if (ctx.origin && ctx.origin.lat && ctx.origin.zone === ctx.zone) pts.push(ctx.origin);
      if (v.hub) pts.push(v.hub.pos);
      fitTo(m, pts, zoom);
      return;
    }
    if (v.keep) { m.map.setCenter(v.keep.c); m.map.setZoom(v.keep.z); return; }
    // 기본 보기: 내 위치가 그 동네 안이면 내 위치, 아니면(경기장→충장로) 동네 중심. 고정 배율이라 가게가 몇 곳이든 겹치지 않는 축척으로 시작한다
    const here = ctx.origin && ctx.origin.lat && (!ctx.zone || ctx.origin.zone === ctx.zone) ? ctx.origin : (ctx.zoneCenter || (ctx.origin && ctx.origin.lat ? ctx.origin : CENTER));
    if (v.numbered.length) fitTo(m, [here].concat(v.numbered.map(x => x.p)), zoom);   // 경로 없이 번호 마커만 있으면(칸 1개) 번호와 중심을 같이 넣되 최소 배율은 지킨다
    else { m.map.setCenter(LL(here)); m.map.setZoom(zoom); }
  }

  /* 렌더: 결과 미리보기(조작 불가) 또는 전체화면. 반환 { total, ok, late, unknown }
   * opts(기술설계 §4): preview · category · onTap ·
   *   numbered: [{ p:{id,lat,lon,...}, n, fixed?, tight? }] → 일정 번호 마커 `.mk.mk-num` (탭은 기존 .mk 경로로 시트가 열린다)
   *   route:    [{mode:'walk'|'bus'|'taxi', coords:[[lat,lon]|{lat,lon}, …]}, …]  → 구간별 폴리라인(걷기 회색 점선·버스 파랑·택시 주황)
   *             또는 기존 형식 [{lat,lon}, …] → 전부 걷기 한 구간으로 본다 (Polyline은 overlays에 넣어 clear()로 같이 지움)
   *   hub:      { pos:{lat,lon}, label:'역' } | null         → `.mk-hub` 라벨
   *   me:       {lat,lon} | null                            → GPS로 지금 잡힌 위치(`.mk-me.live` 파란 점 펄스). 없으면 ctx.origin을 기존처럼 점으로만
   *   hereId:   place.id | null                             → 그 번호 마커에 `.here`(살짝 확대) — GPS 판정 '여기' 칸
   *   onlyNumbered: true → 판정 마커 전부 생략(counts는 전부 0). false면 기존처럼 그리되 numbered에 든 가게는 판정 마커를 생략(이중 표시 방지)
   *   keepView: true → 이미 떠 있는 지도의 중심·배율을 유지(카테고리 필터 전환용)
   * 기본 보기: 내 위치(다른 동네로 가는 경우엔 그 동네 중심)를 가운데 두고 고정 배율(미리보기 zoom 16, 전체 17). 경로가 있을 때만 범위 맞춤.
   * 회전·기울임은 사용자가 두 손가락으로 하고 되돌리기는 SDK 나침반이 한다 — 다시 그려도 그 각도는 건드리지 않는다. */
  async function render(id, ctx, opts) {
    opts = opts || {};
    const m = await ensure(id, !!opts.preview);
    m.map.setOptions(opts.preview
      ? { draggable: false, pinchZoom: false, scrollWheel: false }
      : { draggable: true, pinchZoom: true, scrollWheel: true });
    const keep = opts.keepView && m.drawn ? { c: m.map.getCenter(), z: m.map.getZoom() } : null;   // 필터 전환은 화면을 튀지 않게
    clear(m);
    const numbered = Array.isArray(opts.numbered) ? opts.numbered.filter(x => x && x.p && isPos(x.p)) : [];
    const numIds = new Set(numbered.map(x => String(x.p.id)));
    const hub = opts.hub && isPos(opts.hub.pos) ? opts.hub : null;
    const legs = normLegs(opts.route);       // 구간이 하나도 못 만들어지면(점 하나뿐) 경로가 아니다 — 범위 맞춤이 최대 확대로 튀는 것 방지
    const fitPts = routeFitPts(legs);
    const hasRoute = legs.length > 0;
    const list = places().filter(p => !opts.category || p.category === opts.category);
    const counts = drawJudged(m, ctx, opts, list, numIds);
    // 일정: 경로 점선 → 역 라벨 → 번호 마커 (번호가 맨 위)
    for (const lg of legs) {   // Polyline도 setMap(null)을 지원하므로 clear()에서 같이 지워진다
      const st = LEG_STYLE[lg.mode];
      const line = new naver.maps.Polyline({ map: m.map, path: lg.pts.map(LL), strokeWeight: opts.preview ? Math.max(2, st.weight - PREVIEW_THIN) : st.weight, strokeColor: st.color, strokeOpacity: opts.preview ? 0.7 : st.opacity, strokeStyle: st.style, clickable: false });
      m.overlays.push(line);
    }
    if (hub) m.overlays.push(addMarker(m, hub.pos, wrapC(`<div class="mk-hub">${esc(hub.label || '역')}</div>`), 5, false));
    const hereId = opts.hereId === null || opts.hereId === undefined ? null : String(opts.hereId);
    numbered.forEach(x => {
      const here = hereId !== null && String(x.p.id) === hereId;
      const html = wrapB(`<div class="mk mk-num${x.fixed ? ' fixed' : ''}${x.tight ? ' tight' : ''}${here ? ' here' : ''}" data-id="${esc(x.p.id)}"><span>${x.n !== null && x.n !== undefined ? esc(x.n) : ''}</span></div>`);
      m.overlays.push(addMarker(m, x.p, html, here ? Z_HERE : 6, !opts.preview));
    });
    const mePos = isPos(opts.me) ? opts.me : (ctx.origin && ctx.origin.lat ? ctx.origin : null);   // opts.me = GPS로 지금 잡힌 위치(펄스), 없으면 기존 origin 점 그대로
    if (mePos) m.me = addMarker(m, mePos, wrapC(`<div class="mk-me${isPos(opts.me) ? ' live' : ''}"></div>`), 4, false);
    fitView(m, ctx, opts, { hasRoute, distinct: fitPts, hub, numbered, keep });
    m.drawn = true;
    syncPins(m);   // 보기가 정해진 다음에 묶어서 그린다
    if (!opts.preview && !m.zoomBound) {   // 축소하면(zoom ≤ 15) 마커를 작은 점으로 — 밀집 동네에서 겹침 완화
      m.zoomBound = true; const el0 = document.getElementById(id);
      const far = () => el0.classList.toggle('far', m.map.getZoom() <= ZOOM_FAR);
      naver.maps.Event.addListener(m.map, 'zoom_changed', far); far();
    }
    if (!opts.preview && opts.onTap) {
      const el = document.getElementById(id);
      el.onclick = (e) => {
        const cl = e.target.closest('.mk-cl');                                     // 묶음 점은 가게가 아니라 목록을 연다
        if (cl) { const ps = m.clusters.get(cl.dataset.cl); if (ps && opts.onCluster) opts.onCluster(ps.slice()); return; }
        const mk = e.target.closest('.mk'); if (!mk) return;
        const pid = mk.dataset.id;
        const p = list.find(x => x.id === pid) || (numbered.find(x => String(x.p.id) === pid) || {}).p;   // 번호 마커는 카테고리 필터와 무관하게 열린다
        if (p) opts.onTap(p, judge(p, ctx));
      };
    }
    setTimeout(() => naver.maps.Event.trigger(m.map, 'resize'), RELAYOUT_MS);
    return counts;
  }

  /* 지도 조작(화면 버튼용) — SDK 호출은 이 파일 안에만 둔다. 네이버는 zoom이 클수록 확대라 zoomBy(+1)=확대 */
  function centerOn(id, pos, zoom) {   // 그 좌표로 옮긴다. zoom을 주면 배율도 맞춘다. 지도가 아직 안 그려졌으면 false.
    const m = maps[id]; if (!m || !isPos(pos)) return false;
    if (Number.isFinite(zoom)) m.map.setZoom(clampZoom(zoom), true);
    m.map.panTo(LL(pos));
    return true;
  }
  function zoomBy(id, d) {
    const m = maps[id]; if (!m) return null;
    const z = clampZoom(m.map.getZoom() + d);
    m.map.setZoom(z, true);
    return z;
  }
  const zoomOf = (id) => (maps[id] ? maps[id].map.getZoom() : null);
  function resetNorth(id) {   // 돌리고 기울인 지도를 원래대로 — 두 손가락으로 되돌리기는 어르신에게 어렵다
    const m = maps[id]; if (!m) return false;
    m.map.setRotation(0); m.map.setTilt(0);
    return true;
  }
  const rotationOf = (id) => (maps[id] && maps[id].map.getRotation ? maps[id].map.getRotation() : null);
  const statsOf = (id) => (maps[id] ? { pool: maps[id].pool.length, pins: maps[id].pins.size, clusters: maps[id].clusters.size } : null);   // 마커가 안 보일 때 어디까지 됐는지
   // 회전이 실제로 먹는지 확인용

  window.ItdaMap = { render, judge, places, fmt, CAT_KO, MIN_STAY, walkMin, distM, centerOn, zoomBy, zoomOf, rotationOf, statsOf, resetNorth, ZOOM_NEAR: ZOOM_FULL, ZOOM_MIN, ZOOM_MAX, relayout: (id) => maps[id] && naver.maps.Event.trigger(maps[id].map, 'resize') };
})();
