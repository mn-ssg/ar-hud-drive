/* ============================================================
   nav.js — 위치 → 경로 위 위치
   · GPS 위치를 경로 선에 붙여 '출발점부터 경로 따라 몇 m'(s)를 구한다
   · 경로에서 벗어난 채 시간이 지나면 경로를 다시 받는다
   · 가상 주행: 경로를 따라 SIM_KMH로 움직이며 1초마다 GPS처럼 위치를 넣는다
   ============================================================ */
import {OFF_ROUTE, OFF_ROUTE_MS, REROUTE_GAP_MS, SIM_KMH} from './config.js';
import {snap, pointAt} from './geo.js';

// getRoute(pos) → Promise<route> : 경로를 다시 받는 방법 (main.js가 넘긴다)
export function createNav(getRoute){
  const N = {
    route:null, sim:false,
    pos:null,         // 안내에 쓰는 위치 (가상 주행이면 가짜 위치)
    fix:null,         // 경로 선에 붙인 위치 {s, off: 경로에서 벗어난 m, seg, t, v}
    sDisp:null, sT:0, // 화면용 s (GPS가 1초에 한 번이라 그 사이를 속도로 채움)
    offSince:0, lastReroute:0, rerouting:false,
    simS:0, simLast:0, simTick:0
  };

  function start(route, sim, now){
    Object.assign(N, {route, sim, fix:null, sDisp:null, sT:0, offSince:0, lastReroute:now, simS:0, simLast:0, simTick:0});
  }
  function stop(){ N.route = null; N.sim = false; }

  function update(p, now){
    N.pos = p;
    const R = N.route; if(!R) return;
    const q = R.plane.toXY(p.lat, p.lon), lost = !N.fix || N.fix.off > OFF_ROUTE;
    const hit = lost ? snap(R.pts, R.cum, q, 0, R.pts.length - 2) : snap(R.pts, R.cum, q, N.fix.seg - 3, N.fix.seg + 80);
    N.fix = {s:hit.s, off:hit.d, seg:hit.seg, t:now, v:p.v || 0};
    if(!N.sim && hit.d > Math.max(OFF_ROUTE, (p.acc || 0)*1.5)){
      if(!N.offSince) N.offSince = now;
      if(now - N.offSince > OFF_ROUTE_MS) reroute(now);
    } else N.offSince = 0;
  }

  async function reroute(now){
    if(N.rerouting || now - N.lastReroute < REROUTE_GAP_MS) return;
    N.rerouting = true; N.lastReroute = now;
    try{
      const route = await getRoute(N.pos);
      if(N.route){   // 기다리는 사이 안내를 끝냈으면 버린다
        Object.assign(N, {route, fix:null, sDisp:null, offSince:0});
        update(N.pos, performance.now());
      }
    }catch(e){ /* 실패하면 REROUTE_GAP_MS 뒤 다시 시도 */ }
    N.rerouting = false;
  }

  // 화면용 위치: 마지막 GPS 값 + 속도 × 지난 시간(최대 1.5초), 튀지 않게 부드럽게
  function currentS(now){
    const f = N.fix; if(!f) return null;
    const pred = f.s + f.v*Math.min(1.5, (now - f.t)/1000), dt = N.sT ? (now - N.sT)/1000 : 0;
    N.sT = now;
    if(N.sDisp === null || Math.abs(pred - N.sDisp) > 60) N.sDisp = pred;
    else N.sDisp += (pred - N.sDisp)*(1 - Math.exp(-dt/0.1));
    return N.sDisp;
  }

  function simStep(now){
    const R = N.route, dt = N.simLast ? Math.min(0.5, (now - N.simLast)/1000) : 0;   // 화면을 벗어났다 오면 순간이동하지 않게
    N.simS = Math.min(R.len, N.simS + SIM_KMH/3.6*dt);
    N.simLast = now;
    if(!N.simTick || now - N.simTick > 1000){
      N.simTick = now;
      const a = pointAt(R.pts, R.cum, N.simS), ll = R.plane.toLL(a.xy[0], a.xy[1]);
      update({lat:ll.lat, lon:ll.lon, acc:5, v:N.simS < R.len ? SIM_KMH/3.6 : 0, heading:a.heading}, now);
    }
  }

  return {N, start, stop, update, currentS, simStep};
}
