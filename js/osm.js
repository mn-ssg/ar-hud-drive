/* ============================================================
   osm.js — OpenStreetMap(Overpass)에서 경로 주변 큰 도로의 차선 수를 받아
            경로 구간별 '내 진행 방향 차선 수' runs로 바꾼다
   · 차선 수가 입력된 도로만 값이 있고, 나머지는 null(모름)
   · 경로를 받을 때 한 번만 부른다
   ============================================================ */
import {OVERPASS, MAX_LANES, RUN_MIN_M} from './config.js';
import {fetchTimeout} from './util.js';
import {pointAt, headingXY, angleDiff, segDist} from './geo.js';
import {toRuns} from './route.js';

const ROADS = '^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$';
const PIECE = 500;    // 경로를 이 길이(m) 조각으로 나눠 조각마다 작은 사각 영역으로 묻는다 (긴 선 하나로 물으면 서버가 못 버팀)
const MARGIN = 40;    // 사각 영역 여유(m)
const NEAR_M = 15;    // 경로에서 이 거리(m) 안의 도로만 같은 도로로 본다
const STEP = 10;      // 경로를 이 간격(m)으로 훑는다
const CELL = 50;      // 가까운 도로를 빨리 찾기 위한 격자 크기(m)

export function lanesQuery(route){
  const {ll, cum} = route, parts = [];
  for(let a = 0, i = 1; i < ll.length; i++){
    if(cum[i] - cum[a] < PIECE && i < ll.length - 1) continue;
    const seg = ll.slice(a, i + 1), lat = seg.map(c => c[1]), lon = seg.map(c => c[0]);
    const dy = MARGIN/110540, dx = MARGIN/(111320*Math.cos(lat[0]*Math.PI/180));
    parts.push(`way(${(Math.min(...lat)-dy).toFixed(5)},${(Math.min(...lon)-dx).toFixed(5)},${(Math.max(...lat)+dy).toFixed(5)},${(Math.max(...lon)+dx).toFixed(5)})[highway~"${ROADS}"];`);
    a = i;
  }
  return `[out:json][timeout:25];(${parts.join('')});out geom;`;
}

export async function fetchLaneRuns(route){
  const body = new URLSearchParams({data:lanesQuery(route)});
  let last = new Error('OSM 서버 없음');
  for(const url of OVERPASS){
    try{
      const r = await fetchTimeout(url, {method:'POST', body}, 25000);
      if(!r.ok){ last = new Error('OSM ' + r.status); continue; }
      const j = await r.json();
      if(j.remark && !(j.elements && j.elements.length)){ last = new Error('OSM: ' + j.remark); continue; }   // 서버 시간 초과
      return lanesFromWays(route, j.elements || []);
    }catch(e){ last = e; }
  }
  throw last;
}

const YES = new Set(['yes', 'true', '1']);
// 일방통행: 1 그린 방향으로만 / -1 반대로만 / 0 양방향
const onewayOf = t => t.oneway === '-1' ? -1 : YES.has(t.oneway) || t.highway === 'motorway' || t.junction === 'roundabout' ? 1 : 0;

// 이 도로에서 내 진행 방향 차선 수. along = 도로를 그린 방향과 같은 방향으로 달리는지. 모르면 null
function dirLanes(t, ow, along){
  const num = v => { const k = parseInt(v, 10); return k >= 1 ? k : null; };
  let n;
  if(ow) n = num(t.lanes);
  else{
    n = num(t[along ? 'lanes:forward' : 'lanes:backward']);
    if(!n){ const all = num(t.lanes); n = all === 1 ? 1 : all && all % 2 === 0 ? all/2 : null; }   // 방향별 값이 없으면 반씩 (홀수면 모름)
  }
  return n ? Math.min(n, MAX_LANES) : null;
}

export function lanesFromWays(route, ways){
  const {plane, pts, cum, len} = route, grid = new Map(), key = (i, j) => i + ',' + j;
  ways.forEach(w => {
    if(!w.geometry || !w.tags) return;
    const t = w.tags, ow = onewayOf(t), xy = w.geometry.map(g => plane.toXY(g.lat, g.lon));
    for(let k = 0; k < xy.length - 1; k++){
      const A = xy[k], B = xy[k+1], seg = {A, B, h:headingXY(A, B), t, ow};
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
    let best = null, bestScore = Infinity;
    for(let i = ci - 1; i <= ci + 1; i++) for(let j = cj - 1; j <= cj + 1; j++){
      const list = grid.get(key(i, j)); if(!list) continue;
      for(const g of list){
        const dh = angleDiff(p.heading, g.h), along = dh <= 35;
        if(!along && dh < 145) continue;                          // 가로지르는 도로
        if((g.ow === 1 && !along) || (g.ow === -1 && along)) continue;   // 반대 방향 일방통행(중앙분리 도로의 건너편)
        const d = segDist(q, g.A, g.B); if(d > NEAR_M) continue;
        const score = d + (along ? dh : 180 - dh)*0.1;
        if(score < bestScore){ bestScore = score; best = {g, along}; }
      }
    }
    samples.push({s, v:best ? dirLanes(best.g.t, best.g.ow, best.along) : null});
  }
  return toRuns(samples, RUN_MIN_M);
}
