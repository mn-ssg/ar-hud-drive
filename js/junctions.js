/* ============================================================
   junctions.js — 경로 위 갈림 · 합류 찾기 (국가 표준노드링크의 도로 연결로)
   · TMAP 안내에는 '합류' 코드가 없고, 큰길을 그대로 따라가는 갈림은 안내가 안 올 수 있다(E15)
   · 노드링크 링크는 한 방향 길이다: 한 점으로 들어오는 길 1 · 나가는 길 2 = 갈림, 2 · 1 = 합류
     (세 길이 거의 같은 방향일 때만 — 교차로 · T자 길은 뺀다)
   · 경로가 그 점을 지나면 → 갈림: 다른 갈래가 어느 쪽인지 / 합류: 다른 길이 어느 쪽에서 들어오는지 · 내가 들어가는 쪽인지
   ============================================================ */
import {pointAt, snap, segAt, headingXY, angleDiff} from './geo.js';
import {loadNodelink} from './lanes.js';

const SAME = 70;     // 세 길이 이 각도(°) 안이면 갈림 · 합류 (넘으면 교차로 · T자)
const NEAR_M = 45;   // 경로선에서 이 거리(m) 안의 점만 (고속도로는 방향별 링크가 경로선에서 30~40m — lanes.js와 같은 이유)
const ALONG = 35;    // 하나뿐인 쪽 길(갈림의 들어오는 길 · 합류의 나가는 길)이 경로 방향과 이 각도(°) 안
const LOOK = 400;    // 두 갈래를 이 거리(m)까지 따라가 보고 경로를 따라가는 쪽을 내 길로 본다 (시험: 250m 53/64 · 300m 55 · 400m 58 · 500m 58)
const SPLIT = 15;    // 두 갈래가 경로에서 벗어난 정도의 차이가 이보다(m) 작으면 어느 쪽인지 모름 → 뺀다
const APART = 4;     // 다른 길이 왼쪽 · 오른쪽 어느 쪽인지는 두 갈래가 처음으로 이만큼(m) 벌어지는 곳에서 본다
                     // (고속도로 출구는 갈래 두 개가 처음 수십~백여 m 같은 선 위에 그려져 있다)
const DUP_M = 40;    // 같은 종류가 이 거리(m) 안에 또 있으면 하나만

let graph = null;    // {nodes: Map(key → {ll, ins, outs}), cand: 갈림 · 합류 모양 점, roads}
const key = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);

async function loadGraph(){
  if(graph) return graph;
  const roads = (await loadNodelink()).lanes, nodes = new Map();
  const get = p => { const k = key(p); let n = nodes.get(k); if(!n) nodes.set(k, n = {ll:p, ins:[], outs:[]}); return n; };
  roads.forEach((r, i) => { get(r.ll[0]).outs.push(i); get(r.ll[r.ll.length-1]).ins.push(i); });
  const cand = [...nodes.values()].filter(n => (n.ins.length === 1 && n.outs.length === 2) || (n.ins.length === 2 && n.outs.length === 1));
  return graph = {nodes, cand, roads};
}

// 링크 i에서 시작해 len(m)까지 따라간 점들 (fwd: 앞으로, 아니면 뒤로). 또 갈리면 가장 곧은 쪽으로
function follow(G, i, len, fwd, xy){
  const out = [], seen = new Set();
  let d = 0;
  while(i !== undefined && !seen.has(i) && d < len){
    seen.add(i);
    const P = G.roads[i].ll.map(p => xy(p)), seq = fwd ? P : P.slice().reverse();
    for(let k = out.length ? 1 : 0; k < seq.length; k++){
      if(out.length) d += Math.hypot(seq[k][0] - out[out.length-1][0], seq[k][1] - out[out.length-1][1]);
      out.push(seq[k]);
      if(d >= len) break;
    }
    const n = G.nodes.get(key(fwd ? G.roads[i].ll[G.roads[i].ll.length-1] : G.roads[i].ll[0])), next = n ? (fwd ? n.outs : n.ins).filter(k => !seen.has(k)) : [];
    const h = out.length > 1 ? headingXY(out[out.length-2], out[out.length-1]) : null;
    i = next.length < 2 || h === null ? next[0] : next.reduce((b, k) => {
      const Q = G.roads[k].ll, hk = fwd ? headingXY(xy(Q[0]), xy(Q[1])) : headingXY(xy(Q[Q.length-1]), xy(Q[Q.length-2]));
      return angleDiff(h, hk) < angleDiff(h, b.h) ? {k, h:hk} : b;
    }, {k:undefined, h:(h + 180) % 360}).k;
  }
  return out;
}
// 점들 중 처음부터 m(m) 떨어진 곳의 방향 (점에서 나가는 쪽)
function headAt(P, m){ const p = pointOn(P, m); return p ? headingXY(P[0], p) : null; }
// 점들 위 처음부터 m(m) 떨어진 점 (짧으면 끝점)
function pointOn(P, m){
  let d = 0;
  for(let k = 1; k < P.length; k++){
    const l = Math.hypot(P[k][0] - P[k-1][0], P[k][1] - P[k-1][1]);
    if(d + l >= m){ const t = (m - d)/(l || 1); return [P[k-1][0] + (P[k][0]-P[k-1][0])*t, P[k-1][1] + (P[k][1]-P[k-1][1])*t]; }
    d += l;
  }
  return P.length > 1 ? P[P.length-1] : null;
}
// 두 갈래(점에서 멀어지는 쪽으로 그린 점들)가 처음 APART m 벌어지는 곳에서 다른 갈래가 내 갈래의 왼쪽(-1) · 오른쪽(1)
// fwd: 갈림(점에서 앞으로) / 아니면 합류(점에서 뒤로 그렸으니 진행 방향은 반대)
function sideApart(mine, other, fwd){
  for(let m = 10; m <= LOOK; m += 5){
    const pm = pointOn(mine, m), po = pointOn(other, m), pb = pointOn(mine, m - 10);
    if(!pm || !po || !pb || Math.hypot(po[0] - pm[0], po[1] - pm[1]) < APART) continue;
    const d = fwd ? [pm[0] - pb[0], pm[1] - pb[1]] : [pb[0] - pm[0], pb[1] - pm[1]];
    return d[0]*(po[1] - pm[1]) - d[1]*(po[0] - pm[0]) > 0 ? -1 : 1;
  }
  return 0;
}
// 경로(a~b 구간)에서 본 점 p의 옆 거리(m). 왼쪽 +, 오른쪽 −
function sideOff(pts, cum, p, a, b){
  const hit = snap(pts, cum, p, a, b), A = pts[hit.seg], B = pts[hit.seg + 1];
  return Math.sign((B[0]-A[0])*(p[1]-A[1]) - (B[1]-A[1])*(p[0]-A[0])) * hit.d;
}

/* route → [{s, kind:'fork'|'merge', side, join, lanes:[내 길, 다른 길], ll:[위도, 경도]}] (s 오름차순)
   side: 다른 길이 있는 쪽 (-1 왼쪽 · 1 오른쪽). join: 합류에서 내가 옆길에서 큰길로 들어가는 쪽이면 true */
export async function junctionsOnRoute(route){
  const G = await loadGraph(), {plane, pts, cum, len} = route, xy = p => plane.toXY(p[0], p[1]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
  const out = [];
  for(const n of G.cand){
    const q = xy(n.ll);
    if(q[0] < x0 - NEAR_M || q[0] > x1 + NEAR_M || q[1] < y0 - NEAR_M || q[1] > y1 + NEAR_M) continue;
    const hit = snap(pts, cum, q, 0, pts.length - 2);
    if(hit.d > NEAR_M || hit.s < 5 || hit.s > len - 5) continue;
    const fork = n.outs.length === 2;
    // 경로 방향: 갈림은 갈리기 전 30m, 합류는 합친 뒤 30m (점 바로 위는 갈래 쪽으로 꺾여 있을 수 있다)
    const h = fork ? headingXY(pointAt(pts, cum, hit.s - 30).xy, pointAt(pts, cum, hit.s).xy) : headingXY(pointAt(pts, cum, hit.s).xy, pointAt(pts, cum, hit.s + 30).xy);
    // 하나뿐인 쪽 길이 경로 방향과 같아야 한다 (반대편 차로 · 가로지르는 길 거름)
    const one = follow(G, fork ? n.ins[0] : n.outs[0], 40, !fork, xy);
    const hOne = headAt(one, 25);
    if(hOne === null || angleDiff(h, fork ? (hOne + 180) % 360 : hOne) > ALONG) continue;
    // 두 갈래: 점에서 멀어지는 쪽으로 따라간 점들
    const two = (fork ? n.outs : n.ins).map(i => follow(G, i, LOOK, fork, xy));
    const hs = two.map(P => headAt(P, 25));
    if(hs.includes(null)) continue;
    const hIn = fork ? (hOne + 180) % 360 : hOne;   // 갈림 앞 · 합류 뒤 길의 진행 방향
    const away = hs.map(x => fork ? x : (x + 180) % 360);   // 두 갈래의 진행 방향
    if(angleDiff(away[0], away[1]) > SAME || angleDiff(hIn, away[0]) > SAME || angleDiff(hIn, away[1]) > SAME) continue;
    // 내 길 = 경로를 따라가는 갈래. TMAP 경로선은 노드링크 선과 일정하게 떨어져 있을 수 있어서(고속도로 30~40m)
    // 경로까지 거리 자체가 아니라, 갈림 · 합류 점의 옆 거리에서 얼마나 벗어나는지로 본다
    // 두 갈래를 같은 거리에서 비교하되, 경로가 있는 만큼만 (출발 직후 · 도착 직전엔 짧게, 60m도 안 되면 판단 안 함)
    const look = Math.min(LOOK, fork ? len - hit.s - 10 : hit.s - 10);
    if(look < 60) continue;
    const a = fork ? hit.seg : segAt(cum, Math.max(0, hit.s - look - 100)), b = fork ? segAt(cum, Math.min(len, hit.s + look + 100)) : hit.seg;
    const o0 = sideOff(pts, cum, q, Math.max(0, hit.seg - 2), Math.min(pts.length - 2, hit.seg + 2));
    const dev = two.map(P => Math.abs(sideOff(pts, cum, pointOn(P, look), a, b) - o0));
    const mine = dev[0] <= dev[1] ? 0 : 1, other = 1 - mine;
    if(dev[other] - dev[mine] < SPLIT) continue;
    // 다른 길이 어느 쪽인지: 두 갈래가 처음 벌어지는 곳에서 내 갈래 진행 방향 기준 (멀리 보면 고리형 램프가 반대쪽으로 돌아 나간다)
    const side = sideApart(two[mine], two[other], fork);
    if(!side) continue;
    const ids = fork ? n.outs : n.ins, lanes = [G.roads[ids[mine]].fwd, G.roads[ids[other]].fwd];
    const j = {s:hit.s, kind:fork ? 'fork' : 'merge', side, lanes, ll:n.ll};
    // 합류: 차로가 적은 쪽(같으면 나가는 길과 더 꺾인 쪽)이 들어가는 길
    if(!fork) j.join = (lanes[0] || 0) !== (lanes[1] || 0) ? (lanes[0] || 0) < (lanes[1] || 0) : angleDiff(away[mine], hIn) > angleDiff(away[other], hIn);
    out.push(j);
  }
  out.sort((p, q) => p.s - q.s);
  return out.filter((j, i) => !out.slice(0, i).some(k => k.kind === j.kind && j.s - k.s < DUP_M));
}
