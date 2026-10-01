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
// 회전 '완료'는 회전 지점을 지난 뒤 DONE_WAIT ms 안에 경로를 따라가고 있을 때만: 경로선 DONE_OFF m 안 + 진행 방향이 경로와 DONE_ANG° 안
// (유턴 안내에서 직진했는데 '완료'가 뜬 문제, E17)
export const DONE_WAIT = 3000, DONE_OFF = 15, DONE_ANG = 45;

/* ---------- 도로 · 차선 ---------- */
export const LANE_W = 3.5;            // 차로 폭(m)
export const DEFAULT_LANES = 3;       // 차선 수를 모르는 구간의 미니 도로 모양 (예전과 같은 3차로)
export const MAX_LANES = 8;
export const RUN_MIN_M = 25;          // 제한속도·차선 수가 이보다 짧게(m) 바뀌는 조각은 무시 (교차로 안 잡음)

/* ---------- 갈림 · 합류 (junctions.js · 노드링크 도로 연결로 찾음) ---------- */
export const FORK_LEAD = 400;         // 갈림 이 거리(m) 앞부터 ① '↖ 유지 / ↗ 유지' (D31: 아이콘 = 갈 방향)
export const MERGE_LEAD = 250;        // 합류 이 거리(m) 앞부터 ①에 '합류'(내가 들어감) / '합류 주의'(다른 길이 들어옴)
export const JCT_DRAW = 300;          // 이 거리(m) 안의 갈림 · 합류는 미니 도로에 다른 길을 그린다
export const JCT_TMAP_M = 120;        // TMAP 안내 지점이 이 거리(m) 안에 있으면 ①은 TMAP 안내를 따른다

/* ---------- TMAP 차로 안내 (turnType 52 왼쪽 차선 · 53 오른쪽 차선 · 54~63 1~10차선) ---------- */
export const LANE_LEAD = 300;         // 차로 안내 지점 이 거리(m) 앞부터 ① 글자 + 미니 도로에 갈 차로 칠하기

/* ---------- 카메라 차선 인식 (lanecam.js · laneread.js) ---------- */
export const LANE_FPS = 5;            // 초당 최대 몇 번 차선을 읽나 (폰이 느리면 저절로 줄어듦)
export const ROAD_SMALL = .15;        // 화면 높이 중 도로가 이보다 작게 보이면 '폰을 조금 아래로' 안내

/* ---------- 화면 ---------- */
export const HUD_FPS = 30;            // HUD를 초당 다시 그리는 횟수. 휴대폰 발열·끊김을 줄인다
export const C = {NOW:'#46e6ff', GO:'#3ddc84', WARN:'#ffb020', DANGER:'#ff4d4d'};
