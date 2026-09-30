/* ============================================================
   ar.js — 실제 도로용 AR-HUD
   · TMAP으로 목적지를 찾고 자동차 경로(경로 선 + 회전 지점)를 받는다
   · 아이폰 GPS 위치를 경로 선에 붙여 '다음 회전 지점까지 남은 거리'를 구한다
   · 카메라 화면 위에 우리 HUD v1.3(hud.js)의 ① 지금 할 한 가지 ② 언제 ③ 어디로(미니 도로) ④ 속도를 그린다
   · 시뮬레이터와 달리 차로 수·주변 차 정보가 없어서 정체·뒤차·끼어들 틈 표시는 뺐다
   ============================================================ */

const $ = s => document.querySelector(s);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const C_NOW = '#46e6ff', C_GO = '#3ddc84', C_WARN = '#ffb020', C_DANGER = '#ff4d4d';
const API = 'https://apis.openapi.sk.com/tmap';

/* ---------- 안내 기준 ---------- */
const NEAR = 60;          // 회전 지점 이 거리(m) 안이면 실제 동작(좌회전·우회전…)을 보여준다
const PASS = 15;          // 회전 지점을 이만큼(m) 지나면 '완료'
const OFF_ROUTE = 40;     // 경로 선에서 이만큼(m) 벗어난 채 4초가 지나면 경로를 다시 받는다
const SIM_KMH = 40;       // 가상 주행 속도

/* ---------- 저장 (앱 키·마지막 목적지는 이 휴대폰에만 저장. GitHub에 올라가지 않는다) ---------- */
const store = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
};

/* ---------- 상태 ---------- */
const S = {
  key: '', dest: null, route: null,
  gps: null,          // 휴대폰 GPS 원본
  pos: null,          // 안내에 쓰는 위치 (가상 주행이면 가짜 위치)
  fix: null,          // 경로 선에 붙인 위치 {s: 출발점부터 경로 따라 m, off: 경로에서 벗어난 m, seg, t, v}
  sDisp: null,        // 화면용 s (GPS가 1초에 한 번이라 그 사이를 속도로 채움)
  offSince: 0, lastReroute: 0, rerouting: false,
  sim: false, simS: 0, simLast: 0,
  manIdx: -1, doneUntil: 0, fill: 0, running: false
};

/* ============================================================
   TMAP
   ============================================================ */
async function tmapError(r){
  let t = '';
  try{ const j = await r.json(); t = (j.error && (j.error.message || j.error.code)) || j.errorMessage || ''; }catch(e){}
  if(r.status === 401 || r.status === 403) return '앱 키를 확인해 주세요 (' + r.status + ')';
  return 'TMAP 오류 ' + r.status + (t ? ': ' + t : '');
}
function netError(e){
  return e instanceof TypeError ? 'TMAP에 연결하지 못했어요. 인터넷 연결을 확인해 주세요. 계속 안 되면 브라우저가 TMAP 호출을 막는 경우예요.' : e.message;
}

async function searchPlaces(word){
  const q = new URLSearchParams({version:'1', searchKeyword:word, count:'10', resCoordType:'WGS84GEO', reqCoordType:'WGS84GEO', searchType:'all'});
  if(S.gps){ q.set('centerLat', S.gps.lat); q.set('centerLon', S.gps.lon); }
  const r = await fetch(API + '/pois?' + q, {headers:{appKey:S.key, Accept:'application/json'}});
  if(r.status === 204) return [];
  if(!r.ok) throw new Error(await tmapError(r));
  const j = await r.json(), list = (j.searchPoiInfo && j.searchPoiInfo.pois && j.searchPoiInfo.pois.poi) || [];
  return list.map(p => {
    // 차로 들어가는 입구 좌표(front)가 있으면 그걸 쓴다
    const lat = Number(p.frontLat) || Number(p.noorLat), lon = Number(p.frontLon) || Number(p.noorLon);
    const addr = [p.upperAddrName, p.middleAddrName, p.lowerAddrName, p.roadName].filter(Boolean).join(' ');
    return {name:p.name, addr, lat, lon};
  }).filter(p => p.lat && p.lon);
}

async function requestRoute(from){
  const body = {startX:from.lon, startY:from.lat, endX:S.dest.lon, endY:S.dest.lat,
    reqCoordType:'WGS84GEO', resCoordType:'WGS84GEO', searchOption:'0', trafficInfo:'N', startName:'현재 위치', endName:S.dest.name};
  if(from.v > 2 && from.heading != null && !isNaN(from.heading)){ body.angle = Math.round(from.heading); body.speed = Math.round(from.v*3.6); }
  const r = await fetch(API + '/routes?version=1&format=json', {
    method:'POST', headers:{appKey:S.key, 'Content-Type':'application/json', Accept:'application/json'}, body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(await tmapError(r));
  return buildRoute(await r.json());
}

/* 회전 정보(turnType) → HUD가 쓰는 방향·각도·단어
   dir: -1 왼쪽 / 1 오른쪽, ang: 미니 도로에서 꺾이는 각도, lead: 준비를 시작하는 거리(m) */
function turnInfo(t){
  const T = (dir, ang, word, lead = 300) => ({dir, ang, word, lead});
  switch(t){
    case 12: return T(-1, 90, '좌회전');
    case 16: return T(-1, 135, '좌회전');       // 8시 방향
    case 17: return T(-1, 50, '좌회전');        // 10시 방향
    case 13: return T(1, 90, '우회전');
    case 18: return T(1, 50, '우회전');         // 2시 방향
    case 19: return T(1, 135, '우회전');        // 4시 방향
    case 14: return T(-1, 180, '유턴');
    case 6: case 43: case 117: return T(1, 30, '진입');     // Y자·오른쪽·오른쪽 방면
    case 7: case 44: case 118: return T(-1, 30, '진입');
    case 101: case 111: return T(1, 30, '진입', 500);     // 오른쪽 (도시)고속도로 입구
    case 102: case 112: return T(-1, 30, '진입', 500);
    case 104: case 114: return T(1, 30, '진출', 800);     // 오른쪽 (도시)고속도로 출구
    case 105: case 115: return T(-1, 30, '진출', 800);
    case 201: return {dir:0, ang:0, word:'도착', lead:300, arrive:true};
    default: return null;   // 직진·시설물·휴게소 등은 할 일이 아니라서 안내하지 않는다
  }
}

/* ---------- 좌표: 출발점 기준 미터 평면 (x 동쪽, y 북쪽) ---------- */
let ORI = null;
const toRad = d => d*Math.PI/180;
function setOrigin(lat, lon){ ORI = {lat, lon, kx:111320*Math.cos(toRad(lat)), ky:110540}; }
const toXY = (lat, lon) => [(lon - ORI.lon)*ORI.kx, (lat - ORI.lat)*ORI.ky];
const toLL = (x, y) => ({lat:ORI.lat + y/ORI.ky, lon:ORI.lon + x/ORI.kx});

// 점 q를 경로 선에 붙인다. a~b 구간만 찾음. firstClose면 앞에서부터 3m 안에 드는 첫 지점
function snap(pts, cum, q, a, b, firstClose){
  a = Math.max(0, a); b = Math.min(pts.length - 2, b);
  let best = {d:Infinity, seg:a, s:cum[a]};
  for(let i = a; i <= b; i++){
    const A = pts[i], B = pts[i+1], dx = B[0]-A[0], dy = B[1]-A[1], L2 = dx*dx + dy*dy || 1e-9;
    const t = clamp(((q[0]-A[0])*dx + (q[1]-A[1])*dy)/L2);
    const d = Math.hypot(q[0] - (A[0] + dx*t), q[1] - (A[1] + dy*t));
    if(d < best.d) best = {d, seg:i, s:cum[i] + Math.sqrt(L2)*t};
    if(firstClose && d < 3) return best;
  }
  return best;
}

function buildRoute(geo){
  const feats = (geo && geo.features) || [], ll = [], marks = [];
  feats.forEach(f => {
    const g = f.geometry; if(!g) return;
    if(g.type === 'LineString') g.coordinates.forEach(c => { const q = ll[ll.length-1]; if(!q || q[0] !== c[0] || q[1] !== c[1]) ll.push(c); });
    else if(g.type === 'Point') marks.push({c:g.coordinates, p:f.properties || {}});
  });
  if(ll.length < 2) throw new Error('경로를 받지 못했어요. 출발지와 목적지가 너무 가깝지 않은지 확인해 주세요.');
  setOrigin(ll[0][1], ll[0][0]);
  const pts = ll.map(c => toXY(c[1], c[0])), cum = [0];
  for(let i = 1; i < pts.length; i++) cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  const man = []; let from = 0;
  marks.forEach(({c, p}) => {
    const info = turnInfo(Number(p.turnType)); if(!info) return;
    const hit = snap(pts, cum, toXY(c[1], c[0]), from, pts.length - 2, true);
    from = hit.seg;
    man.push(Object.assign({s:hit.s, desc:p.description || '', type:Number(p.turnType)}, info));
  });
  if(!man.some(m => m.arrive)) man.push({dir:0, ang:0, word:'도착', lead:300, arrive:true, s:cum[cum.length-1], desc:'목적지', type:201});
  const p0 = (feats[0] && feats[0].properties) || {};
  return {pts, cum, len:cum[cum.length-1], man, time:Number(p0.totalTime) || 0};
}

/* ============================================================
   위치 → 경로 위 위치
   ============================================================ */
function onPosition(p){
  S.pos = p;
  const R = S.route; if(!R) return;
  const now = performance.now(), q = toXY(p.lat, p.lon);
  const lost = !S.fix || S.fix.off > OFF_ROUTE;
  const hit = lost ? snap(R.pts, R.cum, q, 0, R.pts.length - 2) : snap(R.pts, R.cum, q, S.fix.seg - 3, S.fix.seg + 80);
  S.fix = {s:hit.s, off:hit.d, seg:hit.seg, t:now, v:p.v || 0};
  if(!S.sim && hit.d > Math.max(OFF_ROUTE, (p.acc || 0)*1.5)){
    if(!S.offSince) S.offSince = now;
    if(now - S.offSince > 4000) reroute();
  } else S.offSince = 0;
}

async function reroute(){
  const now = performance.now();
  if(S.rerouting || now - S.lastReroute < 15000) return;
  S.rerouting = true; S.lastReroute = now;
  try{
    S.route = await requestRoute(S.pos);
    S.fix = null; S.sDisp = null; S.offSince = 0; S.manIdx = -1;
    onPosition(S.pos);
  }catch(e){ /* 실패하면 15초 뒤 다시 시도 */ }
  S.rerouting = false;
}

// 화면용 위치: 마지막 GPS 값 + 속도 × 지난 시간(최대 1.5초), 튀지 않게 부드럽게
function currentS(now){
  const f = S.fix; if(!f) return null;
  const pred = f.s + f.v*Math.min(1.5, (now - f.t)/1000);
  if(S.sDisp === null || Math.abs(pred - S.sDisp) > 60) S.sDisp = pred;
  else S.sDisp += (pred - S.sDisp)*0.15;
  return S.sDisp;
}

/* ---------- 가상 주행: 경로를 따라 40km/h로 움직이며 1초마다 GPS처럼 위치를 넣는다 ---------- */
function pointAtS(R, s){
  s = clamp(s, 0, R.len);
  let i = 1; while(i < R.cum.length - 1 && R.cum[i] < s) i++;
  const A = R.pts[i-1], B = R.pts[i], L = (R.cum[i] - R.cum[i-1]) || 1, t = (s - R.cum[i-1])/L;
  const h = (Math.atan2(B[0]-A[0], B[1]-A[1])*180/Math.PI + 360) % 360;
  return {xy:[A[0] + (B[0]-A[0])*t, A[1] + (B[1]-A[1])*t], heading:h};
}
function simStep(now){
  const dt = S.simLast ? (now - S.simLast)/1000 : 0;
  S.simS = Math.min(S.route.len, S.simS + SIM_KMH/3.6*dt);
  S.simLast = now;
  if(!S.simTick || now - S.simTick > 1000){
    S.simTick = now;
    const a = pointAtS(S.route, S.simS), ll = toLL(a.xy[0], a.xy[1]);
    onPosition({lat:ll.lat, lon:ll.lon, acc:5, v:S.simS < S.route.len ? SIM_KMH/3.6 : 0, heading:a.heading});
  }
}

/* ============================================================
   HUD 그리기 (hud.js drawAr와 같은 시각 언어)
   ============================================================ */
const HX = 260, HY_NEAR = 228, HY_FAR = 112, HALF = 112, K = 55, PXM = HALF/5.25, LANE = 3.5;
// 내 차 기준 평면: x 오른쪽, z 앞쪽이 음수(시뮬레이터와 같음)
function proj(x, z){
  const d = -z; if(d < 0 || d > 300) return null;
  const s = K/(d + K);
  return [HX + x*PXM*s, HY_FAR + (HY_NEAR - HY_FAR)*s, s, d];
}
const fmt = q => q[0].toFixed(1) + ' ' + q[1].toFixed(1);
function strip(L, R){ const a = [], b = []; L.forEach((q, i) => { if(q && R[i]){ a.push(q); b.push(R[i]); } }); return a.length > 1 ? 'M' + a.map(fmt).join('L') + 'L' + b.reverse().map(fmt).join('L') + 'Z' : ''; }

// 미니 도로 모양: 다음 회전 지점까지 곧게, 거기서 회전 방향으로 꺾는다
function roadPath(m, d){
  const P = [[0, -2]], turnAt = m && m.dir && d > 2 && d < 300 ? d : null, end = turnAt === null ? 300 : turnAt;
  for(let l = 6; l < end; l += 4) P.push([0, -l]);
  P.push([0, -end]);
  if(turnAt !== null){
    const th = m.ang*Math.PI/180, r = m.ang >= 90 ? 9 : 26, n = 18;
    let h = 0, x = 0, z = -end;
    for(let k = 0; k < n; k++){ const dh = m.dir*th/n, hm = h + dh/2; x += Math.sin(hm)*r*th/n; z -= Math.cos(hm)*r*th/n; h += dh; P.push([x, z]); }
    for(let l = 4; l <= 120; l += 4) P.push([x + Math.sin(h)*l, z - Math.cos(h)*l]);
  }
  return P;
}
function cumOf(P){ const c = [0]; for(let i = 1; i < P.length; i++) c.push(c[i-1] + Math.hypot(P[i][0]-P[i-1][0], P[i][1]-P[i-1][1])); return c; }
function at(P, C, L){
  if(L <= 0) return P[0];
  let i = 1; while(i < C.length - 1 && C[i] < L) i++;
  const t = clamp((L - C[i-1])/((C[i] - C[i-1]) || 1));
  return [P[i-1][0] + (P[i][0]-P[i-1][0])*t, P[i-1][1] + (P[i][1]-P[i-1][1])*t];
}
function sub(P, C, a, b, step = 4){ const o = []; for(let L = a; L < b; L += step) o.push(at(P, C, L)); o.push(at(P, C, b)); return o; }
function offsetLine(P, off){
  return P.map((p, i) => {
    const a = P[Math.max(0, i-1)], b = P[Math.min(P.length-1, i+1)];
    let tx = b[0]-a[0], tz = b[1]-a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    return [p[0] - tz*off, p[1] + tx*off];
  });
}
const band = (P, o0, o1) => strip(offsetLine(P, o0).map(q => proj(q[0], q[1])), offsetLine(P, o1).map(q => proj(q[0], q[1])));

const icons = ['icoRight', 'icoLeft', 'icoUp', 'icoUturn', 'icoCheck', 'icoPause'];
function showIcon(id, color){ icons.forEach(n => $('#'+n).style.display = n === id ? '' : 'none'); $('#nowIcon').setAttribute('stroke', color); $('#nowIcon').style.display = id ? '' : 'none'; }
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i+2), 16));
const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return '#' + A.map((v, i) => Math.round(v + (B[i]-v)*t).toString(16).padStart(2, '0')).join(''); };
const ease = t => 1 - Math.pow(1 - t, 3);
const timeColor = fr => fr >= .5 ? C_GO : fr >= .2 ? mix(C_WARN, C_GO, (fr-.2)/.3) : mix(C_DANGER, C_WARN, fr/.2);
const dirIcon = m => !m ? 'icoUp' : m.arrive ? 'icoCheck' : m.ang >= 180 ? 'icoUturn' : m.dir < 0 ? 'icoLeft' : 'icoRight';

/* ① 행동 상태: 빨강은 즉시, 나머지는 0.22초 이상 이어질 때만 바꿈 */
const AS = {key:'', cur:{icon:null, word:'', color:C_NOW}, since:0, pend:'', pendSince:0};
function commitAction(next, now){
  const key = (next.icon || '') + '|' + next.word + '|' + next.color;
  if(key === AS.key){ AS.pend = ''; return; }
  if(next.color === C_DANGER || !AS.key || (AS.pend === key && now - AS.pendSince > 220)){ AS.key = key; AS.cur = next; AS.since = now; AS.pend = ''; }
  else if(AS.pend !== key){ AS.pend = key; AS.pendSince = now; }
}

function drawHud(now, s){
  const R = S.route;
  let m = null, d = Infinity, next;

  if(!R || s === null) next = {icon:'icoPause', word:'위치 대기', color:C_WARN};
  else{
    const i = R.man.findIndex(x => x.s > s - PASS);
    if(i !== S.manIdx){ if(S.manIdx >= 0 && i > S.manIdx && !R.man[S.manIdx].arrive) S.doneUntil = now + 1400; S.manIdx = i; }
    m = i >= 0 ? R.man[i] : null;
    if(m) d = m.s - s;
    const late = m && d/m.lead <= .35;
    if(S.offSince && now - S.offSince > 1500) next = {icon:'icoPause', word:'경로 다시 찾는 중', color:C_WARN};
    else if(!m || (m.arrive && d < 30)) next = {icon:'icoCheck', word:'도착', color:C_GO};
    else if(now < S.doneUntil) next = {icon:'icoCheck', word:'완료', color:C_GO};          // 해냈다 = 늘 초록
    else if(m.arrive) next = {icon:'icoUp', word:'유지', color:C_NOW};
    else if(d <= NEAR) next = {icon:dirIcon(m), word:m.word, color:C_NOW};
    else if(d <= m.lead) next = {icon:m.dir < 0 ? 'icoLeft' : 'icoRight', word:late ? '지금 이동' : '이동', color:late ? C_WARN : C_GO};
    else next = {icon:'icoUp', word:'유지', color:C_NOW};
  }

  /* ① 지금 할 한 가지 */
  commitAction(next, now);
  const {icon, word, color} = AS.cur, act = $('#act'), nt = $('#nowText');
  showIcon(icon, color);
  act.style.display = icon ? '' : 'none';
  nt.textContent = word; nt.setAttribute('fill', color);
  $('#nowRing').setAttribute('stroke', color); $('#nowRing').setAttribute('stroke-opacity', .45);
  const tw = word ? nt.getComputedTextLength() : 0, total = 44 + (word ? 12 + tw : 0), e = ease(clamp((now - AS.since)/200));
  act.setAttribute('transform', `translate(${HX} 34) scale(${(.88 + .12*e).toFixed(3)}) translate(${(-total/2 + 22).toFixed(1)} 0)`);
  act.setAttribute('opacity', e.toFixed(3));
  // '이동' 화살표는 방향지시등처럼 깜빡인다
  const signal = (icon === 'icoLeft' || icon === 'icoRight') && color === C_GO;
  $('#nowIcon').setAttribute('opacity', signal && (now % 700) > 460 ? .3 : 1);
  const halo = $('#nowHalo'), urgent = color === C_WARN && word === '지금 이동';
  halo.classList.toggle('on', urgent); halo.setAttribute('stroke', color);
  if(!urgent) halo.setAttribute('opacity', '0');

  /* ② 언제: 준비 구간에서 회전 지점까지 줄어드는 막대 + 미니 도로의 마감선 */
  const showTiming = m && !m.arrive && d > 0 && d <= m.lead, frac = m ? clamp(d/m.lead) : 1, tcol = timeColor(frac);
  $('#cd').style.display = showTiming ? '' : 'none';
  if(showTiming){ const bar = $('#cdBar'); bar.setAttribute('width', (120*frac).toFixed(1)); bar.setAttribute('x', (260 - 60*frac).toFixed(1)); bar.setAttribute('fill', tcol); $('#cdBg').setAttribute('fill', tcol); }

  /* ③ 어디로: 미니 도로 */
  const P = roadPath(m, d), C = cumOf(P), Lend = C[C.length-1];
  $('#roadSurf').setAttribute('d', band(P, -5.25, 5.25));
  $('#roadEdges').setAttribute('d', band(P, -5.34, -5.16) + band(P, 5.16, 5.34));
  // 점선: 실제 이동 거리에 맞춰 흐른다 (3m 칠 · 6m 빈칸)
  let dash = ''; const ph = s === null ? 0 : (s % 9);
  for(let L = 9 - ph; L < Lend - 3; L += 9){ const seg = sub(P, C, L, L + 3, 3); dash += band(seg, -1.825, -1.675) + band(seg, 1.675, 1.825); }
  $('#roadDash').setAttribute('d', dash);
  // 내 차로 빛: 준비 구간이면 밝게
  const fillTarget = !m ? 0 : d <= m.lead ? 1 : .6;
  S.fill += (fillTarget - S.fill)*.08;
  $('#laneFill').setAttribute('d', band(P, -1.75, 1.75)); $('#laneFill').setAttribute('opacity', S.fill.toFixed(3));
  $('#laneRails').setAttribute('d', band(P, -1.82, -1.68) + band(P, 1.68, 1.82)); $('#laneRails').setAttribute('opacity', (.85*S.fill).toFixed(3));
  // 흐르는 빛 띠
  let pul = '';
  if(showTiming && S.fill > .3) for(let i = 0; i < 3; i++){ const L = 7 + ((now/1000*15 + i*20) % 60); if(L < Lend - 2) pul += band(sub(P, C, L, L + 1.1, 1.1), -1.55, 1.55); }
  $('#pulses').setAttribute('d', pul); $('#pulses').setAttribute('fill-opacity', (.5*S.fill).toFixed(3));
  // 마감선 = 회전 지점
  $('#gate').setAttribute('d', showTiming ? band(sub(P, C, d - .35, d + .35, .7), -1.75, 1.75) : ''); $('#gate').setAttribute('fill', tcol);
  // 옮길 화살표: '이동'일 때 회전 쪽 차로로
  const ma = $('#moveArrow'), mh = $('#moveHead'), moving = word === '이동' || word === '지금 이동';
  const a0 = moving ? proj(0, -7) : null, a1 = moving ? proj(0, -19) : null, a2 = moving ? proj((m.dir || 1)*LANE, -31) : null;
  if(a0 && a1 && a2){
    ma.setAttribute('d', `M${fmt(a0)}Q${fmt(a1)} ${fmt(a2)}`);
    const ag = $('#arrowGrad'); ag.setAttribute('x1', a0[0]); ag.setAttribute('y1', a0[1]); ag.setAttribute('x2', a2[0]); ag.setAttribute('y2', a2[1]);
    $('#agA').setAttribute('stop-color', color); $('#agB').setAttribute('stop-color', color);
    ma.setAttribute('stroke-dasharray', '12 7'); ma.classList.add('flow');
    let dx = a2[0]-a1[0], dy = a2[1]-a1[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const nx = -dy, ny = dx;
    mh.setAttribute('d', `M${(a2[0]+dx*7).toFixed(1)} ${(a2[1]+dy*7).toFixed(1)}L${(a2[0]-dx*6+nx*8).toFixed(1)} ${(a2[1]-dy*6+ny*8).toFixed(1)}L${(a2[0]-dx*6-nx*8).toFixed(1)} ${(a2[1]-dy*6-ny*8).toFixed(1)}Z`);
    mh.setAttribute('fill', color);
  } else { ma.setAttribute('d', ''); mh.setAttribute('d', ''); ma.classList.remove('flow'); }

  /* ④ 속도 */
  $('#spdA').textContent = S.pos && S.pos.v ? Math.round(S.pos.v*3.6) : 0;
  return {m, d};
}

/* ---------- 정보 패널 (시연·확인용) ---------- */
let panelT = 0;
const km = m => m >= 1000 ? (m/1000).toFixed(1) + 'km' : Math.max(0, Math.round(m)) + 'm';
function drawPanel(now, s, st){
  if($('#panel').hidden || now - panelT < 250) return;
  panelT = now;
  const R = S.route;
  $('#pNext').textContent = st.m ? `${km(st.d)} 앞 ${st.m.arrive ? '목적지 도착' : st.m.desc || st.m.word}` : '경로를 기다리는 중';
  const parts = [];
  if(R && s !== null) parts.push('남은 거리 ' + km(R.len - s));
  if(S.fix) parts.push('경로와 차이 ' + Math.round(S.fix.off) + 'm');
  if(S.sim) parts.push('가상 주행');
  else if(S.gps) parts.push('GPS 오차 ' + Math.round(S.gps.acc) + 'm');
  $('#pMeta').textContent = parts.join(' · ');
}

function frame(now){
  if(!S.running) return;
  requestAnimationFrame(frame);
  if(S.sim && S.route) simStep(now);
  const s = S.route ? currentS(now) : null, st = drawHud(now, s);
  drawPanel(now, s, st);
}

/* ============================================================
   장치: 카메라 · GPS · 화면 꺼짐 방지
   ============================================================ */
async function startCamera(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('이 브라우저는 카메라를 쓸 수 없어요. https 주소인지 확인해 주세요.');
  const cam = $('#cam');
  if(cam.srcObject) return;
  cam.srcObject = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080}}, audio:false});
  await cam.play();
}
let gpsWatch = null;
function startGPS(){
  if(gpsWatch !== null || !navigator.geolocation) return;
  gpsWatch = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    S.gps = {lat:c.latitude, lon:c.longitude, acc:c.accuracy, v:c.speed != null && c.speed >= 0 ? c.speed : 0, heading:c.heading};
    if(!S.sim) onPosition(S.gps);
  }, err => { if(!S.running) say('위치를 받을 수 없어요: ' + err.message, true); },
  {enableHighAccuracy:true, maximumAge:0, timeout:15000});
}
function waitGPS(ms){
  return new Promise((ok, no) => {
    const t0 = Date.now(), iv = setInterval(() => {
      if(S.gps){ clearInterval(iv); ok(S.gps); }
      else if(Date.now() - t0 > ms){ clearInterval(iv); no(new Error('위치를 잡지 못했어요. 위치 권한을 허용했는지, 하늘이 보이는 곳인지 확인해 주세요.')); }
    }, 200);
  });
}
let wake = null;
async function keepAwake(){ try{ if(navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); }catch(e){} }
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && S.running) keepAwake(); });

/* ============================================================
   시작 화면
   ============================================================ */
function say(t, bad){ const m = $('#msg'); m.textContent = t; m.classList.toggle('bad', !!bad); }
function setDest(p){
  S.dest = p; store.set('dest', JSON.stringify(p));
  $('#chosen').hidden = false; $('#chosen').textContent = '목적지: ' + p.name;
  $('#goBtn').disabled = $('#simBtn').disabled = false;
}

$('#keyInput').value = store.get('tmapKey') || '';
try{ const d = JSON.parse(store.get('dest') || 'null'); if(d && d.lat) setDest(d); }catch(e){}

function readKey(){
  S.key = $('#keyInput').value.trim();
  if(!S.key){ say('TMAP 앱 키를 넣어 주세요.', true); $('#keyInput').focus(); return false; }
  store.set('tmapKey', S.key); return true;
}

async function doSearch(){
  if(!readKey()) return;
  const w = $('#destInput').value.trim();
  if(!w){ say('목적지 이름을 넣어 주세요.', true); return; }
  startGPS();   // 가까운 곳이 먼저 나오도록 위치도 같이 켠다
  say('찾는 중…');
  try{
    const list = await searchPlaces(w), ul = $('#results');
    ul.innerHTML = '';
    if(!list.length){ say('검색 결과가 없어요. 다른 이름으로 찾아보세요.'); return; }
    list.forEach(p => {
      const li = document.createElement('li'), b = document.createElement('button'), n = document.createElement('b'), a = document.createElement('span');
      n.textContent = p.name; a.textContent = p.addr; b.append(n, a);
      b.addEventListener('click', () => { setDest(p); ul.innerHTML = ''; say(''); });
      li.appendChild(b); ul.appendChild(li);
    });
    say('');
  }catch(e){ say(netError(e), true); }
}
$('#searchBtn').addEventListener('click', doSearch);
$('#destInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); doSearch(); } });

async function begin(sim){
  if(!readKey() || !S.dest) return;
  $('#goBtn').disabled = $('#simBtn').disabled = true;
  try{
    say('카메라를 켜는 중…');
    try{ await startCamera(); }catch(e){ throw new Error('카메라를 켜지 못했어요: ' + e.message); }
    say('위치를 잡는 중…');
    startGPS();
    const from = await waitGPS(20000);
    say('경로를 받는 중…');
    S.route = await requestRoute(from);
    S.sim = sim; S.simS = 0; S.simLast = 0; S.simTick = 0;
    S.fix = null; S.sDisp = null; S.manIdx = -1; S.doneUntil = 0; S.offSince = 0; S.lastReroute = performance.now();
    if(!sim) onPosition(S.gps);
    $('#start').hidden = true; $('#hudWrap').hidden = false; $('#panel').hidden = false;
    keepAwake();
    S.running = true; requestAnimationFrame(frame);
  }catch(e){
    say(netError(e), true);
  }
  $('#goBtn').disabled = $('#simBtn').disabled = false;
}
$('#goBtn').addEventListener('click', () => begin(false));
$('#simBtn').addEventListener('click', () => begin(true));

/* 주행 중: 화면을 누르면 정보 패널 숨김/보임 (녹화할 때 숨기기) */
document.addEventListener('click', e => {
  if(!S.running || e.target.closest('#panel')) return;
  $('#panel').hidden = !$('#panel').hidden;
});
$('#hideBtn').addEventListener('click', () => { $('#panel').hidden = true; });
$('#changeBtn').addEventListener('click', () => {
  S.running = false; S.route = null; S.sim = false;
  $('#hudWrap').hidden = true; $('#panel').hidden = true; $('#start').hidden = false;
  if(wake){ try{ wake.release(); }catch(e){} wake = null; }
});
