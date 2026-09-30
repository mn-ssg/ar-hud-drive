/* ============================================================
   hud.js — 카메라 화면 위 HUD (시뮬레이터 hud.js drawAr와 같은 시각 언어)
   ① 지금 할 한 가지 ② 언제 ③ 어디로(미니 도로, 차선 수 반영) ④ 속도 · 제한속도
   · 시뮬레이터와 달리 주변 차 정보가 없어서 정체·뒤차·끼어들 틈 표시는 뺐다
   · 성능: 요소는 처음 한 번만 찾고, 값이 바뀐 속성만 다시 쓴다
   ============================================================ */
import {NEAR, PASS, LANE_W as W, DEFAULT_LANES, C} from './config.js';
import {clamp, ease} from './util.js';

/* ---------- 미니 도로 투영: 내 차 기준 평면 (x 오른쪽, z 앞쪽이 음수 — 시뮬레이터와 같음) ---------- */
const HX = 260, HY_NEAR = 228, HY_FAR = 112, K = 55, PXM = 112/5.25;
const ROAD_FIT = 7;   // 한쪽 도로 폭이 이 값(m)을 넘으면 HUD 안에 들어오도록 가로로 줄인다
let kx = 1;           // 그 가로 배율
function proj(x, z){
  const d = -z; if(d < 0 || d > 300) return null;
  const s = K/(d + K);
  return [HX + x*PXM*kx*s, HY_FAR + (HY_NEAR - HY_FAR)*s];
}
const fmt = q => q[0].toFixed(1) + ' ' + q[1].toFixed(1);

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
function at(P, Cm, L){
  if(L <= 0) return P[0];
  let i = 1; while(i < Cm.length - 1 && Cm[i] < L) i++;
  const t = clamp((L - Cm[i-1])/((Cm[i] - Cm[i-1]) || 1));
  return [P[i-1][0] + (P[i][0]-P[i-1][0])*t, P[i-1][1] + (P[i][1]-P[i-1][1])*t];
}
// 선의 각 점에서 왼쪽→오른쪽 단위 법선 (띠를 여러 개 그려도 한 번만 계산)
function normals(P){
  return P.map((p, i) => {
    const a = P[Math.max(0, i-1)], b = P[Math.min(P.length-1, i+1)];
    const tx = b[0]-a[0], tz = b[1]-a[1], l = Math.hypot(tx, tz) || 1;
    return [-tz/l, tx/l];
  });
}
// 선 P를 따라 가로 o0~o1(m) 사이 띠
function band(P, Nn, o0, o1){
  const a = [], b = [];
  for(let i = 0; i < P.length; i++){
    const p = P[i], n = Nn[i], A = proj(p[0] + n[0]*o0, p[1] + n[1]*o0), B = proj(p[0] + n[0]*o1, p[1] + n[1]*o1);
    if(A && B){ a.push(fmt(A)); b.push(fmt(B)); }
  }
  return a.length > 1 ? 'M' + a.join('L') + 'L' + b.reverse().join('L') + 'Z' : '';
}
// 선 위 a~b(m) 짧은 조각 (점선·빛 띠·마감선용)
function piece(P, Cm, a, b){ const S = [at(P, Cm, a), at(P, Cm, b)]; return [S, normals(S)]; }

// 차선 수 n → 내 차로 왼쪽·오른쪽 차로 수. 몇 번째 차로인지는 알 수 없어서 가운데(짝수면 가운데 오른쪽)에 둔다
const laneSplit = n => { const L = Math.floor(n/2); return [L, n - L - 1]; };

/* ---------- 색 · 아이콘 ---------- */
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i+2), 16));
const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return '#' + A.map((v, i) => Math.round(v + (B[i]-v)*t).toString(16).padStart(2, '0')).join(''); };
const timeColor = fr => fr >= .5 ? C.GO : fr >= .2 ? mix(C.WARN, C.GO, (fr-.2)/.3) : mix(C.DANGER, C.WARN, fr/.2);
const dirIcon = m => !m ? 'icoUp' : m.arrive ? 'icoCheck' : m.ang >= 180 ? 'icoUturn' : m.dir < 0 ? 'icoLeft' : 'icoRight';
const ICONS = ['icoRight', 'icoLeft', 'icoUp', 'icoUturn', 'icoCheck', 'icoPause'];

/* ---------- 요소 · 바뀐 값만 쓰기 ---------- */
const E = {};
const IDS = ['act', 'nowText', 'nowIcon', 'nowRing', 'nowHalo', 'cd', 'cdBar', 'cdBg', 'roadSurf', 'roadEdges', 'roadDash', 'laneFill', 'laneRails',
  'pulses', 'gate', 'moveArrow', 'moveHead', 'arrowGrad', 'agA', 'agB', 'spdGrp', 'spdA', 'limGrp', 'limT', ...ICONS];
const written = new WeakMap();
function attr(el, k, v){
  let c = written.get(el); if(!c) written.set(el, c = {});
  v = String(v);
  if(c[k] !== v){ c[k] = v; el.setAttribute(k, v); }
}
const show = (el, on) => attr(el, 'display', on ? 'inline' : 'none');
const text = (el, v) => { v = String(v); if(el.textContent !== v) el.textContent = v; };

// 글자 폭은 단어마다 한 번만 잰다 (재면 화면 배치를 다시 계산해서 느림). 글꼴이 늦게 오면 다시 잰다
const widths = new Map();
function textWidth(el, word){
  let w = widths.get(word);
  if(w === undefined){ w = word ? el.getComputedTextLength() : 0; if(w > 0 || !word) widths.set(word, w); }
  return w;
}

/* ---------- 상태 ---------- */
const H = {};
export function initHud(){
  IDS.forEach(id => { E[id] = document.getElementById(id); });
  if(document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => widths.clear());
  resetHud();
}
export function resetHud(){
  const [L, R] = laneSplit(DEFAULT_LANES);
  Object.assign(H, {route:null, manIdx:-1, doneUntil:0, fill:0, Ls:L, Rs:R, t:0,
    act:{key:'', cur:{icon:null, word:'', color:C.NOW}, since:0, pend:'', pendSince:0}});
}

/* ① 행동 상태: 빨강은 즉시, 나머지는 0.22초 이상 이어질 때만 바꿈 */
function commitAction(next, now){
  const A = H.act, key = (next.icon || '') + '|' + next.word + '|' + next.color;
  if(key === A.key){ A.pend = ''; return; }
  if(next.color === C.DANGER || !A.key || (A.pend === key && now - A.pendSince > 220)){ A.key = key; A.cur = next; A.since = now; A.pend = ''; }
  else if(A.pend !== key){ A.pend = key; A.pendSince = now; }
}

/* v = {route, s, offSince, kmh, limit, lanes} → {m: 다음 안내 지점, d: 남은 거리} */
export function drawHud(now, v){
  const R = v.route, s = v.s, dt = H.t ? Math.min(.25, (now - H.t)/1000) : 0;
  H.t = now;
  if(R !== H.route){ H.route = R; H.manIdx = -1; }   // 경로를 다시 받으면 안내 순서도 처음부터
  let m = null, d = Infinity, next;

  if(!R || s === null) next = {icon:'icoPause', word:'위치 대기', color:C.WARN};
  else{
    const i = R.man.findIndex(x => x.s > s - PASS);
    if(i !== H.manIdx){ if(H.manIdx >= 0 && i > H.manIdx && !R.man[H.manIdx].arrive) H.doneUntil = now + 1400; H.manIdx = i; }
    m = i >= 0 ? R.man[i] : null;
    if(m) d = m.s - s;
    const late = m && d/m.lead <= .35;
    if(v.offSince && now - v.offSince > 1500) next = {icon:'icoPause', word:'경로 다시 찾는 중', color:C.WARN};
    else if(!m || (m.arrive && d < 30)) next = {icon:'icoCheck', word:'도착', color:C.GO};
    else if(now < H.doneUntil) next = {icon:'icoCheck', word:'완료', color:C.GO};          // 해냈다 = 늘 초록
    else if(m.arrive) next = {icon:'icoUp', word:'유지', color:C.NOW};
    else if(d <= NEAR) next = {icon:dirIcon(m), word:m.word, color:C.NOW};
    else if(d <= m.lead) next = {icon:m.dir < 0 ? 'icoLeft' : 'icoRight', word:late ? '지금 이동' : '이동', color:late ? C.WARN : C.GO};
    else next = {icon:'icoUp', word:'유지', color:C.NOW};
  }

  /* ① 지금 할 한 가지 */
  commitAction(next, now);
  const {icon, word, color} = H.act.cur;
  ICONS.forEach(n => show(E[n], n === icon));
  show(E.nowIcon, !!icon); attr(E.nowIcon, 'stroke', color);
  show(E.act, !!icon);
  text(E.nowText, word); attr(E.nowText, 'fill', color);
  attr(E.nowRing, 'stroke', color); attr(E.nowRing, 'stroke-opacity', .45);
  const tw = textWidth(E.nowText, word), total = 44 + (word ? 12 + tw : 0), e = ease(clamp((now - H.act.since)/200));
  attr(E.act, 'transform', `translate(${HX} 34) scale(${(.88 + .12*e).toFixed(3)}) translate(${(-total/2 + 22).toFixed(1)} 0)`);
  attr(E.act, 'opacity', e.toFixed(3));
  // '이동' 화살표는 방향지시등처럼 깜빡인다
  const signal = (icon === 'icoLeft' || icon === 'icoRight') && color === C.GO;
  attr(E.nowIcon, 'opacity', signal && (now % 700) > 460 ? .3 : 1);
  const urgent = color === C.WARN && word === '지금 이동';
  E.nowHalo.classList.toggle('on', urgent); attr(E.nowHalo, 'stroke', color);
  if(!urgent) attr(E.nowHalo, 'opacity', 0);

  /* ② 언제: 준비 구간에서 회전 지점까지 줄어드는 막대 + 미니 도로의 마감선 */
  const showTiming = m && !m.arrive && d > 0 && d <= m.lead, frac = m ? clamp(d/m.lead) : 1, tcol = timeColor(frac);
  show(E.cd, showTiming);
  if(showTiming){ attr(E.cdBar, 'width', (120*frac).toFixed(1)); attr(E.cdBar, 'x', (260 - 60*frac).toFixed(1)); attr(E.cdBar, 'fill', tcol); attr(E.cdBg, 'fill', tcol); }

  /* ③ 어디로: 미니 도로 — 차선 수가 바뀌면 폭이 부드럽게 바뀐다 */
  const [tL, tR] = laneSplit(v.lanes || DEFAULT_LANES), a = 1 - Math.exp(-dt/.35);
  H.Ls += (tL - H.Ls)*a; H.Rs += (tR - H.Rs)*a;
  if(Math.abs(tL - H.Ls) < .01) H.Ls = tL;
  if(Math.abs(tR - H.Rs) < .01) H.Rs = tR;
  const xl = -(W/2 + H.Ls*W), xr = W/2 + H.Rs*W;
  kx = Math.min(1, ROAD_FIT/Math.max(-xl, xr));

  const P = roadPath(m, d), Cm = cumOf(P), Nn = normals(P), Lend = Cm[Cm.length-1];
  attr(E.roadSurf, 'd', band(P, Nn, xl, xr));
  attr(E.roadEdges, 'd', band(P, Nn, xl - .09, xl + .09) + band(P, Nn, xr - .09, xr + .09));
  // 차로 사이 점선: 실제 이동 거리에 맞춰 흐른다 (3m 칠 · 6m 빈칸)
  const bounds = [];
  for(let j = 0; j < H.Ls - .1; j++) bounds.push(-(W/2 + j*W));
  for(let j = 0; j < H.Rs - .1; j++) bounds.push(W/2 + j*W);
  let dash = ''; const ph = s === null ? 0 : (s % 9);
  for(let L = 9 - ph; L < Lend - 3; L += 9){ const [S2, N2] = piece(P, Cm, L, L + 3); for(const x of bounds) dash += band(S2, N2, x - .075, x + .075); }
  attr(E.roadDash, 'd', dash);
  // 내 차로 빛: 준비 구간이면 밝게
  const fillTarget = !m ? 0 : d <= m.lead ? 1 : .6;
  H.fill += (fillTarget - H.fill)*(1 - Math.exp(-dt/.2));
  attr(E.laneFill, 'd', band(P, Nn, -W/2, W/2)); attr(E.laneFill, 'opacity', H.fill.toFixed(3));
  attr(E.laneRails, 'd', band(P, Nn, -W/2 - .07, -W/2 + .07) + band(P, Nn, W/2 - .07, W/2 + .07)); attr(E.laneRails, 'opacity', (.85*H.fill).toFixed(3));
  // 흐르는 빛 띠
  let pul = '';
  if(showTiming && H.fill > .3) for(let i = 0; i < 3; i++){ const L = 7 + ((now/1000*15 + i*20) % 60); if(L < Lend - 2){ const [S2, N2] = piece(P, Cm, L, L + 1.1); pul += band(S2, N2, -1.55, 1.55); } }
  attr(E.pulses, 'd', pul); attr(E.pulses, 'fill-opacity', (.5*H.fill).toFixed(3));
  // 마감선 = 회전 지점
  if(showTiming){ const [S2, N2] = piece(P, Cm, d - .35, d + .35); attr(E.gate, 'd', band(S2, N2, -W/2, W/2)); }
  else attr(E.gate, 'd', '');
  attr(E.gate, 'fill', tcol);
  // 옮길 화살표: '이동'일 때 회전 쪽 차로로
  const moving = word === '이동' || word === '지금 이동';
  const a0 = moving ? proj(0, -7) : null, a1 = moving ? proj(0, -19) : null, a2 = moving && m ? proj((m.dir || 1)*W, -31) : null;
  if(a0 && a1 && a2){
    attr(E.moveArrow, 'd', `M${fmt(a0)}Q${fmt(a1)} ${fmt(a2)}`);
    attr(E.arrowGrad, 'x1', a0[0]); attr(E.arrowGrad, 'y1', a0[1]); attr(E.arrowGrad, 'x2', a2[0]); attr(E.arrowGrad, 'y2', a2[1]);
    attr(E.agA, 'stop-color', color); attr(E.agB, 'stop-color', color);
    attr(E.moveArrow, 'stroke-dasharray', '12 7'); E.moveArrow.classList.add('flow');
    let dx = a2[0]-a1[0], dy = a2[1]-a1[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const nx = -dy, ny = dx;
    attr(E.moveHead, 'd', `M${(a2[0]+dx*7).toFixed(1)} ${(a2[1]+dy*7).toFixed(1)}L${(a2[0]-dx*6+nx*8).toFixed(1)} ${(a2[1]-dy*6+ny*8).toFixed(1)}L${(a2[0]-dx*6-nx*8).toFixed(1)} ${(a2[1]-dy*6-ny*8).toFixed(1)}Z`);
    attr(E.moveHead, 'fill', color);
  } else { attr(E.moveArrow, 'd', ''); attr(E.moveHead, 'd', ''); E.moveArrow.classList.remove('flow'); }

  /* ④ 속도 · 제한속도: 넘으면 속도 숫자를 경고색으로 */
  const kmh = Math.round(v.kmh || 0), over = v.limit && kmh > v.limit;
  text(E.spdA, kmh); attr(E.spdA, 'fill', over ? C.WARN : '#ffffff');
  attr(E.spdGrp, 'opacity', over ? 1 : .85);
  show(E.limGrp, !!v.limit);
  if(v.limit) text(E.limT, v.limit);

  return {m, d};
}
