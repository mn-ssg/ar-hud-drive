/* ============================================================
   laneread.js — 차선 분할 결과(TwinLiteNet) → 내 차로 읽기 · 추적  (화면·카메라와 무관한 순수 계산)
   · 한 장: 보닛 위 도로 띠에서 줄마다 차선 조각을 찾아 → 내 차로 양쪽 선 · 그 바깥 선 개수 · 노란 중앙선 · 길 끝
            → 왼쪽부터 몇 번째 차로인지 (왼쪽 끝을 봤을 때만 확실), 오른쪽 끝에서 몇 번째인지
   · 여러 장: 최근 판정을 모아 다수결 + 선을 넘는 순간 차로 변경(±1). 선이 가려져도(앞차 · 정차) 마지막 차로를 유지
   ============================================================ */

const BAND = 90, STEP = 4;      // 선을 찾는 띠: 보닛 바로 위 도로부터 위로 90px(모델 입력 360px 기준), 4px마다
const SEG_MAX = 40;             // 이보다 넓은 차선 덩어리는 선이 아님(정지선 · 횡단보도)
const EDGE_GAP = 18;            // 선 바깥으로 이만큼(px) 안에서 '달릴 수 있는 곳'이 끝나면 그 선이 길 끝

// 노란 중앙선: 색상 25~65°, 채도 0.25↑, 밝기 0.35↑ (lab/lane.js와 같은 기준)
function isYellow(r, g, b){
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx/255, sat = mx ? (mx - mn)/mx : 0;
  if(v < .35 || sat < .25 || (mx !== r && mx !== g)) return false;
  const h = mx === r ? 60*((g - b)/(mx - mn || 1)) : 60*(2 + (b - r)/(mx - mn || 1));
  return h >= 25 && h <= 65;
}

// 보닛 위 도로가 시작하는 줄: 내 차 가운데 세로줄에서 아래부터 올라가며 처음 '달릴 수 있는 곳'
function roadBottom(road, W, H, cx){
  const x0 = Math.round(cx);
  for(let y = H - 1; y > H/2; y--){ let c = 0; for(let dx = -20; dx <= 20; dx += 5) c += road[y*W + x0 + dx] || 0; if(c >= 5) return y; }
  return H - 10;
}

/* lane · road: 0/1 마스크(W×H), px: 픽셀(ch = 3 RGB 또는 4 RGBA), cx: 화면에서 내 차 가운데 x
   → {rows, seen, pos(차로 안 위치 0~1), mid(내 차로 가운데 x), roadFrac(화면 높이 중 도로 비율),
      left:{n, yellow}, right:{n}, laneLeft, laneRight}
   laneLeft  = 내 차로 왼쪽에 있는 차로 수 (왼쪽 끝을 봤을 때만, 아니면 null)
   laneRight = 오른쪽에 있는 차로 수 (오른쪽 끝을 봤을 때만) */
export function readLanes(lane, road, px, W, H, cx, ch = 4){
  const bottom = roadBottom(road, W, H, cx), rows = [];
  for(let y = bottom - 4; y > bottom - 4 - BAND && y > 0; y -= STEP){
    const segs = [];
    for(let x = 0, start = -1; x <= W; x++){
      const on = x < W && lane[y*W + x];
      if(on && start < 0) start = x;
      if(!on && start >= 0){
        if(x - start <= SEG_MAX){
          let yl = 0; for(let k = start; k < x; k++){ const p = (y*W + k)*ch; if(isYellow(px[p], px[p+1], px[p+2])) yl++; }
          const c = (start + x - 1)/2;
          // 선 바깥쪽이 곧 '달릴 수 없는 곳'인지 (길 끝 선)
          let leftOff = 0, rightOff = 0;
          for(let k = 1; k <= EDGE_GAP; k++){ if(start - k >= 0 && !road[y*W + start - k] && !lane[y*W + start - k]) leftOff++; if(x - 1 + k < W && !road[y*W + x - 1 + k] && !lane[y*W + x - 1 + k]) rightOff++; }
          segs.push({x:c, yellow:yl/(x - start) > .25, offL:leftOff > EDGE_GAP*.6 || start <= 1, offR:rightOff > EDGE_GAP*.6 || x >= W - 1});
        }
        start = -1;
      }
    }
    const L = segs.filter(s => s.x < cx).reverse(), R = segs.filter(s => s.x >= cx);   // 둘 다 가까운 것부터
    rows.push({y, L, R});
  }
  // 줄마다: 왼쪽 끝 선(노란선 또는 바깥이 길 아님)까지 몇 개 / 오른쪽 끝 선까지 몇 개
  const endAt = (list, side) => list.findIndex(s => side < 0 ? (s.yellow || s.offL) : s.offR);
  const vals = rows.filter(r => r.L.length && r.R.length);
  const med = a => { if(!a.length) return null; const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
  // 차로 안 위치: 띠의 아래쪽 절반(차에 가까운 쪽)에서
  const near = rows.length ? rows[0].y - BAND/2 : 0;
  const nearRows = vals.filter(r => r.y >= near);
  const pos = med(nearRows.map(r => (cx - r.L[0].x)/(r.R[0].x - r.L[0].x))), mid = med(nearRows.map(r => (r.L[0].x + r.R[0].x)/2));
  // 화면에서 도로가 차지하는 높이: 가운데 1/3 폭에서 '달릴 수 있는 곳'이 20% 넘는 줄 수 (폰이 너무 하늘을 보면 작다)
  let roadRows = 0;
  for(let y = 0; y < H; y += 2){ let c = 0; for(let x = W/3 | 0; x < 2*W/3; x += 4) c += road[y*W + x]; if(c > W/3/4*.2) roadRows += 2; }
  // 끝 선까지 개수: 끝 선이 보인 줄이 충분히 많을 때만 (조각 하나로 판단 안 함)
  // 옆 차로의 차도 '달릴 수 없는 곳'으로 나와 길 끝처럼 보이므로, 다른 줄에서 그 바깥에 선이 보이면 길 끝이 아님
  const side = (key, sgn) => {
    const hits = vals.map(r => endAt(r[key], sgn)).filter(i => i >= 0);
    if(hits.length < Math.max(3, vals.length*.4)) return null;
    const k = med(hits), beyond = vals.filter(r => r[key].length > k + 1).length;
    return beyond > vals.length*.25 ? null : k;
  };
  const yellowL = vals.filter(r => r.L[0].yellow).length;
  return {
    rows:rows.length, seen:vals.length, pos, mid, roadFrac:roadRows/H,
    left:{n:med(vals.map(r => r.L.length)), yellow:vals.length > 0 && yellowL >= vals.length*.4},
    right:{n:med(vals.map(r => r.R.length))},
    laneLeft:side('L', -1), laneRight:side('R', 1)
  };
}

/* ---------- 여러 장 추적 ----------
   update(read, nLanes) → {idx: 왼쪽부터 몇 번째 차로(1~) 또는 null, sure, changes, last}
   · 판정: 왼쪽 끝이 보이면 laneLeft + 1, 아니면 오른쪽 끝 + 지도 차로 수(nLanes)로 nLanes − laneRight
   · 최근 VOTE장 중 VOTE_MIN장 넘게 판정이 있고 같은 답이 70% 넘으면 그 차로로 확정
   · 내 차로 안 위치가 오른쪽 끝(0.75↑) → 바로 다음에 왼쪽 끝(0.25↓) = 오른쪽으로 한 칸 (반대도 같음) */
const VOTE = 15, VOTE_MIN = 8, AGREE = .7;
export function createLaneTracker(){
  const T = {idx:null, sure:false, votes:[], prevPos:null, changes:0, last:null};
  function update(r, nLanes){
    let m = null;
    if(r.laneLeft !== null) m = r.laneLeft + 1;
    else if(r.laneRight !== null && nLanes) m = nLanes - r.laneRight;
    if(m !== null && m >= 1){ T.votes.push(m); if(T.votes.length > VOTE) T.votes.shift(); }
    if(T.votes.length >= VOTE_MIN){
      const cnt = new Map(); T.votes.forEach(v => cnt.set(v, (cnt.get(v) || 0) + 1));
      const [best, c] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
      if(c/T.votes.length >= AGREE){ T.idx = best; T.sure = true; }
    }
    if(r.pos !== null){
      if(T.prevPos !== null && T.idx !== null){
        const d = T.prevPos > .75 && r.pos < .25 ? 1 : T.prevPos < .25 && r.pos > .75 ? -1 : 0;
        if(d){ T.idx = Math.max(1, T.idx + d); T.changes++; T.last = d; T.votes = []; }   // 바뀐 뒤엔 새로 모은다
      }
      T.prevPos = r.pos;
    }
    return T;
  }
  function reset(){ Object.assign(T, {idx:null, sure:false, votes:[], prevPos:null, changes:0, last:null}); }
  return {T, update, reset};
}
