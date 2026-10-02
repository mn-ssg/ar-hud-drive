/* ============================================================
   framegeom.js — 카메라 화면에서 '지평선(소실점) 높이'와 '보닛이 시작하는 높이'를 저절로 찾기  (순수 계산, Node로 시험)
   · CLRerNet은 CULane처럼 '소실점 바로 아래 ~ 보닛 바로 위' 띠를 넣어야 잘 본다 (넓게 넣으면 보닛 · 하늘에 가짜 선)
   · 폰 거치 각도 · 높이가 차마다 달라서 숫자로 정하지 않고 주행 중에 맞춘다
   ============================================================ */

// x = a*y + b (아래쪽 절반 점으로)
function fit(pts){
  const P = pts.slice(0, Math.max(4, pts.length >> 1));
  if(P.length < 4) return null;
  let sy = 0, sx = 0, syy = 0, sxy = 0; const n = P.length;
  for(const [x, y] of P){ sy += y; sx += x; syy += y*y; sxy += x*y; }
  const d = n*syy - sy*sy; if(Math.abs(d) < 1e-9) return null;
  const a = (n*sxy - sx*sy)/d; return {a, b:(sx - a*sy)/n};
}

/* 소실점 높이: 내 차 가운데(cx) 양쪽에서 가장 가까운 선 두 개(점수 0.4↑, 점 8개↑)가 만나는 y. 못 구하면 null
   lanes: 화면 기준 0~1, yRef: 선 위치를 재는 줄 */
export function vpFromLanes(lanes, cx, yRef){
  const xRef = l => { const f = fit(l.pts); return f ? {f, x:f.a*yRef + f.b} : null; };
  const c = lanes.filter(l => l.score >= .4 && l.pts.length >= 8).map(xRef).filter(Boolean);
  const L = c.filter(t => t.x < cx).sort((p, q) => q.x - p.x)[0], R = c.filter(t => t.x >= cx).sort((p, q) => p.x - q.x)[0];
  if(!L || !R || Math.abs(L.f.a - R.f.a) < .2) return null;
  const y = (R.f.b - L.f.b)/(L.f.a - R.f.a);
  return y > .2 && y < .8 ? y : null;
}

/* 보닛: 아래쪽에서 '늘 같은 높이에 있는 가로 경계선'이 보닛(대시보드) 윗선. 도로의 경계(그림자 · 정지선 · 앞차)는 달리면 위치가 바뀌어 평균하면 흐려진다
   (프레임 차이로 찾으면 자동 노출 때문에 대시보드도 늘 바뀌는 것처럼 나와서 안 됨 — 10-02 시험)
   add(gray: Uint8Array(w*h), w, h, moving) — 작은 흑백 화면을 넣는다. moving = 시속 15km 넘게 달리는 중일 때만 모음
   → hood(): 보닛이 시작하는 높이(0~1) 또는 null(아직 모름 · 경계가 뚜렷하지 않음) */
export function createHoodFinder(){
  let E = null, n = 0;
  function add(g, w, h, moving){
    if(!moving) return;
    if(!E || E.length !== h) { E = new Float32Array(h); n = 0; }
    for(let y = 0; y < h - 1; y++){
      let s = 0; for(let x = Math.round(w*.04); x < w*.96; x++) s += g[(y + 1)*w + x] - g[y*w + x];   // 부호 있는 평균: 한 줄 전체가 같은 방향으로 바뀌는 경계만 남음
      E[y] += Math.abs(s/(w*.92));
    }
    n++;
  }
  function hood(){
    if(!E || n < 50) return null;
    const h = E.length, lo = Math.round(h*.6), P = [...E].map(e => e/n);
    const part = P.slice(lo, h - 1), mx = Math.max(...part), md = part.slice().sort((a, b) => a - b)[part.length >> 1];
    if(mx < 2.5*md || mx < 6) return null;
    for(let y = lo; y < h - 1; y++) if(P[y] >= .6*mx) return Math.min(.98, (y + 1)/h);   // 위에서부터 처음 나오는 뚜렷한 경계
    return null;
  }
  return {add, hood, reset(){ E = null; n = 0; }};
}
