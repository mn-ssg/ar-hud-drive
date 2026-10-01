/* ============================================================
   main.js — 실제 도로용 AR-HUD 시작점
   · 시작 화면(앱 키 · 목적지) → 카메라 · GPS → TMAP 경로 → HUD
   · 제한속도(TMAP 도로 매칭)와 차선 수(표준노드링크 → OSM)는 안내를 먼저 시작하고 뒤에서 채운다
   · 매 프레임: 가상 주행 → 경로 위 위치 → HUD · 정보 패널 (1초마다 주행 기록)
   ============================================================ */
import {HUD_FPS, OFF_ROUTE} from './config.js';
import {$, store} from './util.js';
import {searchPlaces, fetchRoute, fetchSpeedLimits} from './tmap.js';
import {fetchLaneRuns} from './osm.js';
import {nodelinkRuns, nodelinkSpeedRuns, knownRatio} from './lanes.js';
import {buildRoute, runAt} from './route.js';
import {createSpeedEstimator, createSmoother} from './speed.js';
import {createNav} from './nav.js';
import {startCamera, watchGPS, keepAwake, releaseAwake} from './device.js';
import {initHud, resetHud, drawHud} from './hud.js';
import {startLog, endLog, logRoute, logTick, flushLog, logStatus, hasLog, exportLog} from './log.js';

const A = {key:'', dest:null, gps:null, running:false};
const estimate = createSpeedEstimator(), smoothKmh = createSmoother(0.4);
const nav = createNav(pos => loadRoute(pos));

/* ============================================================
   경로
   ============================================================ */
// reason: 'start' | 'reroute' (주행 기록용)
async function loadRoute(from, reason = 'reroute'){
  const raw = await fetchRoute(A.key, from, A.dest), route = buildRoute(raw);
  route.limitState = route.laneState = 'loading';
  fillLimits(route);
  fillLanes(route);
  logRoute(reason, from, raw, route);
  return route;
}

// 제한속도: TMAP 도로 매칭 먼저, 막히면(하루 한도 초과 등) 노드링크 제한속도로
async function fillLimits(route){
  try{ route.limits = await fetchSpeedLimits(A.key, route); route.limitSrc = 'TMAP'; route.limitState = 'ok'; return; }catch(e){}
  try{ route.limits = await nodelinkSpeedRuns(route); route.limitSrc = '노드링크'; route.limitState = knownRatio(route.limits, route.len) > 0 ? 'ok' : 'fail'; }
  catch(e){ route.limitState = 'fail'; }
}

// 차선 수: 표준노드링크(국가 공공데이터) 먼저, 모르는 구간이 5% 넘게 남으면 OSM으로 채운다
async function fillLanes(route){
  try{ route.lanesNl = await nodelinkRuns(route); }catch(e){}
  if(knownRatio(route.lanesNl, route.len) >= .95){ route.laneState = 'ok'; return; }
  try{ route.lanesOsm = await fetchLaneRuns(route); route.laneState = 'ok'; }
  catch(e){ route.laneState = route.lanesNl ? 'ok' : 'fail'; }
}

/* ============================================================
   GPS
   ============================================================ */
function onFix(raw){
  const {v, heading} = estimate(raw);
  A.gps = {lat:raw.lat, lon:raw.lon, acc:raw.acc, v, heading};
  if(!nav.N.sim) nav.update(A.gps, performance.now());
}
function startGPS(){ watchGPS(onFix, err => { if(!A.running) say('위치를 받을 수 없어요: ' + err.message, true); }); }
function waitGPS(ms){
  return new Promise((ok, no) => {
    const t0 = Date.now(), iv = setInterval(() => {
      if(A.gps){ clearInterval(iv); ok(A.gps); }
      else if(Date.now() - t0 > ms){ clearInterval(iv); no(new Error('위치를 잡지 못했어요. 위치 권한을 허용했는지, 하늘이 보이는 곳인지 확인해 주세요.')); }
    }, 200);
  });
}

/* ============================================================
   매 프레임 (HUD_FPS로 제한)
   ============================================================ */
let lastDraw = 0, lastLog = 0;
function frame(now){
  if(!A.running) return;
  requestAnimationFrame(frame);
  if(now - lastDraw < 1000/HUD_FPS - 2) return;
  lastDraw = now;
  const N = nav.N, R = N.route;
  if(N.sim && R) nav.simStep(now);
  const s = R ? nav.currentS(now) : null, onRoute = s !== null && N.fix && N.fix.off <= OFF_ROUTE;
  const limit = onRoute ? runAt(R.limits, s) : null;
  const nl = onRoute ? runAt(R.lanesNl, s) : null, lanes = nl || (onRoute ? runAt(R.lanesOsm, s) : null);
  const kmh = smoothKmh(N.pos ? (N.pos.v || 0)*3.6 : 0, now);
  const st = drawHud(now, {route:R, s, offSince:N.offSince, kmh, limit, lanes}), laneSrc = nl ? '노드링크' : 'OSM';
  if(now - lastLog >= 1000){
    lastLog = now;
    logTick({pos:N.pos, s, off:N.fix ? N.fix.off : null, limit, lanes, laneSrc, word:st.word, m:st.m, d:st.d});
  }
  drawPanel(now, s, st, limit, lanes, laneSrc);
}

/* ---------- 정보 패널 (시연·확인용, HUD 아님) ---------- */
let panelT = 0;
const km = m => m >= 1000 ? (m/1000).toFixed(1) + 'km' : Math.max(0, Math.round(m)) + 'm';
const STATE_WORD = {loading:'불러오는 중', fail:'못 받음'};
function drawPanel(now, s, st, limit, lanes, laneSrc){
  if($('#panel').hidden || now - panelT < 250) return;
  panelT = now;
  const N = nav.N, R = N.route;
  $('#pNext').textContent = st.m ? `${km(st.d)} 앞 ${st.m.arrive ? '목적지 도착' : st.m.desc || st.m.word}` : '경로를 기다리는 중';
  const parts = [];
  if(R && s !== null) parts.push('남은 거리 ' + km(R.len - s));
  if(N.fix) parts.push('경로와 차이 ' + Math.round(N.fix.off) + 'm');
  if(R){
    parts.push(limit ? `제한 ${limit}km/h (${R.limitSrc})` : '제한속도 ' + (STATE_WORD[R.limitState] || '정보 없음'));
    parts.push(lanes ? `${lanes}차로 (${laneSrc})` : '차선 수 ' + (STATE_WORD[R.laneState] || '정보 없음 → 기본 3차로'));
  }
  if(N.sim) parts.push('가상 주행');
  else if(A.gps) parts.push('GPS 오차 ' + Math.round(A.gps.acc) + 'm');
  const L = logStatus();
  if(L) parts.push(L.full ? '기록 공간 가득 → 지금 내보내 주세요' : `기록 ${Math.floor(L.n/60)}분 ${L.n % 60}초`);
  $('#pMeta').textContent = parts.join(' · ');
}

/* ============================================================
   시작 화면
   ============================================================ */
function say(t, bad){ const m = $('#msg'); m.textContent = t; m.classList.toggle('bad', !!bad); }
function showError(e){
  if(e.auth) $('#keyField').hidden = false;   // 키가 틀렸으면 입력칸을 다시 보여준다
  say(e instanceof TypeError ? 'TMAP에 연결하지 못했어요. 인터넷 연결을 확인해 주세요. 계속 안 되면 브라우저가 TMAP 호출을 막는 경우예요.' : e.message, true);
}
function setDest(p){
  A.dest = p; store.set('dest', JSON.stringify(p));
  $('#chosen').hidden = false; $('#chosen').textContent = '목적지: ' + p.name;
  $('#goBtn').disabled = $('#simBtn').disabled = false;
}

// 주소 끝에 #key=앱키 를 붙여 한 번 열면 이 휴대폰에 저장된다. # 뒤는 서버로 가지 않아서 GitHub에도 남지 않는다
const urlKey = (new URLSearchParams(location.hash.slice(1)).get('key') || '').trim();
if(urlKey) store.set('tmapKey', urlKey);
$('#keyInput').value = urlKey || store.get('tmapKey') || '';
$('#keyField').hidden = !!$('#keyInput').value;   // 저장된 키가 있으면 입력칸을 숨긴다
try{ const d = JSON.parse(store.get('dest') || 'null'); if(d && d.lat) setDest(d); }catch(e){}

function readKey(){
  A.key = $('#keyInput').value.trim();
  if(!A.key){ say('TMAP 앱 키를 넣어 주세요.', true); $('#keyField').hidden = false; $('#keyInput').focus(); return false; }
  store.set('tmapKey', A.key); return true;
}

async function doSearch(){
  if(!readKey()) return;
  const w = $('#destInput').value.trim();
  if(!w){ say('목적지 이름을 넣어 주세요.', true); return; }
  startGPS();   // 가까운 곳이 먼저 나오도록 위치도 같이 켠다
  say('찾는 중…');
  try{
    const list = await searchPlaces(A.key, w, A.gps), ul = $('#results');
    ul.innerHTML = '';
    if(!list.length){ say('검색 결과가 없어요. 다른 이름으로 찾아보세요.'); return; }
    list.forEach(p => {
      const li = document.createElement('li'), b = document.createElement('button'), n = document.createElement('b'), a = document.createElement('span');
      n.textContent = p.name; a.textContent = p.addr; b.append(n, a);
      b.addEventListener('click', () => { setDest(p); ul.innerHTML = ''; say(''); });
      li.appendChild(b); ul.appendChild(li);
    });
    say('');
  }catch(e){ showError(e); }
}
$('#searchBtn').addEventListener('click', doSearch);
$('#destInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); doSearch(); } });

async function begin(sim){
  if(!readKey() || !A.dest) return;
  $('#goBtn').disabled = $('#simBtn').disabled = true;
  try{
    say('카메라를 켜는 중…');
    try{ await startCamera($('#cam')); }catch(e){ throw new Error('카메라를 켜지 못했어요: ' + e.message); }
    say('위치를 잡는 중…');
    startGPS();
    const from = await waitGPS(20000);
    say('경로를 받는 중…');
    startLog(A.dest, sim);
    const route = await loadRoute(from, 'start');
    nav.start(route, sim, performance.now());
    if(!sim) nav.update(A.gps, performance.now());
    resetHud();
    $('#start').hidden = true; $('#hudWrap').hidden = false; $('#panel').hidden = false;
    keepAwake();
    A.running = true; lastDraw = lastLog = 0; requestAnimationFrame(frame);
    say('');
  }catch(e){ showError(e); }
  $('#goBtn').disabled = $('#simBtn').disabled = false;
}
$('#goBtn').addEventListener('click', () => begin(false));
$('#simBtn').addEventListener('click', () => begin(true));

/* ---------- 주행 중 ---------- */
// 화면을 누르면 정보 패널 숨김/보임 (녹화할 때 숨기기)
document.addEventListener('click', e => {
  if(!A.running || e.target.closest('#panel')) return;
  $('#panel').hidden = !$('#panel').hidden;
});
$('#hideBtn').addEventListener('click', () => { $('#panel').hidden = true; });
$('#changeBtn').addEventListener('click', () => {
  A.running = false; nav.stop(); endLog();
  $('#hudWrap').hidden = true; $('#panel').hidden = true; $('#start').hidden = false;
  $('#oldLogBtn').hidden = !hasLog();
  releaseAwake();
});
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible'){ if(A.running) keepAwake(); }
  else flushLog();   // 다른 앱으로 가거나 화면이 꺼질 때 바로 저장
});
window.addEventListener('pagehide', flushLog);

/* ---------- 주행 기록 내보내기 (주행 중 패널 · 시작 화면) ---------- */
// 결과는 누른 버튼 글자로 잠깐 알린다 (주행 중엔 시작 화면 안내문이 안 보여서)
async function onExport(e){
  const b = e.currentTarget, label = b.textContent, tell = (t, ms) => { b.textContent = t; setTimeout(() => { b.textContent = label; }, ms); };
  try{ if(await exportLog()) tell('내보냈어요', 2000); }
  catch(err){ tell(err.message, 2500); }
}
$('#logBtn').addEventListener('click', onExport);
$('#oldLogBtn').addEventListener('click', onExport);
$('#oldLogBtn').hidden = !hasLog();

initHud();
