/* ============================================================
   lab/lane.js — 차선 인식 실험 (spike · 본 앱에는 아직 안 들어감)
   · TwinLiteNet(차선·주행 가능 영역 분할, 1.8MB)을 폰 브라우저에서 돌려 속도와 인식 상태를 본다
   · 테슬라처럼 '신경망으로 선을 찾고 → 시간에 걸쳐 추적'하는 흐름을 폰 카메라 1대 크기로 줄인 것
   · 내 차로 양쪽 선 → 차로 안 위치 · 선을 넘으면 차로 변경 · 왼쪽 선이 노란색이면 1차로 단서
   ============================================================ */
const W = 640, H = 360;                 // 모델 입력 크기
const BAND = 120, STEP = 6;             // 선을 찾는 띠: 보닛 바로 위(도로가 끝나는 줄)부터 위로 120px, 6px마다
const ort = window.ort;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

const $ = s => document.querySelector(s);
const video = $('#video'), view = $('#view'), vctx = view.getContext('2d', {willReadFrequently:true});
const mask = $('#mask'), mctx = mask.getContext('2d'), maskImg = mctx.createImageData(W, H);
const input = new Float32Array(3*W*H), lane = new Uint8Array(W*H), road = new Uint8Array(W*H);
let session = null, running = false, showMask = true, last = null;
let cx = W/2;                           // 화면에서 내 차 가운데. 폰이 대시보드 가운데가 아니면 '가운데 맞추기'
try{ const c = parseFloat(localStorage.getItem('laneCx')); if(c > 0 && c < W) cx = c; }catch(e){}

const say = (t, bad) => { $('#msg').textContent = t; $('#msg').classList.toggle('bad', !!bad); };

async function loadModel(){
  if(session) return;
  say('모델 불러오는 중…');
  for(const ep of ['webgpu', 'wasm']){
    try{
      session = await ort.InferenceSession.create('twinlite.onnx', {executionProviders:[ep], graphOptimizationLevel:'all'});
      $('#backend').textContent = ep === 'webgpu' ? 'WebGPU (그래픽칩)' : 'WASM (CPU)';
      return;
    }catch(e){ console.warn(ep, e); }
  }
  throw new Error('모델을 불러오지 못했어요');
}

// 영상에서 16:9 띠를 잘라 640×360으로. 세로 화면이면 가운데보다 조금 아래(도로 쪽) 띠
function grab(){
  const vw = video.videoWidth, vh = video.videoHeight; if(!vw) return false;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if(vw/vh > W/H){ sw = vh*W/H; sx = (vw - sw)/2; } else { sh = vw*H/W; sy = (vh - sh)*0.6; }
  vctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  return true;
}

async function infer(){
  const px = vctx.getImageData(0, 0, W, H).data, n = W*H;
  for(let i = 0, p = 0; i < n; i++, p += 4){ input[i] = px[p]/255; input[n + i] = px[p+1]/255; input[2*n + i] = px[p+2]/255; }
  const t0 = performance.now();
  const out = await session.run({images:new ort.Tensor('float32', input, [1, 3, H, W])});
  const ms = performance.now() - t0, ll = out.ll.data, da = out.da.data;
  for(let i = 0; i < n; i++){ lane[i] = ll[n + i] > ll[i] ? 1 : 0; road[i] = da[n + i] > da[i] ? 1 : 0; }
  return {px, ms};
}

// 노란 중앙선: 색상 25~65°, 채도 0.25↑, 밝기 0.35↑ (햇빛에 바랜 노랑도 잡히게. 흰 선은 채도가 낮아 걸러짐)
function isYellow(r, g, b){
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx/255, sat = mx ? (mx - mn)/mx : 0;
  if(v < .35 || sat < .25 || mx !== r && mx !== g) return false;
  const h = mx === r ? 60*((g - b)/(mx - mn || 1)) : 60*(2 + (b - r)/(mx - mn || 1));
  return h >= 25 && h <= 65;
}

// 보닛 위 도로가 끝나는 줄: 내 차 가운데 세로줄에서 아래부터 올라가며 처음 '달릴 수 있는 곳'이 나오는 곳
// (폰 거치 높이·보닛이 보이는 정도가 달라도 선 찾는 띠가 따라간다)
function roadBottom(){
  const x0 = Math.round(cx);
  for(let y = H - 1; y > H/2; y--){ let c = 0; for(let dx = -20; dx <= 20; dx += 5) c += road[y*W + x0 + dx] || 0; if(c >= 5) return y; }
  return H - 10;
}

// 줄마다 차선 픽셀 덩어리 → 내 차 가운데(cx) 바로 왼쪽·오른쪽 선
function analyze(px){
  const rows = [], bottom = roadBottom(), ys = [];
  for(let y = bottom - 4; y > bottom - 4 - BAND && y > 0; y -= STEP) ys.push(y);
  let yellow = 0, sampled = 0, leftN = 0, rightN = 0;
  for(const y of ys){
    let L = -1, R = -1, start = -1, l0 = 0, l1 = 0;
    for(let x = 0; x <= W; x++){
      const on = x < W && lane[y*W + x];
      if(on && start < 0) start = x;
      if(!on && start >= 0){
        if(x - start <= 40){ const c = (start + x - 1)/2; if(c < cx && c > L){ L = c; l0 = start; l1 = x - 1; } if(c >= cx && (R < 0 || c < R)) R = c; }
        start = -1;
      }
    }
    if(L >= 0){   // 왼쪽 선 폭 전체를 훑어 노란 픽셀 비율을 모은다 (선 주변 아스팔트가 섞여서 한 점만 보면 놓침)
      leftN++;
      for(let x = l0; x <= l1; x++){ const p = (y*W + x)*4; sampled++; if(isYellow(px[p], px[p+1], px[p+2])) yellow++; }
    }
    if(R >= 0) rightN++;
    rows.push({y, L, R});
  }
  // 차로 안 위치: 0 = 왼쪽 선 위, 1 = 오른쪽 선 위 (아래쪽 줄들의 중앙값)
  const near = ys[0] - BAND/2;           // 띠의 아래쪽 절반(차에 가까운 쪽)으로 차로 안 위치를 잰다
  const pos = rows.filter(r => r.L >= 0 && r.R >= 0 && r.y >= near).map(r => (cx - r.L)/(r.R - r.L)).sort((a, b) => a - b);
  const kind = n => n/ys.length > .85 ? '실선' : n/ys.length > .3 ? '점선' : null;   // 이어진 정도로 추정
  return {rows, bottom, pos:pos.length ? pos[pos.length >> 1] : null,
    left:leftN >= 4, right:rightN >= 4, leftKind:kind(leftN), rightKind:kind(rightN), leftYellow:leftN >= 4 && yellow/sampled > .1};
}

// 선을 넘은 순간 = 차로 변경. 오른쪽 선에 붙어 있다가(0.75↑) 바로 다음에 왼쪽 선 근처(0.25↓)면 오른쪽으로 옮긴 것
let changes = 0, prevPos = null;
function track(a){
  if(a.pos === null){ return; }
  if(prevPos !== null){
    if(prevPos > .7 && a.pos < .3){ changes++; $('#lastChange').textContent = '→ 오른쪽으로 · ' + new Date().toLocaleTimeString(); }
    if(prevPos < .3 && a.pos > .7){ changes++; $('#lastChange').textContent = '← 왼쪽으로 · ' + new Date().toLocaleTimeString(); }
  }
  prevPos = a.pos;
  $('#changes').textContent = changes;
}

function drawMask(a){
  if(!showMask){ mctx.clearRect(0, 0, W, H); return; }
  const d = maskImg.data;
  for(let i = 0, p = 0; i < W*H; i++, p += 4){
    if(lane[i]){ d[p] = 255; d[p+1] = 60; d[p+2] = 60; d[p+3] = 230; }
    else if(road[i]){ d[p] = 60; d[p+1] = 220; d[p+2] = 132; d[p+3] = 60; }
    else d[p+3] = 0;
  }
  mctx.putImageData(maskImg, 0, 0);
  mctx.lineWidth = 2; mctx.setLineDash([6, 6]); mctx.strokeStyle = 'rgba(255,255,255,.7)';
  mctx.beginPath(); mctx.moveTo(cx, a.bottom - BAND); mctx.lineTo(cx, a.bottom); mctx.stroke(); mctx.setLineDash([]);
  a.rows.forEach(r => {
    if(r.L >= 0){ mctx.fillStyle = a.leftYellow ? '#ffd400' : '#46e6ff'; mctx.fillRect(r.L - 3, r.y - 3, 6, 6); }
    if(r.R >= 0){ mctx.fillStyle = '#46e6ff'; mctx.fillRect(r.R - 3, r.y - 3, 6, 6); }
  });
}

const times = [], stamps = [];
function show(a, ms){
  times.push(ms); if(times.length > 20) times.shift();
  const now = performance.now(); stamps.push(now); while(stamps.length && now - stamps[0] > 1000) stamps.shift();
  $('#fps').textContent = stamps.length + ' fps';
  $('#ms').textContent = '모델 ' + Math.round(times.reduce((s, x) => s + x, 0)/times.length) + 'ms / 프레임';
  $('#lines').textContent = (a.left ? '왼쪽 ✓' : '왼쪽 ✗') + '  ' + (a.right ? '오른쪽 ✓' : '오른쪽 ✗');
  $('#types').textContent = [a.left ? '왼쪽 ' + (a.leftYellow ? '노란선 → 1차로 단서' : a.leftKind || '') : '', a.right ? '오른쪽 ' + (a.rightKind || '') : ''].filter(Boolean).join(' · ') || '–';
  if(a.pos !== null) $('#posDot').style.left = Math.max(0, Math.min(100, a.pos*100)) + '%';
}

async function loop(){
  if(!running) return;
  if(video.readyState >= 2 && !video.paused && grab()){
    try{ const r = await infer(), a = analyze(r.px); last = a; track(a); drawMask(a); show(a, r.ms); }
    catch(e){ say('인식 오류: ' + e.message, true); running = false; return; }
  }
  requestAnimationFrame(loop);
}
function start(){ say('인식 중 · 빨강 = 차선, 초록 = 달릴 수 있는 곳, 점 = 내 차로 양쪽 선'); if(!running){ running = true; loop(); } }

$('#camBtn').addEventListener('click', async () => {
  try{
    await loadModel();
    video.removeAttribute('src');
    video.srcObject = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}, audio:false});
    await video.play(); start();
  }catch(e){ say('카메라를 켜지 못했어요: ' + e.message, true); }
});
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  try{
    await loadModel();
    if(video.srcObject){ video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    video.src = URL.createObjectURL(f); video.loop = true;
    await video.play(); start();
  }catch(err){ say('영상을 열지 못했어요: ' + err.message, true); }
});
// 내 차로 가운데를 달리는 중에 누르면, 지금 양쪽 선 가운데를 내 차 위치로 삼는다
$('#centerBtn').addEventListener('click', () => {
  const r = last && last.rows.filter(r => r.L >= 0 && r.R >= 0 && r.y >= last.bottom - BAND/2);
  if(!r || !r.length){ say('양쪽 선이 다 보일 때 눌러 주세요', true); return; }
  cx = r.reduce((s, x) => s + (x.L + x.R)/2, 0)/r.length;
  try{ localStorage.setItem('laneCx', cx); }catch(e){}
  say('내 차 가운데를 맞췄어요 (' + Math.round(cx) + 'px)');
});
$('#maskBtn').addEventListener('click', e => { showMask = !showMask; e.target.textContent = showMask ? '표시 끄기' : '표시 켜기'; });
