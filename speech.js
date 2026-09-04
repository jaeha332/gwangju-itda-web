/* 광주잇다 — 음성 입력 1겹 (청사진 §2.1·§3.2)
 * 폰 안의 음성 인식(안드로이드: capgo 플러그인 → 폰의 음성 서비스, 웹: 브라우저 Web Speech)을 통로로 쓴다. 모델은 폰 것.
 * 말 → 글자 → 시각·타는 곳·할 일 추출(앱 안 규칙). 서버 /nlu는 2단계에서 앞에 붙인다. */
(function () {
  'use strict';
  const S = () => (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SpeechRecognition) || null;
  const WebRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const MAX_MS = 12000;        // 이 시간이 지나면 듣기를 끊는다
  const STOP_SETTLE_MS = 250;  // 폰이 '멈췄다'고 알린 뒤 마지막 조각을 기다리는 시간
  const STOP_DRAIN_MS = 600;   // 우리가 stop()을 부른 뒤 결과를 기다리는 시간
  const NLU_MS = 3500;         // 서버 /nlu 기다리는 한계
  const MAX_ALT = 3;           // 후보 문장 개수

  async function available() {
    const p = S();
    if (p) { try { const r = await p.available(); return !!(r && r.available); } catch { return false; } }
    return !!WebRec;
  }
  async function ensurePermission() {
    const p = S(); if (!p) return true;
    try {
      const st = await p.checkPermissions();
      if (st.speechRecognition === 'granted') return true;
      const r = await p.requestPermissions();
      return r.speechRecognition === 'granted';
    } catch { return false; }
  }

  /* listen({ onPartial(text), onEnd(text|null), onError(msg), maxMs }) → { stop() } */
  async function listen(h) {
    const maxMs = h.maxMs || MAX_MS;
    let last = '', done = false, handles = [], timer = null;
    const finish = async (text, err) => {
      if (done) return; done = true; clearTimeout(timer);
      for (const x of handles) { try { await x.remove(); } catch {} }
      if (err) h.onError && h.onError(err); else h.onEnd && h.onEnd(text || null);
    };
    const p = S();
    if (p) {
      handles.push(await p.addListener('partialResults', (e) => { const t = (e.matches && e.matches[0]) || ''; if (t) { last = t; h.onPartial && h.onPartial(t); } if (e.forced) finish(last); }));
      handles.push(await p.addListener('listeningState', (e) => { if (e.status === 'stopped') setTimeout(() => finish(last), STOP_SETTLE_MS); }));   // 폰이 말 끝을 감지해 스스로 멈춘다
      handles.push(await p.addListener('error', (e) => finish(null, (e && e.message) || 'error')));
      try { await p.start({ language: 'ko-KR', maxResults: MAX_ALT, partialResults: true, popup: false }); }
      catch (e) { finish(null, (e && e.message) || 'start fail'); return { stop: () => {} }; }
      timer = setTimeout(() => { p.stop().catch(() => {}); setTimeout(() => finish(last), STOP_DRAIN_MS); }, maxMs);
      return { stop: () => { p.stop().catch(() => {}); } };
    }
    if (WebRec) {
      const r = new WebRec(); r.lang = 'ko-KR'; r.interimResults = true; r.maxAlternatives = MAX_ALT; r.continuous = false;
      r.onresult = (ev) => { let t = ''; for (const res of ev.results) t += res[0].transcript; if (t) { last = t; h.onPartial && h.onPartial(t); } };
      r.onerror = (ev) => finish(null, ev.error || 'error');
      r.onend = () => finish(last);
      try { r.start(); } catch (e) { finish(null, 'start fail'); }
      timer = setTimeout(() => { try { r.stop(); } catch {} }, maxMs);
      return { stop: () => { try { r.stop(); } catch {} } };
    }
    finish(null, 'unavailable'); return { stop: () => {} };
  }

  // ---------- 문장 → 조건 (앱 안 규칙) ----------
  const NUM = { '한': 1, '두': 2, '세': 3, '네': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9, '열': 10, '열한': 11, '열두': 12 };
  const MNUM = { '십': 10, '이십': 20, '삼십': 30, '사십': 40, '오십': 50 };
  const SNUM = { '오': 5, '일': 1, '이': 2, '삼': 3, '사': 4, '육': 6, '칠': 7, '팔': 8, '구': 9 };
  const RX_DIGIT_CLOCK = /(\d{1,2})\s*시\s*(반|(\d{1,2})\s*분?)?/;
  const RX_KOR_CLOCK = /(열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)\s*시\s*(반|(\d{1,2})\s*분|(오십|사십|삼십|이십|십)\s*(오|일|이|삼|사|육|칠|팔|구)?\s*분?)?/;
  // '7시 반'·'일곱 시 삼십오 분' 둘 다. 못 찾으면 null.
  function matchClock(t) {
    const mt = t.match(RX_DIGIT_CLOCK);
    if (mt) return { h: +mt[1], m: mt[2] === '반' ? 30 : (mt[3] ? +mt[3] : 0) };
    const mk = t.match(RX_KOR_CLOCK);
    if (!mk) return null;
    const m = mk[2] === '반' ? 30 : (mk[3] ? +mk[3] : (mk[4] ? MNUM[mk[4]] + (SNUM[mk[5]] || 0) : 0));
    return { h: NUM[mk[1]], m };
  }
  // 오전/오후를 말 안 했을 때 어느 쪽으로 볼지. 1~9시는 오후로 [판단], 10·11시는 지금이 오후면 오후.
  function toDayHour(h, t, nowMin) {
    const pm = /오후|저녁|밤|낮/.test(t), am = /오전|아침|새벽/.test(t);
    if (h < 12) {
      if (pm) return (h + 12) % 24;
      if (am) return h % 24;
      if (h <= 9) return (h + 12) % 24;
      if (nowMin !== undefined && nowMin >= 12 * 60) return (h + 12) % 24;
      return h % 24;
    }
    return h === 12 && am ? 0 : h % 24;
  }
  function parse(text, nowMin) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    const out = { hour: null, minute: null, dest: null, intent: null, intents: [], at: null, food: null, heard: t };
    if (!t) return out;
    // 시각
    const clock = matchClock(t);
    if (clock) { out.hour = toDayHour(clock.h, t, nowMin); out.minute = Math.min(59, clock.m || 0); }
    // 타는 곳
    if (/기차|케이티엑스|KTX|SRT|열차|송정/i.test(t)) out.dest = 'songjeong';
    else if (/버스|터미널|유스퀘어|고속/.test(t)) out.dest = 'terminal';
    // 출발 동네 — '동명동에서', '충장로 근처'처럼 말한 곳. 문장에 먼저 나온 것을 쓴다.
    const ats = [];
    for (const [k, rx] of ORIGIN_RX) { const m = t.match(rx); if (m) ats.push({ k, i: m.index }); }
    ats.sort((a, b) => a.i - b.i);
    out.at = ats.length ? ats[0].k : null;
    if (out.at && out.at === out.dest) out.at = null;             // '송정역에서 기차' — 타는 곳 얘기지 지금 있는 곳이 아니다
    // 할 일 — 여러 개 말하면 문장에 나온 순서대로 intents 배열, intent는 그 첫 번째(v3 계약: 다중 선택)
    const found = [];
    for (const [k, rx] of INTENT_RX) { const m = t.match(rx); if (m) found.push({ k, i: m.index }); }
    found.sort((a, b) => a.i - b.i);
    out.intents = found.map(x => x.k); out.intent = out.intents[0] || null;
    // 말한 음식 종류(말한 게 없으면 null — '아무거나'는 종류를 말한 게 아니라 아무 낱말에도 안 걸린다)
    out.food = firstOf(FOOD_RX, t);
    return out;
  }
  // 출발 동네 사전. 송정역·유스퀘어는 '타는 곳'(dest)과 말이 겹쳐서, 조사가 붙어 '거기서 논다'가 분명할 때만 출발지로 본다.
  const ORIGIN_RX = [
    ['dongmyeong', /동명동/],
    ['yangnim', /양림동|펭귄마을/],
    ['acc', /문화전당|ACC/i],
    ['chungjang', /충장로|금남로/],
    ['champions', /챔피언스 ?필드|야구장/],
    ['songjeong', /(?:광주 ?)?송정역 ?(?:에서|근처|쪽|앞|일대)/],
    ['terminal', /(?:유스퀘어|터미널) ?(?:에서|근처|쪽|앞|일대)/],
  ];
  const INTENT_RX = [
    ['eat', /밥|식사|먹|국밥|점심|저녁 ?먹|맛집|식당/],
    ['cafe', /카페|커피|차 ?한|빵|디저트/],
    ['play', /놀|VR|브이알|방탈출|게임|플레이스|오락/i],
    ['sight', /구경|걷|둘러|산책|관광|보고/],
  ];
  /* 말한 음식·카페 종류 — 서버 /nlu(Claude)가 먼저 채우고, 서버가 없거나 실패하면 이 사전으로 메운다.
   * 값은 취향(itda.prefs.v1)과 같은 열쇳말이라 그대로 일정 생성에 넘어간다. '아무거나'는 종류를 말한 게 아니다. */
  const FOOD_RX = [
    ['western', /양식|경양식|파스타|스테이크|피자|이탈리안|스페인|패밀리 ?레스토랑/],
    ['japanese', /일식|초밥|스시|라멘|우동|돈가스|덮밥|사시미|회덮밥/],
    ['chinese', /중식|중국집|짜장|짬뽕|탕수육|마라|훠궈/],
    ['snack', /분식|김밥|떡볶이|만두|버거|햄버거|치킨|튀김/],
    ['korean', /한식|백반|국밥|한정식|고기|삼겹|갈비|찌개|국수|칼국수|족발|보쌈|곰탕|설렁탕/],
  ];
  // 문장에 먼저 나온 것을 쓴다(여러 개를 말하면 앞의 것). 하나도 안 걸리면 null.
  function firstOf(rxs, t) {
    let best = null;
    for (const [k, rx] of rxs) { const m = t.match(rx); if (m && (best === null || m.index < best.i)) best = { k, i: m.index }; }
    return best ? best.k : null;
  }
  const uniq = (a) => a.filter((x, i) => x && a.indexOf(x) === i);

  /* 서버 /nlu(Claude) 먼저 → 못 받으면 규칙. 반환에 source:'ai'|'rule'. 서버 값이 비면 규칙 값으로 메운다. */
  async function parseSmart(text, nowMin, serverBase, timeoutMs) {
    const rule = parse(text, nowMin); rule.source = 'rule';
    if (!serverBase) return rule;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs || NLU_MS);
      const r = await fetch(serverBase + '/nlu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return rule;
      const d = await r.json();
      if (!d || !d.ok) return rule;
      const out = { hour: rule.hour, minute: rule.minute, dest: rule.dest, intent: rule.intent, intents: rule.intents.slice(), at: rule.at, food: rule.food, heard: text, source: 'ai' };
      if (d.food) out.food = d.food;                              // 서버가 찾은 음식 종류(양식→western)를 규칙보다 우선
      if (d.train_dep) { const [h, m] = d.train_dep.split(':').map(Number); out.hour = h; out.minute = m; }
      else if (d.deadline && rule.hour === null) { const [h, m] = d.deadline.split(':').map(Number); out.hour = h; out.minute = m; }
      if (d.terminal) out.dest = d.terminal; else if (d.train && !out.dest) out.dest = 'songjeong';
      if (d.origin) out.at = d.origin;                            // 서버가 찾은 출발 동네(동명동→dongmyeong)를 규칙보다 우선
      if (out.at && out.at === out.dest) out.at = null;
      // 서버 의도 1개를 앞에, 규칙이 찾은 배열을 뒤에 합친다(중복 제거). intent는 그 첫 번째.
      out.intents = uniq([...(d.intent ? [d.intent] : []), ...rule.intents]); out.intent = out.intents[0] || null;
      if (out.hour === null && !out.dest && !out.intent && !out.at && !out.food) out.source = 'rule';
      return out;
    } catch (e) { return rule; }
  }

  window.ItdaSpeech = { available, ensurePermission, listen, parse, parseSmart };
})();
