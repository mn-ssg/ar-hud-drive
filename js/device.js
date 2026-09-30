/* device.js — 휴대폰 장치: 뒷카메라 · GPS · 화면 꺼짐 방지 */

export async function startCamera(video){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('이 브라우저는 카메라를 쓸 수 없어요. https 주소인지 확인해 주세요.');
  if(video.srcObject) return;
  video.srcObject = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080}}, audio:false});
  await video.play();
}

// GPS 원본을 onFix로 넘긴다. speed·heading은 기기가 안 주면 null (speed.js가 채움)
let watchId = null;
export function watchGPS(onFix, onError){
  if(watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    onFix({lat:c.latitude, lon:c.longitude, acc:c.accuracy, speed:c.speed, heading:c.heading, t:p.timestamp || Date.now()});
  }, onError, {enableHighAccuracy:true, maximumAge:0, timeout:15000});
}

let wake = null;
export async function keepAwake(){
  try{
    if(!navigator.wakeLock || wake) return;
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });   // 다른 앱에 다녀오면 풀린다 → 돌아올 때 다시 요청
  }catch(e){}
}
export function releaseAwake(){ if(wake){ try{ wake.release(); }catch(e){} wake = null; } }
