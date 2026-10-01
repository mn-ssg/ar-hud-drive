/* ============================================================
   lanecam.js — 카메라 차선 인식 (본 앱)
   · 카메라 원본 영상(HUD가 겹치기 전) → TwinLiteNet(lab/twinlite.onnx, 1.8MB) → laneread.js → 내 차로 추적
   · HUD와 따로 돈다: 초당 최대 LANE_FPS번, 앞 계산이 끝나야 다음 (폰이 느리면 저절로 줄어듦)
   · 계산 엔진(onnxruntime-web)은 안내를 시작할 때 한 번 받는다
   · 폰이 차 가운데에 없어도 되게, 양쪽 선이 보일 때 내 차로 가운데를 천천히 맞춘다
   ============================================================ */
import {LANE_FPS} from './config.js';
import {readLanes, createLaneTracker} from './laneread.js';

const W = 640, H = 360, ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
const g = cv.getContext('2d', {willReadFrequently:true});
const input = new Float32Array(3*W*H), lane = new Uint8Array(W*H), road = new Uint8Array(W*H);
const tracker = createLaneTracker();
let session = null, video = null, running = false, nLanes = null, cx = W/2;
try{ const c = parseFloat(localStorage.getItem('laneCx')); if(c > W*.3 && c < W*.7) cx = c; }catch(e){}

// 밖에서 읽는 상태. state: off | loading | on | fail
export const LC = {state:'off', idx:null, sure:false, changes:0, read:null, ms:0, fps:0, backend:'', error:''};

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
      try{ session = await window.ort.InferenceSession.create('lab/twinlite.onnx', {executionProviders:[ep], graphOptimizationLevel:'all'}); LC.backend = ep; break; }
      catch(e){ console.warn(ep, e); }
    }
    if(!session) throw new Error('차선 인식 모델을 불러오지 못했어요');
    if(!running) return;
    LC.state = 'on'; loop();
  }catch(e){ LC.state = 'fail'; LC.error = e.message; running = false; }
}
export function stopLaneCam(){ running = false; LC.state = 'off'; tracker.reset(); Object.assign(LC, {idx:null, sure:false, changes:0, read:null}); }
export function setLaneCount(n){ nLanes = n || null; }   // 지도(노드링크)의 이 구간 차로 수 — 오른쪽 끝에서 셀 때 씀

const stamps = [];
async function loop(){
  if(!running) return;
  const t0 = performance.now();
  if(video && video.readyState >= 2 && video.videoWidth){
    try{ await step(); }catch(e){ LC.error = e.message; }
    stamps.push(performance.now()); while(stamps.length && stamps[stamps.length-1] - stamps[0] > 3000) stamps.shift();
    LC.fps = stamps.length > 1 ? (stamps.length - 1)/((stamps[stamps.length-1] - stamps[0])/1000) : 0;
  }
  setTimeout(loop, Math.max(0, 1000/LANE_FPS - (performance.now() - t0)));
}

async function step(){
  // 카메라 원본을 16:9 그대로 640×360으로 (화면은 가로가 더 길어 위아래가 잘려 보이지만, 인식은 전체를 본다)
  const vw = video.videoWidth, vh = video.videoHeight;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if(vw/vh > W/H){ sw = vh*W/H; sx = (vw - sw)/2; } else { sh = vw*H/W; sy = (vh - sh)*.6; }   // 세로 화면이면 도로 쪽(아래) 띠
  g.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data, n = W*H;
  for(let i = 0, p = 0; i < n; i++, p += 4){ input[i] = px[p]/255; input[n + i] = px[p+1]/255; input[2*n + i] = px[p+2]/255; }
  const t = performance.now();
  const out = await session.run({images:new window.ort.Tensor('float32', input, [1, 3, H, W])});
  LC.ms = performance.now() - t;
  const ll = out.ll.data, da = out.da.data;
  for(let i = 0; i < n; i++){ lane[i] = ll[n + i] > ll[i] ? 1 : 0; road[i] = da[n + i] > da[i] ? 1 : 0; }
  const r = readLanes(lane, road, px, W, H, cx, 4);
  // 내 차 가운데 맞추기: 양쪽 선이 보이고 차로 가운데쯤일 때 아주 천천히 (대부분 차로 가운데로 달린다는 가정)
  if(r.mid !== null && r.pos > .3 && r.pos < .7){
    cx = Math.min(W*.7, Math.max(W*.3, cx + (r.mid - cx)*.02));
    try{ localStorage.setItem('laneCx', cx.toFixed(1)); }catch(e){}
  }
  const T = tracker.update(r, nLanes);
  Object.assign(LC, {read:r, idx:T.idx, sure:T.sure, changes:T.changes});
}
