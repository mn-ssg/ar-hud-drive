/* ============================================================
   lanes.js — 경로 구간별 '내 진행 방향 차선 수' runs 만들기
   1순위: 국가 표준노드링크 (시험 경로 주변만 미리 뽑아 둔 data/nodelink-lanes.json)
   2순위: OpenStreetMap (osm.js) — 1순위로 모르는 구간이 남을 때만
   ============================================================ */
import {MAX_LANES, RUN_MIN_M} from './config.js';
import {pointAt, headingXY, angleDiff, segDist} from './geo.js';
import {toRuns} from './route.js';

const STEP = 10;      // 경로를 이 간격(m)으로 훑는다
const CELL = 50;      // 가까운 도로를 빨리 찾기 위한 격자 크기(m)

/* roads = [{ll:[[lat, lon], …], fwd, back}]
   fwd / back: 그린 방향 / 반대 방향으로 달릴 때 차선 수. null = 달릴 수 있지만 차선 수 모름, false = 그 방향으로 못 달림
   nearM: 경로에서 이 거리(m) 안의 도로만 같은 도로로 본다 */
export function matchLanes(route, roads, nearM = 15){
  const {plane, pts, cum, len} = route, grid = new Map(), key = (i, j) => i + ',' + j;
  roads.forEach(r => {
    const xy = r.ll.map(p => plane.toXY(p[0], p[1]));
    for(let k = 0; k < xy.length - 1; k++){
      const A = xy[k], B = xy[k+1], seg = {A, B, h:headingXY(A, B), fwd:r.fwd, back:r.back};
      const i0 = Math.floor(Math.min(A[0], B[0])/CELL), i1 = Math.floor(Math.max(A[0], B[0])/CELL);
      const j0 = Math.floor(Math.min(A[1], B[1])/CELL), j1 = Math.floor(Math.max(A[1], B[1])/CELL);
      for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++){
        const c = key(i, j); let list = grid.get(c);
        if(!list) grid.set(c, list = []);
        list.push(seg);
      }
    }
  });

  const samples = [];
  for(let s = 0; s <= len; s += STEP){
    const p = pointAt(pts, cum, s), q = p.xy, ci = Math.floor(q[0]/CELL), cj = Math.floor(q[1]/CELL);
    let best, bestScore = Infinity;
    for(let i = ci - 1; i <= ci + 1; i++) for(let j = cj - 1; j <= cj + 1; j++){
      const list = grid.get(key(i, j)); if(!list) continue;
      for(const g of list){
        const dh = angleDiff(p.heading, g.h), along = dh <= 35;
        if(!along && dh < 145) continue;                  // 가로지르는 도로
        const v = along ? g.fwd : g.back;
        if(v === false) continue;                          // 그 방향으로 못 달리는 차로(중앙분리 도로의 건너편 등)
        const d = segDist(q, g.A, g.B); if(d > nearM) continue;
        const score = d + (along ? dh : 180 - dh)*0.1;
        if(score < bestScore){ bestScore = score; best = v; }
      }
    }
    samples.push({s, v:best ? Math.min(best, MAX_LANES) : null});
  }
  return toRuns(samples, RUN_MIN_M);
}

// runs 중 값을 아는 구간의 비율 (0~1)
export function knownRatio(runs, len){
  if(!runs || !len) return 0;
  let known = 0;
  runs.forEach((r, i) => { if(r.v) known += (i + 1 < runs.length ? runs[i+1].s : len) - r.s; });
  return known/len;
}

/* ---------- 표준노드링크: 링크는 방향마다 따로 있어서 그린 방향으로만 달린다 ---------- */
let nodelink = null;
export async function loadNodelink(url = 'data/nodelink-lanes.json'){
  if(!nodelink) nodelink = fetch(url).then(r => { if(!r.ok) throw new Error('노드링크 ' + r.status); return r.json(); })
    .then(j => j.links.map(([lanes, flat]) => {
      const ll = []; for(let i = 0; i < flat.length; i += 2) ll.push([flat[i], flat[i+1]]);
      return {ll, fwd:lanes >= 1 ? lanes : null, back:false};
    }))
    .catch(e => { nodelink = null; throw e; });   // 실패하면 다음에 다시 시도
  return nodelink;
}
// 넓은 중앙분리 도로는 방향별 링크가 도로 양쪽에 따로 그려져 경로 선(도로 가운데)에서 15~20m 떨어진다. 반대 방향은 back:false로 걸러진다
export async function nodelinkRuns(route){ return matchLanes(route, await loadNodelink(), 25); }
