/* ============================================================
   clrernet.js — CLRerNet(CULane 학습 차선 검출) 출력 → 차선 목록  (화면·엔진과 무관한 순수 계산, Node로 시험)
   · 모델: PINTO 변환본 'no_nms_no_predictions_to_lanes' — 후보 선마다 72줄의 x를 주고, 겹친 후보 거르기(NMS)와 선 만들기는 여기서
   · 출력 xs[N×72]: 아래(0)→위(71) 줄의 x (0~1, 넣은 띠 기준) · anchor[N×3]: 시작 y(0 위 ~ 1 아래) · 시작 x · 각도
     lengths[N]: 선 길이(줄 수) · scores[N]: 선일 확률
   · 원본 코드(hirotomusiker/CLRerNet, Apache-2.0)의 get_lanes · predictions_to_lanes · nms 커널을 그대로 옮김
   ============================================================ */
export const NOFF = 72, NSTR = NOFF - 1;

/* → [{pts:[[x, y], …] (넣은 띠 기준 0~1, 아래→위), score}] 점수 높은 순
   conf: 이보다 낮은 후보는 버림 · topk: 최대 선 수 · nmsPx: 두 후보의 줄마다 x 차이 평균이 이보다(px, 모델 입력 폭 기준) 작으면 같은 선 */
export function decodeLanes(xs, anchor, lengths, scores, {conf = .3, topk = 6, nmsPx = 50, inW = 800} = {}){
  const n = scores.length, cand = [];
  for(let i = 0; i < n; i++) if(scores[i] >= conf) cand.push(i);
  cand.sort((a, b) => scores[b] - scores[a]);
  const st = i => Math.round((1 - anchor[i*3])*NSTR), en = i => Math.trunc(st(i) + lengths[i] - 1 + .5);
  const keep = [];
  for(const i of cand){
    let dup = false;
    for(const j of keep){
      const s = Math.max(st(i), st(j)), e = Math.min(en(i), en(j), NOFF - 1);
      if(e < s) continue;
      let d = 0; for(let k = s; k <= e; k++) d += Math.abs(xs[i*NOFF + k] - xs[j*NOFF + k])*(inW - 1);
      if(d < nmsPx*(e - s + 1)){ dup = true; break; }
    }
    if(!dup) keep.push(i);
    if(keep.length >= topk) break;
  }
  const lanes = [];
  for(const i of keep){
    let start = Math.min(Math.max(0, st(i)), NSTR);
    const end = Math.min(start + Math.round(lengths[i]) - 1, NOFF - 1);
    // 시작점 아래로도 x가 화면 안이면 아래 끝까지 늘린다 (원본 extend_bottom)
    let k = start - 1; while(k >= 0 && xs[i*NOFF + k] >= 0 && xs[i*NOFF + k] <= 1) k--;
    start = k + 1;
    const pts = [];
    for(let r = start; r <= end; r++){ const x = xs[i*NOFF + r]; if(x >= 0 && x <= 1) pts.push([x, 1 - r/NSTR]); }
    if(pts.length >= 2) lanes.push({pts, score:scores[i]});
  }
  return lanes;
}

// 넣은 띠(crop) 기준 좌표 → 카메라 화면 기준(0~1). crop = {y0, y1}: 화면 높이 중 잘라 넣은 세로 범위 (가로는 전체)
export function toFrame(lanes, crop){
  return lanes.map(l => ({score:l.score, pts:l.pts.map(([x, y]) => [x, crop.y0 + y*(crop.y1 - crop.y0)])}));
}
