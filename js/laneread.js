/* ============================================================
   laneread.js — 차선(선) 목록(CLRerNet) → 내 차로 읽기 · 추적  (화면·카메라와 무관한 순수 계산, Node로 시험)
   · 한 장: 보닛 바로 위 줄에서 선마다 x · 종류(노란 중앙선 / 흰 실선 / 흰 점선)
            → 내 차로 양쪽 선 · 차로 안 위치 · '왼쪽 끝에서 몇 번째' · '오른쪽 끝에서 몇 번째' 근거
   · 근거: 노란 중앙선(강함) · 내 차로 선이 점선이면 그쪽에 차로가 더 있음 · 실선 바깥에 차로 폭만큼 선이 없으면 끝 차로
           (고속도로는 끝 차로 바깥에 갓길 끝 선이 하나 더 보여서 '차로 폭보다 가까운 선'은 갓길로 봄)
           양쪽 다 흰 실선이면(터널 · 차로 변경 금지 구간) 끝인지 알 수 없어 근거로 안 씀
   · 여러 장: 같은 선이 내 차 밑을 지나가면 차로 변경(±1) → 모은 근거도 한 칸 옮긴다. 선이 가려져도(앞차 · 정차) 마지막 값 유지
   (10-01 TwinLiteNet 분할 마스크 → 줄마다 조각 세기 방식은 10-02 이 방식으로 바꿈, D45)
   ============================================================ */

// 노란 중앙선: 색상 25~65°, 채도 0.25↑, 밝기 0.35↑ (햇빛에 바랜 노랑도. 흰 선은 채도가 낮아 걸러짐)
function isYellow(r, g, b){
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx/255, sat = mx ? (mx - mn)/mx : 0;
  if(v < .35 || sat < .25 || (mx !== r && mx !== g)) return false;
  const h = mx === r ? 60*((g - b)/(mx - mn || 1)) : 60*(2 + (b - r)/(mx - mn || 1));
  return h >= 25 && h <= 65;
}

/* 픽셀(W×H, ch = 3 RGB 또는 4 RGBA) → probe(x, y: 0~1, r: 화면 폭 대비 선 반폭)
   → {paint: 양옆 아스팔트보다 둘 다 확 밝은 띠(칠한 선), yellow} 또는 null(화면 밖)
   가드레일 · 연석 · 벽 밑은 한쪽만 밝은 '경계'라서 paint가 아님 → 고속도로 갓길 끝을 차선으로 세지 않게 */
export function paintSampler(px, W, H, ch = 4){
  const lum = (x, y) => { const p = (y*W + x)*ch; return .299*px[p] + .587*px[p+1] + .114*px[p+2]; };
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return (xn, yn, rn) => {
    const R = Math.max(1, Math.round(rn*W)), x0 = Math.round(xn*W), y = Math.round(yn*H);
    if(y < 0 || y >= H || x0 - 5*R < 0 || x0 + 5*R >= W) return null;
    let top = 0, yel = 0;
    for(let x = x0 - R; x <= x0 + R; x++){ top = Math.max(top, lum(x, y)); const p = (y*W + x)*ch; if(isYellow(px[p], px[p+1], px[p+2])) yel++; }
    const a = [], b = []; for(let k = 3*R; k <= 5*R; k++){ a.push(lum(x0 - k, y)); b.push(lum(x0 + k, y)); }
    return {paint:top - Math.max(med(a), med(b)) > 25 && top > 90, yellow:yel >= 2};
  };
}

// 선 위의 y(0~1)에서 x. 선 끝보다 아래면 맨 아래 두 점으로 늘려서
function xAt(pts, y){
  for(let i = 1; i < pts.length; i++){
    const [xa, ya] = pts[i-1], [xb, yb] = pts[i];
    if((ya - y)*(yb - y) <= 0 && ya !== yb) return xa + (xb - xa)*(y - ya)/(yb - ya);
  }
  const [xa, ya] = pts[0], [xb, yb] = pts[1];
  return ya === yb ? xa : xa + (xb - xa)*(y - ya)/(yb - ya);
}

/* 선 종류: 아래쪽(가까운) 구간을 따라 칠이 있는 비율 · 끊긴 횟수 → 'yellow' | 'solid' | 'dashed' | 'edge'(칠 없는 경계) | null(모름)
   반폭은 가까울수록 넓게 (보닛 바로 위 화면 폭의 0.6% → 소실점 쪽으로 줄어듦) */
function lineKind(pts, probe, yRef, vp){
  const P = pts.filter(([, y]) => y <= yRef + .01 && y >= vp + (yRef - vp)*.35);
  if(P.length < 6) return null;
  let n = 0, paint = 0, yel = 0, flips = 0, prev = null;
  for(const [x, y] of P){
    const s = probe(x, y, .006*Math.max(.25, (y - vp)/(yRef - vp)));
    if(!s) continue;
    n++; if(s.paint) paint++; if(s.yellow) yel++;
    if(prev !== null && prev !== s.paint) flips++;
    prev = s.paint;
  }
  if(n < 6) return null;
  if(yel/n >= .3) return 'yellow';
  const f = paint/n;
  if(f >= .8) return 'solid';
  if(f >= .15 && f <= .7 && flips >= 2) return 'dashed';
  if(f < .1) return 'edge';   // 칠이 거의 없음 = 연석 · 가드레일 · 벽 밑 같은 도로 경계
  return null;
}

/* lanes: [{pts:[[x, y]…] 화면 기준 0~1 · 아래→위, score}]
   o = {cx: 화면에서 내 차 가운데 x, yRef: 선 위치를 재는 줄(보닛 바로 위), vp: 소실점 높이, probe: paintSampler 결과(없으면 종류 안 봄), laneW: 평소 차로 폭(yRef에서, 모르면 null)}
   → {n, lines:[{x, kind, score}] 왼→오, li: 내 차로 왼쪽 선 번호(-1 = 없음), L, R, pos(0 왼쪽 선 ~ 1 오른쪽 선), width, mid, fromL, fromR}
   fromL/fromR = [끝에서 몇 번째 차로(1~), 무게] 또는 null — 이 한 장의 근거 */
export function readLines(lanes, {cx = .5, yRef = .9, vp = .55, probe = null, laneW = null} = {}){
  const lines = lanes.filter(l => l.pts.length >= 2)
    .map(l => ({x:xAt(l.pts, yRef), kind:probe ? lineKind(l.pts, probe, yRef, vp) : null, score:l.score}))
    .sort((a, b) => a.x - b.x);
  const li = lines.findLastIndex(s => s.x < cx), L = li >= 0 ? lines[li] : null, R = lines[li + 1] || null;
  const width = L && R ? R.x - L.x : null, w = width || laneW;
  const r = {n:lines.length, lines, li, L, R, cx, width, pos:width ? (cx - L.x)/width : null, mid:width ? (L.x + R.x)/2 : null, fromL:null, fromR:null};
  if(!w) return r;
  // 한쪽 끝까지: 내 차로 선부터 바깥으로 k번째 선을 본다 (가까운 것부터, 최대 3개)
  //   노란선 → 왼쪽이면 그 안쪽이 끝 차로(강함) / 점선 → 너머에 차로가 더 있음 / 칠 없는 경계 → 그 안쪽이 끝 차로
  //   흰 실선 → 바깥 차로 폭 70% 너머에 칠한 선이 또 있으면 차로 변경 금지 실선이라 계속, 아니면(갓길 · 경계뿐) 끝 차로
  const W8 = [.5, .3, .2];
  const side = (sgn) => {
    const seq = sgn < 0 ? lines.slice(0, li + 1).reverse() : lines.slice(li + 1);
    for(let k = 0; k < seq.length && k < 3; k++){
      const s = seq[k], next = seq[k + 1];
      if(s.kind === 'yellow') return sgn < 0 ? [k + 1, 1] : [k + 1, W8[k]];   // 왼쪽 = 중앙선(강함) · 오른쪽 = 주정차 금지 연석선(길 끝)
      if(s.kind === 'dashed') continue;
      if(s.kind === 'edge') return [k + 1, k ? W8[k] : .3];         // 점선 너머 경계 = 그 사이가 끝 차로. 내 차로 선이 곧 경계면(칠 없는 길) 약하게
      if(s.kind !== 'solid') return null;
      const paintNext = next && next.kind && next.kind !== 'edge' && Math.abs(next.x - s.x) > .7*w;
      if(paintNext) continue;
      return [k + 1, W8[k]];
    }
    return null;
  };
  r.fromL = side(-1); r.fromR = side(1);
  return r;
}

/* ---------- 여러 장 추적 ----------
   update(read, t(ms)) → T {fromL, fromR: 왼쪽·오른쪽 끝에서 몇 번째(확정된 값 또는 null), changes, last}
   idx(nLanes) → 왼쪽부터 몇 번째: fromL이 있으면 그대로, 없으면 nLanes − fromR + 1 (HUD가 그리는 차로 수) · count() → 카메라로 센 차로 수
   · 근거 표(왼쪽·오른쪽 따로): 새 근거가 오면 그쪽 기존 무게 × DECAY 후 더함. 근거가 없어도 시간이 지나면 천천히 옅어짐(반감 HALF_MS)
     → 정차 · 가림 동안은 유지, 길이 바뀌고 근거가 안 오면 '모름'으로 돌아감. 회전 · 진출입을 마치면 reset
   · 확정: 1등 무게 SURE_W 이상 + 전체의 SURE_SHARE 이상
   · 차로 변경: 내 차에 가장 가까운 선을 따라가다 그 선이 내 차 가운데를 차로 폭 10% 넘게 지나 반대편으로 가면 한 칸. 근거 표도 한 칸 옮김
     직전 장과 CHANGE_MS(폰이 느려 장 간격이 길면 그 2.5배) 넘게 떨어졌거나 차로 폭이 크게 다르면(교차로 · 갈림) 세지 않음 */
const DECAY = .97, SURE_W = 2, SURE_SHARE = .6, CHANGE_MS = 1000, HALF_MS = 45000;
export function createLaneTracker(){
  const T = {fromL:null, fromR:null, vL:new Map(), vR:new Map(), prev:null, changes:0, last:null, lastT:0, laneW:null, t:null, dt:200};
  const shift = (m, d) => { const v = new Map(); m.forEach((w, k) => { if(k + d >= 1) v.set(k + d, w); }); return v; };
  const add = (m, e) => { if(!e) return; m.forEach((w, k) => m.set(k, w*DECAY)); m.set(e[0], (m.get(e[0]) || 0) + e[1]); };
  const pick = m => { let b = null, bw = 0, s = 0; m.forEach((w, k) => { s += w; if(w > bw){ bw = w; b = k; } }); return b !== null && bw >= SURE_W && bw/s >= SURE_SHARE ? b : null; };
  function update(r, t = 0){
    if(T.t !== null && t > T.t){
      const f = Math.pow(.5, (t - T.t)/HALF_MS); T.vL.forEach((w, k) => T.vL.set(k, w*f)); T.vR.forEach((w, k) => T.vR.set(k, w*f));
      T.dt += (Math.min(3000, t - T.t) - T.dt)*.1;
    }
    T.t = t;
    if(r.width) T.laneW = T.laneW ? T.laneW + (r.width - T.laneW)*.05 : r.width;
    // 차로 변경: 내 차에 가장 가까운 선을 장마다 따라가다가(위치가 차로 폭 30% 안에서 이어지면 같은 선)
    // 그 선이 내 차 가운데를 차로 폭 10% 넘게 지나 반대편으로 가면 한 칸 (걸친 동안 잡음으로 깜빡여도 한 번만)
    const w = T.laneW, cx = r.cx;
    if(w && cx != null && r.lines.length){
      const p = T.prev, near = r.lines.reduce((b, s) => Math.abs(s.x - cx) < Math.abs(b.x - cx) ? s : b);
      const m = p && t - p.t <= Math.max(CHANGE_MS, 2.5*T.dt) ? r.lines.reduce((b, s) => Math.abs(s.x - p.x) < Math.abs(b.x - p.x) ? s : b) : null;
      if(m && Math.abs(m.x - p.x) < .3*w && (m === near || Math.abs(m.x - cx) < .1*w)){
        let side = p.side;
        if(m.x < cx - .1*w) side = -1; else if(m.x > cx + .1*w) side = 1;
        // 셀 때 조건: 이 선을 0.8초 넘게(2장 이상) 이어 봤고(혼자 튀는 가짜 선 거르기) 이번 장 내 차로 폭이 평소와 비슷
        // (새 차로 바깥 선이 가려져 폭을 못 재면 1.6초 넘게 이어 본 선일 때만)
        const seen = t - p.t0, ok = p.age >= 2 && (r.width ? seen >= 800 && Math.abs(r.width - w) < .35*w : seen >= 1600);
        if(side !== p.side && ok){
          const d = p.side > 0 ? 1 : -1;   // 오른쪽에 있던 선이 왼쪽으로 = 내가 오른쪽으로 감
          T.vL = shift(T.vL, d); T.vR = shift(T.vR, -d);
          if(T.fromL !== null) T.fromL = Math.max(1, T.fromL + d);
          if(T.fromR !== null) T.fromR = Math.max(1, T.fromR - d);
          T.changes++; T.last = d; T.lastT = t;
        }
        T.prev = {x:m.x, side:ok ? side : p.side, t, t0:p.t0, age:p.age + 1};
      }
      // 따라가던 선을 놓쳤거나 다른 선이 더 가까워졌으면 그 선으로 갈아탐 (걸쳐 있지 않을 때만)
      else T.prev = Math.abs(near.x - cx) < .6*w ? {x:near.x, side:near.x < cx ? -1 : 1, t, t0:t, age:1} : null;
    }
    add(T.vL, r.fromL); add(T.vR, r.fromR);
    // 확정 값은 근거 표가 다시 확정할 때까지 유지하되, 무게가 다 옅어지면(길이 바뀜) 모름
    const a = pick(T.vL), b = pick(T.vR), tot = m => { let s = 0; m.forEach(w => { s += w; }); return s; };
    T.fromL = a !== null ? a : tot(T.vL) < .5 ? null : T.fromL;
    T.fromR = b !== null ? b : tot(T.vR) < .5 ? null : T.fromR;
    return T;
  }
  // 양쪽을 다 알고 지도 차로 수와 안 맞으면 근거가 더 쌓인 쪽을 믿는다
  const top = m => { let b = 0; m.forEach(w => { b = Math.max(b, w); }); return b; };
  function idx(nLanes){
    const l = T.fromL, r = T.fromR !== null && nLanes ? Math.max(1, nLanes - T.fromR + 1) : null;
    if(l !== null && r !== null && Math.min(l, nLanes) !== r) return top(T.vR) > top(T.vL) ? r : Math.min(l, nLanes);
    if(l !== null) return nLanes ? Math.min(l, nLanes) : l;
    return r;
  }
  // 카메라로 센 한 방향 차로 수: 양쪽 끝을 다 알 때만 (왼쪽에서 몇 번째 + 오른쪽에서 몇 번째 − 1)
  const count = () => T.fromL !== null && T.fromR !== null ? T.fromL + T.fromR - 1 : null;
  function reset(){ Object.assign(T, {fromL:null, fromR:null, vL:new Map(), vR:new Map(), prev:null, changes:0, last:null, lastT:0, laneW:null, t:null, dt:200}); }
  return {T, update, idx, count, reset};
}
