/* ============================================================
   route.js — TMAP 경로 응답 → 안내용 경로
   · 경로 선(미터 평면 좌표 + 출발점부터 누적거리)
   · 안내할 회전 지점 목록
   · 구간 값(제한속도·차선 수)을 경로 위치 s로 찾는 도구
   ============================================================ */
import {makePlane, cumulative, snap} from './geo.js';

/* 회전 정보(turnType) → HUD가 쓰는 방향·각도·단어
   dir: -1 왼쪽 / 1 오른쪽, ang: 미니 도로에서 꺾이는 각도, lead: 준비를 시작하는 거리(m) */
export function turnInfo(t){
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

export function buildRoute(geo){
  const feats = (geo && geo.features) || [], ll = [], marks = [];
  feats.forEach(f => {
    const g = f.geometry; if(!g) return;
    if(g.type === 'LineString') g.coordinates.forEach(c => { const q = ll[ll.length-1]; if(!q || q[0] !== c[0] || q[1] !== c[1]) ll.push(c); });
    else if(g.type === 'Point') marks.push({c:g.coordinates, p:f.properties || {}});
  });
  if(ll.length < 2) throw new Error('경로를 받지 못했어요. 출발지와 목적지가 너무 가깝지 않은지 확인해 주세요.');
  const plane = makePlane(ll[0][1], ll[0][0]);
  const pts = ll.map(c => plane.toXY(c[1], c[0])), cum = cumulative(pts);
  const man = []; let from = 0;
  marks.forEach(({c, p}) => {
    const info = turnInfo(Number(p.turnType)); if(!info) return;
    const hit = snap(pts, cum, plane.toXY(c[1], c[0]), from, pts.length - 2, true);
    from = hit.seg;
    man.push(Object.assign({s:hit.s, desc:p.description || '', type:Number(p.turnType)}, info));
  });
  if(!man.some(m => m.arrive)) man.push({dir:0, ang:0, word:'도착', lead:300, arrive:true, s:cum[cum.length-1], desc:'목적지', type:201});
  const p0 = (feats[0] && feats[0].properties) || {};
  return {
    plane, ll, pts, cum, len:cum[cum.length-1], man, time:Number(p0.totalTime) || 0,
    // 경로를 받은 뒤 따로 채운다. state: loading | ok | fail
    limits:null, limitState:'', lanes:null, laneState:''
  };
}

/* ---------- 구간 값: runs = [{s, v}] (s 오름차순). s 지점의 값 = s 이전 마지막 항목의 v ---------- */
export function runAt(runs, s){
  if(!runs || !runs.length || s < runs[0].s) return null;
  let lo = 0, hi = runs.length - 1;
  while(lo < hi){ const mid = (lo + hi + 1) >> 1; if(runs[mid].s <= s) lo = mid; else hi = mid - 1; }
  return runs[lo].v;
}

// 경로를 따라 뽑은 값들 → 값이 바뀌는 지점만 남긴 runs. minLen(m)보다 짧은 조각은 앞 구간에 합친다
export function toRuns(samples, minLen = 0){
  const raw = [];
  samples.forEach(p => { if(!raw.length || raw[raw.length-1].v !== p.v) raw.push({s:p.s, v:p.v}); });
  const out = [];
  raw.forEach((r, i) => {
    const end = i + 1 < raw.length ? raw[i+1].s : Infinity;
    if(out.length && end - r.s < minLen) return;
    if(!out.length || out[out.length-1].v !== r.v) out.push(r);
  });
  return out;
}
