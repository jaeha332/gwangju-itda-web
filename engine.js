// 광주잇다 일정 엔진 (server/engine.py의 JS 포팅 — 동작 동일, 테스트로 검증)
// 계산에 LLM 없음. 폰 안에서 돌기 때문에 서버·네트워크 없이도 일정이 나온다.
(function (root) {
  const WALK_SPEED = { default: 67, senior: 45, child: 55 }; // m/min
  const DETOUR = 1.2;      // 직선거리 → 실제 보행거리 보정
  const BUFFER_MIN = 10;   // 마감 전 여유
  const REST_EVERY = 60, REST_MIN = 15; // 어르신 동행: 60분마다 15분 휴식

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const p1 = lat1 * r, p2 = lat2 * r;
    const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function hmToMin(s) {
    if (!s) return null;
    const [h, m] = s.split(':');
    return parseInt(h, 10) * 60 + parseInt(m, 10);
  }
  function fmt(m) {
    m = Math.round(m) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  function walkMinutes(a, b, companion) {
    const d = haversineM(a.lat, a.lon, b.lat, b.lon) * DETOUR;
    return d / (WALK_SPEED[companion] || WALK_SPEED.default);
  }
  function travelInfo(a, b, ctx) {
    const za = a.zone, zb = b.zone;
    if (za && zb && za !== zb) {
      const t = ctx.zoneTable[za + '|' + zb] ?? ctx.zoneTable[zb + '|' + za];
      return t == null ? null : { min: Number(t), mode: 'bus' };
    }
    return { min: walkMinutes(a, b, ctx.companion), mode: 'walk' };
  }
  function travelMinutes(a, b, ctx) {
    const info = travelInfo(a, b, ctx);
    return info == null ? null : info.min;
  }
  function openWindows(c) {
    const wins = c.windows || [{ open: c.open, close: c.close, last_entry: c.last_entry }];
    const out = [];
    for (const w of wins) {
      const o = hmToMin(w.open); let cl = hmToMin(w.close);
      const le = hmToMin(w.last_entry);
      if (o == null || cl == null) continue;
      if (cl <= o) cl += 1440;               // 자정 넘는 영업
      out.push([o, cl, le]);
    }
    return out;
  }
  function fitsWindow(arrive, depart, wins) {
    for (const shift of [0, 1440]) {
      const a = arrive + shift, d = depart + shift;
      for (const [o, cl, le] of wins) {
        if (a >= o && d <= cl && (le == null || a <= le)) return true;
      }
    }
    return false;
  }

  function plan(payload) {
    const ctx = {
      nowMin: hmToMin(payload.now.includes('T') ? payload.now.slice(11, 16) : payload.now),
      deadlineMin: hmToMin(payload.deadline),
      origin: payload.origin,
      returnTo: payload.return_to || payload.origin,   // KTX 등: 복귀 지점 ≠ 출발지
      companion: payload.companion || null,
      zoneTable: payload.zone_table || {},
    };
    const cands = payload.candidates || [];
    const known = cands.filter(c => (c.trust || 'unknown') !== 'unknown');
    const maybe = cands.filter(c => (c.trust || 'unknown') === 'unknown').map(c => c.id);
    const dropped = { closed: 0, unreachable: 0, time_over: 0 };

    // 1차: origin에서 직행해도 불가능한 곳 걸러내기
    const feasible = [];
    for (const c of known) {
      const t = travelMinutes(ctx.origin, c, ctx);
      if (t == null) { dropped.unreachable++; continue; }
      const arrive = ctx.nowMin + t, depart = arrive + c.stay_min;
      const back = travelMinutes(c, ctx.returnTo, ctx) || 0;
      if (depart + back + BUFFER_MIN > ctx.deadlineMin) { dropped.time_over++; continue; }
      if (!fitsWindow(arrive, depart, openWindows(c))) { dropped.closed++; continue; }
      feasible.push(c);
    }

    // 2차: 순열 전수 + 가지치기 (총 체류 최대)
    let best = [], bestStay = -1;
    function simulate(order) {
      let cur = ctx.origin, t = ctx.nowMin, walked = 0;
      const legs = [];
      for (const c of order) {
        const mv = travelMinutes(cur, c, ctx);
        if (mv == null) return null;
        t += mv;
        if (ctx.companion === 'senior') {
          walked += mv;
          if (walked >= REST_EVERY) { t += REST_MIN; walked = 0; }
        }
        const arrive = t, depart = arrive + c.stay_min;
        if (!fitsWindow(arrive, depart, openWindows(c))) return null;
        const back = travelMinutes(c, ctx.returnTo, ctx);
        if (back == null || depart + back + BUFFER_MIN > ctx.deadlineMin) return null;
        legs.push([c, arrive, depart, Math.round(mv), travelInfo(cur, c, ctx).mode]);
        t = depart; cur = c;
      }
      return legs;
    }
    function permute(pool, r, chosen) {
      if (chosen.length === r) {
        const legs = simulate(chosen);
        if (legs) {
          const stay = legs.reduce((s, [c]) => s + c.stay_min, 0);
          if (stay > bestStay) { bestStay = stay; best = legs; }
        }
        return;
      }
      for (let i = 0; i < pool.length; i++) {
        const rest = pool.slice(0, i).concat(pool.slice(i + 1));
        permute(rest, r, chosen.concat([pool[i]]));
      }
    }
    const n = feasible.length;
    for (let r = Math.min(n, 6); r >= 1; r--) {
      permute(feasible, r, []);
      if (best.length) break;
    }

    const itinerary = best.map(([c, a, d, mv, mode]) => ({
      id: c.id, name: c.name, arrive: fmt(a), depart: fmt(d),
      travel_min: mv, travel_mode: mode,
      category: c.category, trust: c.trust, checked_at: c.checked_at,
      barrier_free: c.barrier_free, lat: c.lat, lon: c.lon, phone: c.phone,
    }));
    const placed = new Set(best.map(([c]) => c.id));
    dropped.time_over += feasible.filter(c => !placed.has(c.id)).length;

    const relax = [];
    if (itinerary.length <= 2) {
      if (dropped.time_over) relax.push('마감을 30분 늦추면 후보가 늘어납니다');
      if (dropped.closed) relax.push('방문 시간대를 바꾸면 문 여는 곳이 있습니다');
    }
    return {
      itinerary,
      maybe,
      receipt: { checked: known.length, passed: itinerary.length, dropped },
      relax_suggestions: relax,
    };
  }

  const api = { plan, _hmToMin: hmToMin, _fmt: fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
