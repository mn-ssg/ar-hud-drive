/* ============================================================
   geo.js — 위경도 ↔ 미터 평면, 경로 선 위 위치 계산
   화면·네트워크와 무관한 순수 계산만 둔다
   ============================================================ */
import {clamp} from './util.js';

const rad = d => d*Math.PI/180;

// 기준점 둘레의 미터 평면 (x 동쪽, y 북쪽). 수십 km 안에서는 오차가 무시할 만하다
export function makePlane(lat, lon){
  const kx = 111320*Math.cos(rad(lat)), ky = 110540;
  return {
    toXY: (la, lo) => [(lo - lon)*kx, (la - lat)*ky],
    toLL: (x, y) => ({lat:lat + y/ky, lon:lon + x/kx})
  };
}

// 가까운 두 위경도 사이 거리(m)·방위(북 0°, 시계 방향) — 몇 초 사이 GPS 두 점용
export function distM(a, b){ const x = rad(b.lon - a.lon)*Math.cos(rad((a.lat + b.lat)/2)), y = rad(b.lat - a.lat); return Math.hypot(x, y)*6371000; }
export function bearingLL(a, b){ const x = (b.lon - a.lon)*Math.cos(rad((a.lat + b.lat)/2)), y = b.lat - a.lat; return (Math.atan2(x, y)*180/Math.PI + 360) % 360; }
export const headingXY = (A, B) => (Math.atan2(B[0]-A[0], B[1]-A[1])*180/Math.PI + 360) % 360;
export const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

export function cumulative(pts){
  const c = [0];
  for(let i = 1; i < pts.length; i++) c.push(c[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  return c;
}

// 누적거리 s(m)가 들어 있는 구간 번호 (이진 탐색)
export function segAt(cum, s){
  let lo = 0, hi = cum.length - 2;
  while(lo < hi){ const mid = (lo + hi + 1) >> 1; if(cum[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}

// 경로 선 위 s(m) 지점의 좌표와 진행 방향
export function pointAt(pts, cum, s){
  s = clamp(s, 0, cum[cum.length-1]);
  const i = segAt(cum, s), A = pts[i], B = pts[i+1], t = (s - cum[i])/((cum[i+1] - cum[i]) || 1);
  return {xy:[A[0] + (B[0]-A[0])*t, A[1] + (B[1]-A[1])*t], heading:headingXY(A, B)};
}

// 점 q를 경로 선에 붙인다. a~b 구간만 찾음. firstClose면 앞에서부터 3m 안에 드는 첫 지점
export function snap(pts, cum, q, a, b, firstClose){
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

// 점 q와 선분 AB 사이 거리(m)
export function segDist(q, A, B){
  const dx = B[0]-A[0], dy = B[1]-A[1], L2 = dx*dx + dy*dy || 1e-9;
  const t = clamp(((q[0]-A[0])*dx + (q[1]-A[1])*dy)/L2);
  return Math.hypot(q[0] - (A[0] + dx*t), q[1] - (A[1] + dy*t));
}
