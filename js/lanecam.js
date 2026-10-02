/* ============================================================
   lanecam.js — 카메라 차선 인식 (본 앱)
   · 카메라 원본(HUD가 겹치기 전) → '소실점 바로 아래 ~ 보닛 바로 위' 띠를 잘라 800×320
     → CLRerNet(models/clrernet_culane_dla34.onnx, 32MB · CULane 차선 검출) → clrernet.js(선 목록) → laneread.js(내 차로)
   · 띠 위치는 주행 중에 저절로 맞춘다(framegeom.js): 위 = 내 차로 양쪽 선이 만나는 높이, 아래 = 늘 같은 높이에 있는 보닛 윗선
   · HUD와 따로 돈다: 초당 최대 LANE_FPS번, 앞 계산이 끝나야 다음 (폰이 느리면 저절로 줄어듦)
   · 계산 엔진(onnxruntime-web)과 모델은 안내를 시작할 때 한 번 받는다
   · 폰이 차 가운데에 없어도 되게, 양쪽 선이 보일 때 내 차로 가운데를 천천히 맞춘다
   (10-01 TwinLiteNet(1.8MB) 분할 → 10-02 CLRerNet으로 바꿈, D45)
   ============================================================ */
import {LANE_FPS, LANE_CONF} from './config.js';
import {decodeLanes, toFrame} from './clrernet.js';
import {readLines, paintSampler, createLaneTracker} from './laneread.js';
import {vpFromLanes, createHoodFinder} from './framegeom.js';

const MODEL = 'models/clrernet_culane_dla34.onnx', ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const IW = 800, IH = 320;          // 모델 입력 (CULane 띠 비율)
const FW = 640, FH = 360;          // 선 종류 보기 · 보닛 찾기용 작은 화면
const GW = 96, GH = 54;            // 보닛 찾기용 흑백
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d', {willReadFrequently:true})]; };
const [, ig] = mk(IW, IH), [, fg] = mk(FW, FH);
const input = new Float32Array(3*IW*IH), gray = new Uint8Array(GW*GH);
const tracker = createLaneTracker(), hoodF = createHoodFinder();
let session = null, video = null, running = false, nLanes = null, kmh = 0, steps = 0;
// 화면 기준(0~1) 값들: 내 차 가운데 x · 소실점 높이 · 보닛 윗선 (폰마다 달라서 저장해 두고 다음 주행에 이어 씀)
const G = {cx:.5, vp:.5, hood:.85, hoodCand:null, hoodN:0, miss:0, sweep:0};
const VP_TRY = [.45, .5, .55, .6, .65, .7, .4];   // 소실점을 못 구할 때 돌아가며 넣어 볼 높이 (시작 값이 실제와 멀면 선을 하나도 못 찾아 맞출 수가 없어서)
try{ const g = JSON.parse(localStorage.getItem('laneGeom') || 'null'); if(g && g.cx > .3 && g.cx < .7) Object.assign(G, {cx:g.cx, vp:g.vp, hood:g.hood}); }catch(e){}
const saveGeom = () => { try{ localStorage.setItem('laneGeom', JSON.stringify({cx:+G.cx.toFixed(3), vp:+G.vp.toFixed(3), hood:+G.hood.toFixed(3)})); }catch(e){} };

// 밖에서 읽는 상태. state: off | loading | on | fail
// idx: 왼쪽부터 몇 번째 차로(모르면 null) · fromL/fromR: 왼쪽·오른쪽 끝에서 몇 번째 · count: 카메라로 센 차로 수 · road: 화면 높이 중 도로 띠 비율
export const LC = {state:'off', idx:null, sure:false, fromL:null, fromR:null, count:null, changes:0, read:null, ms:0, fps:0, backend:'', error:'', road:null, geom:G};

function loadScript(src){
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('차선 인식 엔진을 받지 못했어요')); document.head.appendChild(s); });
}

export async function startLaneCam(v){
  video = v; if(running) return;
  running = true; LC.state = 'loading'; LC.error = '';
  try{
    if(!window.ort) await loadScript(ORT + 'ort.all.min.js');
    window.ort.env.wasm.wasmPaths = ORT;
    if(!session) for(const ep of ['webgpu', 'wasm']){
      try{ session = await window.ort.InferenceSession.create(MODEL, {executionProviders:[ep], graphOptimizationLevel:'all'}); LC.backend = ep; break; }
      catch(e){ console.warn(ep, e); }
    }
    if(!session) throw new Error('차선 인식 모델을 불러오지 못했어요');
    if(!running) return;
    LC.state = 'on'; loop();
  }catch(e){ LC.state = 'fail'; LC.error = e.message; running = false; }
}
export function stopLaneCam(){ running = false; LC.state = 'off'; resetLaneTrack(); }
export function setLaneCount(n){ nLanes = n || null; }   // HUD가 그리는 이 구간 차로 수 — 오른쪽 끝에서 센 값을 왼쪽부터로 바꿀 때 씀
export function setSpeed(v){ kmh = v || 0; }              // 보닛 찾기는 달리는 중에만
// 회전 · 진출입을 마치면 다른 길이라 모은 근거를 버린다
export function resetLaneTrack(){ tracker.reset(); Object.assign(LC, {idx:null, sure:false, fromL:null, fromR:null, count:null, changes:0, read:null}); }

const stamps = [];
async function loop(){
  if(!running) return;
  const t0 = performance.now();
  if(video && video.readyState >= 2 && video.videoWidth){
    try{ await step(); LC.error = ''; }catch(e){ LC.error = e.message; }
    stamps.push(performance.now()); while(stamps.length && stamps[stamps.length-1] - stamps[0] > 3000) stamps.shift();
    LC.fps = stamps.length > 1 ? (stamps.length - 1)/((stamps[stamps.length-1] - stamps[0])/1000) : 0;
  }
  setTimeout(loop, Math.max(0, 1000/LANE_FPS - (performance.now() - t0)));
}

async function step(){
  // 카메라 원본에서 16:9 영역 (세로 화면이면 도로 쪽 띠)
  const vw = video.videoWidth, vh = video.videoHeight;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if(vw/vh > 16/9){ sw = vh*16/9; sx = (vw - sw)/2; } else { sh = vw*9/16; sy = (vh - sh)*.6; }
  // ① 작은 화면: 선 종류 · 보닛
  fg.drawImage(video, sx, sy, sw, sh, 0, 0, FW, FH);
  const px = fg.getImageData(0, 0, FW, FH).data;
  for(let y = 0; y < GH; y++) for(let x = 0; x < GW; x++){ const p = (Math.floor((y + .5)*FH/GH)*FW + Math.floor((x + .5)*FW/GW))*4; gray[y*GW + x] = (px[p]*77 + px[p+1]*150 + px[p+2]*29) >> 8; }
  hoodF.add(gray, GW, GH, kmh > 15);
  // ② 모델 띠: 소실점 조금 위 ~ 보닛 조금 위 → 800×320, BGR /255 (CLRerNet 학습 설정)
  const y0 = Math.min(.7, Math.max(.2, G.vp - .02)), y1 = Math.max(y0 + .2, G.hood - .01);
  ig.drawImage(video, sx, sy + y0*sh, sw, (y1 - y0)*sh, 0, 0, IW, IH);
  const ip = ig.getImageData(0, 0, IW, IH).data, n = IW*IH;
  for(let i = 0, p = 0; i < n; i++, p += 4){ input[i] = ip[p+2]/255; input[n + i] = ip[p+1]/255; input[2*n + i] = ip[p]/255; }
  const t = performance.now();
  const out = await session.run({input:new window.ort.Tensor('float32', input, [1, 3, IH, IW])});
  LC.ms = performance.now() - t;
  const lanes = toFrame(decodeLanes(out.xs.data, out.anchor_params.data, out.lengths.data, out.scores.data, {conf:LANE_CONF}), {y0, y1});
  // ③ 내 차로
  const yRef = y1 - .02;
  const r = readLines(lanes, {cx:G.cx, yRef, vp:G.vp, probe:paintSampler(px, FW, FH, 4), laneW:tracker.T.laneW});
  const T = tracker.update(r, performance.now());
  Object.assign(LC, {read:r, fromL:T.fromL, fromR:T.fromR, changes:T.changes, idx:tracker.idx(nLanes), count:tracker.count(), road:G.hood - G.vp});
  LC.sure = LC.idx !== null;
  // ④ 화면 맞추기 (천천히): 소실점 · 내 차 가운데(양쪽 선이 보이고 차로 가운데쯤일 때 — 대부분 차로 가운데로 달린다는 가정) · 보닛
  const v = vpFromLanes(lanes, G.cx, yRef);
  if(v !== null){ G.vp = G.miss > 10 ? v : G.vp + (v - G.vp)*.05; G.miss = 0; }
  else if(++G.miss > 10 && G.miss % 3 === 0 && kmh > 10) G.vp = VP_TRY[G.sweep++ % VP_TRY.length];   // 달리는 중 2초 넘게 못 구하면 0.6초마다 다른 높이로 (정차 · 앞차에 가림이면 그대로)
  if(r.mid !== null && r.pos > .3 && r.pos < .7) G.cx = Math.min(.7, Math.max(.3, G.cx + (r.mid - G.cx)*.02));
  if(++steps % 25) return;
  // 5초마다: 보닛 — 같은 값(±0.03)이 3번(15초) 이어지면 받아들임 (모으기 시작할 때 흔들림 방지) · 저장
  const h = hoodF.hood();
  if(h !== null && h > G.vp + .2){
    if(G.hoodCand !== null && Math.abs(h - G.hoodCand) < .03){ if(++G.hoodN >= 3) G.hood = h; }
    else { G.hoodCand = h; G.hoodN = 1; }
  }
  if(!G.miss) saveGeom();
}
