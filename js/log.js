/* ============================================================
   log.js — 주행 기록 (시험 주행 뒤 원인 찾기용 · HUD에는 안 보임)
   · 경로를 받을 때마다: TMAP 경로 응답 원본(HUD가 안 쓰는 안내 지점까지 전부) + 구간별 차선 수 · 제한속도와 출처
   · 1초마다: GPS · 경로 위 위치 · 그때 HUD가 보여 준 것(행동 단어 · 차선 수 · 제한속도 · 다음 안내 지점)
   · 이 휴대폰(localStorage)에만 저장하고 최근 KEEP번 주행만 남긴다. 앱 키는 기록하지 않는다
   · '주행 기록 내보내기' → JSON 파일 (공유 시트로 AirDrop · 파일 저장, 안 되면 내려받기)
   ============================================================ */

const PREFIX = 'drivelog.', INDEX = PREFIX + 'index', KEEP = 3, FLUSH_MS = 10000;
let S = null, timer = null;

const r1 = x => x == null || isNaN(x) ? null : Math.round(x*10)/10;
const r6 = x => Math.round(x*1e6)/1e6;
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function ids(){ try{ return JSON.parse(localStorage.getItem(INDEX) || '[]'); }catch(e){ return []; } }
function setIds(a){ try{ localStorage.setItem(INDEX, JSON.stringify(a)); }catch(e){} }
function drop(id){ try{ localStorage.removeItem(PREFIX + id); }catch(e){} setIds(ids().filter(x => x !== id)); }
function load(id){ try{ return JSON.parse(localStorage.getItem(PREFIX + id)); }catch(e){ return null; } }

// 위치 한 점 (경로를 받을 때의 출발점 · 1초 기록 공용)
const where = p => p ? {lat:r6(p.lat), lon:r6(p.lon), acc:r1(p.acc), v:r1(p.v), hd:r1(p.heading)} : null;

// 경로 기록: 차선 수 · 제한속도는 경로를 받은 뒤 따로 채워지므로(main.js) 저장할 때마다 route에서 다시 읽는다
function routeOut(r){
  const R = r.route;
  return {t:r.t, reason:r.reason, from:r.from, len:Math.round(R.len),
    man:R.man.map(m => ({s:Math.round(m.s), type:m.type, word:m.word, desc:m.desc})),
    limitSrc:R.limitSrc, limitState:R.limitState, limits:R.limits,
    laneState:R.laneState, lanesNl:R.lanesNl, lanesOsm:R.lanesOsm,
    tmap:r.raw};
}
const out = s => ({id:s.id, start:s.start, sim:s.sim, dest:s.dest, routes:s.routes.map(routeOut), track:s.track});

/* ---------- 주행 시작 · 끝 ---------- */
export function startLog(dest, sim){
  endLog();
  const keep = ids(); while(keep.length >= KEEP) drop(keep.shift());
  const now = new Date();
  S = {id:stamp(now), start:now.toISOString(), sim:!!sim, dest:dest ? {name:dest.name, lat:dest.lat, lon:dest.lon} : null, routes:[], track:[], full:false};
  timer = setInterval(flushLog, FLUSH_MS);
}
export function endLog(){
  if(!S) return;
  flushLog(); clearInterval(timer); timer = null; S = null;
}

// reason: 'start' | 'reroute', raw = TMAP 경로 응답 그대로
export function logRoute(reason, from, raw, route){
  if(S) S.routes.push({t:Date.now(), reason, from:where(from), raw, route});
}
// e = {pos, s, off, limit, lanes, laneSrc, word, m, d}
export function logTick(e){
  if(!S) return;
  S.track.push(Object.assign({t:Date.now()}, where(e.pos), {
    s:r1(e.s), off:r1(e.off), lim:e.limit || null, ln:e.lanes || null, lnSrc:e.lanes ? e.laneSrc : null,
    act:e.word || '', nm:e.m ? {type:e.m.type, d:Math.round(e.d)} : null
  }));
}

/* ---------- 저장: 자리가 모자라면 오래된 주행부터 지운다. 이번 주행만으로도 모자라면 메모리에만 둔다 ---------- */
export function flushLog(){
  if(!S || (!S.routes.length && !S.track.length)) return;
  const json = JSON.stringify(out(S));
  for(;;){
    try{
      localStorage.setItem(PREFIX + S.id, json);
      const a = ids(); if(!a.includes(S.id)){ a.push(S.id); setIds(a); }
      S.full = false; return;
    }catch(e){
      const old = ids().filter(x => x !== S.id);
      if(!old.length){ S.full = true; return; }
      drop(old[0]);
    }
  }
}

// 정보 패널용: 이번 주행 기록 개수(≈ 초) · 저장 공간이 찼는지
export const logStatus = () => S ? {n:S.track.length, full:S.full} : null;
export const hasLog = () => !!S || ids().length > 0;

/* ---------- 내보내기 (버튼을 누른 바로 그 순간에 불러야 공유 시트가 열린다) ---------- */
export async function exportLog(){
  flushLog();
  const sessions = ids().filter(id => !S || id !== S.id).map(load).filter(Boolean);
  if(S && (S.routes.length || S.track.length)) sessions.push(out(S));
  if(!sessions.length) throw new Error('저장된 주행 기록이 없어요');
  const name = 'drivelog_' + stamp(new Date()) + '.json';
  const blob = new Blob([JSON.stringify({app:'ar-hud-drive', format:1, exported:new Date().toISOString(), sessions})], {type:'application/json'});
  const file = new File([blob], name, {type:'application/json'});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file]}); return name; }
    catch(e){ if(e.name === 'AbortError') return null; }   // 사용자가 닫음 / 공유 실패면 내려받기로
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  a.addEventListener('click', e => e.stopPropagation());   // '화면 누르면 패널 숨김'(main.js)까지 올라가지 않게
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return name;
}
