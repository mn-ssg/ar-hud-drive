/* ============================================================
   config.js — 안내 기준 · 색 · 외부 주소
   숫자만 바꿔서 동작을 조정할 수 있게 한곳에 모았다
   ============================================================ */

export const TMAP = 'https://apis.openapi.sk.com/tmap';
// OSM 차선 정보: 공개 서버가 자주 바빠서 앞에서부터 차례로 시도한다
export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

/* ---------- 안내 기준 ---------- */
export const NEAR = 60;               // 회전 지점 이 거리(m) 안이면 실제 동작(좌회전·우회전…)을 보여준다
export const PASS = 15;               // 회전 지점을 이만큼(m) 지나면 '완료'
export const OFF_ROUTE = 40;          // 경로 선에서 이만큼(m) 벗어난 채
export const OFF_ROUTE_MS = 4000;     //   이 시간이 지나면 경로를 다시 받는다
export const REROUTE_GAP_MS = 15000;  // 경로를 다시 받는 최소 간격
export const SIM_KMH = 40;            // 가상 주행 속도

/* ---------- 도로 · 차선 ---------- */
export const LANE_W = 3.5;            // 차로 폭(m)
export const DEFAULT_LANES = 3;       // 차선 수를 모르는 구간의 미니 도로 모양 (예전과 같은 3차로)
export const MAX_LANES = 8;
export const RUN_MIN_M = 25;          // 제한속도·차선 수가 이보다 짧게(m) 바뀌는 조각은 무시 (교차로 안 잡음)

/* ---------- 화면 ---------- */
export const HUD_FPS = 30;            // HUD를 초당 다시 그리는 횟수. 휴대폰 발열·끊김을 줄인다
export const C = {NOW:'#46e6ff', GO:'#3ddc84', WARN:'#ffb020', DANGER:'#ff4d4d'};
