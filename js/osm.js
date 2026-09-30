/* ============================================================
   osm.js — OpenStreetMap(Overpass)에서 경로 주변 큰 도로의 차선 수를 받아
            경로 구간별 '내 진행 방향 차선 수' runs로 바꾼다
   · 표준노드링크(lanes.js)로 모르는 구간이 남을 때만 쓴다
   · 차선 수가 입력된 도로만 값이 있고, 나머지는 null(모름)
   ============================================================ */
import {OVERPASS} from './config.js';
import {fetchTimeout} from './util.js';
import {matchLanes} from './lanes.js';

const ROADS = '^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$';
const PIECE = 500;    // 경로를 이 길이(m) 조각으로 나눠 조각마다 작은 사각 영역으로 묻는다 (긴 선 하나로 물으면 서버가 못 버팀)
const MARGIN = 40;    // 사각 영역 여유(m)

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
const num = v => { const k = parseInt(v, 10); return k >= 1 ? k : null; };

// OSM 도로 태그 → 그린 방향 / 반대 방향 차선 수 (false = 그 방향 통행 불가)
function wayLanes(t){
  if(t.oneway === '-1') return {fwd:false, back:num(t.lanes)};
  if(YES.has(t.oneway) || t.highway === 'motorway' || t.junction === 'roundabout') return {fwd:num(t.lanes), back:false};
  const all = num(t.lanes), half = all === 1 ? 1 : all && all % 2 === 0 ? all/2 : null;   // 방향별 값이 없으면 반씩 (홀수면 모름)
  return {fwd:num(t['lanes:forward']) || half, back:num(t['lanes:backward']) || half};
}

export function lanesFromWays(route, ways){
  const roads = [];
  ways.forEach(w => { if(w.geometry && w.tags) roads.push({ll:w.geometry.map(g => [g.lat, g.lon]), ...wayLanes(w.tags)}); });
  return matchLanes(route, roads);
}
