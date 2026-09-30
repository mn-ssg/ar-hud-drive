/* ============================================================
   speed.js — 속도계
   · GPS가 속도를 주면 그 값(가장 정확), 안 주면 최근 몇 초 동안 움직인 거리로 계산
   · 화면 숫자는 목표값을 부드럽게 따라간다 (1초마다 뚝뚝 바뀌지 않게)
   ============================================================ */
import {distM, bearingLL} from './geo.js';

// fix = {lat, lon, acc, speed, heading, t(ms)} → {v(m/s), heading}
export function createSpeedEstimator(windowMs = 3000){
  const hist = [];
  return function estimate(fix){
    hist.push(fix);
    // hist[0] = 창(windowMs)보다 오래된 것 중 가장 최근 점
    while(hist.length > 2 && fix.t - hist[1].t >= windowMs) hist.shift();
    const a = hist[0], dt = (fix.t - a.t)/1000;
    let moved = null;
    if(dt >= 1){
      const d = distM(a, fix);
      // 서 있어도 GPS 점은 몇 m씩 흔들린다: 오차보다 적게 움직였으면 멈춘 것으로 본다
      moved = d > Math.min(10, (a.acc + fix.acc)/2) ? {v:d/dt, heading:bearingLL(a, fix)} : {v:0, heading:null};
    }
    const v = fix.speed != null && fix.speed >= 0 ? fix.speed : moved ? moved.v : 0;
    const heading = fix.heading != null && fix.heading >= 0 ? fix.heading : moved ? moved.heading : null;
    return {v, heading};
  };
}

// 화면용: 값이 tau(초) 정도에 걸쳐 목표를 따라간다
export function createSmoother(tau = 0.4){
  let val = null, last = 0;
  return function smooth(target, now){
    const dt = last ? (now - last)/1000 : 0; last = now;
    val = val === null ? target : val + (target - val)*(1 - Math.exp(-dt/tau));
    return val;
  };
}
