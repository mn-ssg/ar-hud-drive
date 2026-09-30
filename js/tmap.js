/* ============================================================
   tmap.js — TMAP 호출: 장소 검색 · 자동차 경로 · 경로 구간별 제한속도
   화면을 건드리지 않는다. 키 오류면 error.auth = true 로 알린다
   ============================================================ */
import {TMAP, RUN_MIN_M} from './config.js';
import {fetchTimeout} from './util.js';
import {snap} from './geo.js';
import {toRuns} from './route.js';

async function fail(r){
  let t = '';
  try{ const j = await r.json(); t = (j.error && (j.error.message || j.error.code)) || j.errorMessage || ''; }catch(e){}
  const auth = r.status === 401 || r.status === 403;
  const e = new Error(auth ? '앱 키를 확인해 주세요 (' + r.status + ')' : 'TMAP 오류 ' + r.status + (t ? ': ' + t : ''));
  e.auth = auth;
  return e;
}

export async function searchPlaces(key, word, near){
  const q = new URLSearchParams({version:'1', searchKeyword:word, count:'10', resCoordType:'WGS84GEO', reqCoordType:'WGS84GEO', searchType:'all'});
  if(near){ q.set('centerLat', near.lat); q.set('centerLon', near.lon); }
  const r = await fetchTimeout(TMAP + '/pois?' + q, {headers:{appKey:key, Accept:'application/json'}});
  if(r.status === 204) return [];
  if(!r.ok) throw await fail(r);
  const j = await r.json(), list = (j.searchPoiInfo && j.searchPoiInfo.pois && j.searchPoiInfo.pois.poi) || [];
  return list.map(p => {
    // 차로 들어가는 입구 좌표(front)가 있으면 그걸 쓴다
    const lat = Number(p.frontLat) || Number(p.noorLat), lon = Number(p.frontLon) || Number(p.noorLon);
    const addr = [p.upperAddrName, p.middleAddrName, p.lowerAddrName, p.roadName].filter(Boolean).join(' ');
    return {name:p.name, addr, lat, lon};
  }).filter(p => p.lat && p.lon);
}

// 자동차 경로 원본(GeoJSON). 달리는 중이면 진행 방향·속도를 같이 보내 U턴 경로를 피한다
export async function fetchRoute(key, from, dest){
  const body = {startX:from.lon, startY:from.lat, endX:dest.lon, endY:dest.lat,
    reqCoordType:'WGS84GEO', resCoordType:'WGS84GEO', searchOption:'0', trafficInfo:'N', startName:'현재 위치', endName:dest.name};
  if(from.v > 2 && from.heading != null && !isNaN(from.heading)){ body.angle = Math.round(from.heading); body.speed = Math.round(from.v*3.6); }
  const r = await fetchTimeout(TMAP + '/routes?version=1&format=json', {
    method:'POST', headers:{appKey:key, 'Content-Type':'application/json', Accept:'application/json'}, body:JSON.stringify(body)
  }, 20000);
  if(!r.ok) throw await fail(r);
  return r.json();
}

/* 경로 선을 도로에 맞춰(도로 매칭) 구간별 제한속도(km/h) runs를 만든다
   경로를 받을 때 한 번만 부른다. 한 번에 1000점까지라 넘으면 나눠 보낸다 */
const MATCH_MAX = 1000;
export async function fetchSpeedLimits(key, route){
  const {ll, pts, cum, plane} = route, samples = [];
  for(let base = 0; base < ll.length - 1; base += MATCH_MAX - 1){
    const part = ll.slice(base, base + MATCH_MAX);
    const r = await fetchTimeout(TMAP + '/road/matchToRoads1000?version=1', {
      method:'POST', headers:{appKey:key, 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json'},
      body:new URLSearchParams({coords:part.map(c => c[0] + ',' + c[1]).join('|'), responseType:'1'})
    }, 20000);
    if(!r.ok) throw await fail(r);
    const j = await r.json(), mp = (j.resultData && j.resultData.matchedPoints) || [];
    // sourceIndex가 있는 점 = 보낸 경로 점. 그 사이 점들은 다음 경로 점까지의 도로 위에 있다
    let seg = base;
    mp.forEach(p => {
      if(p.sourceIndex !== undefined) seg = base + Number(p.sourceIndex);
      const m = p.matchedLocation; if(!m) return;
      const hit = snap(pts, cum, plane.toXY(m.latitude, m.longitude), seg - 1, seg + 1);
      samples.push({s:hit.s, v:Number(p.speed) || null});
    });
  }
  samples.sort((a, b) => a.s - b.s);
  return toRuns(samples, RUN_MIN_M);
}
