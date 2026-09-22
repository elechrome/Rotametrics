// 각도/각속도 계산 — 순수 함수 모듈 (브라우저/Node 공용)

/**
 * 중심(center)에서 p1, p2로 향하는 두 벡터 사이의 부호 있는 각도(deg).
 * 범위 (-180, 180]. 이미지 좌표계(y축 아래 방향) 기준이므로
 * 양수 = 화면상 시계방향, 음수 = 반시계방향.
 */
export function signedAngleDeg(center, p1, p2) {
  const v1x = p1.x - center.x, v1y = p1.y - center.y;
  const v2x = p2.x - center.x, v2y = p2.y - center.y;
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  return Math.atan2(cross, dot) * 180 / Math.PI;
}

/**
 * 측정값 계산.
 * @param {object} p
 * @param {{x,y}} p.center      회전 중심 (영상 픽셀 좌표)
 * @param {{x,y}} p.startPoint  시작 지점
 * @param {{x,y}} p.endPoint    끝 지점
 * @param {number} p.tStart     시작 프레임의 미디어 시각 (s, 파일 타임라인 기준)
 * @param {number} p.tEnd       끝 프레임의 미디어 시각 (s)
 * @param {number} p.encodedFps 파일에 인코딩된 fps (프레임 수 환산용)
 * @param {number} p.captureFps 실제 촬영 fps (실제 시간 환산용)
 * @param {number} [p.dFrames]  정확한 경과 프레임 수 (프레임 표 기반, 없으면 평균 fps로 환산)
 */
export function computeMeasurement({ center, startPoint, endPoint, tStart, tEnd, encodedFps, captureFps, dFrames: dFramesIn }) {
  const signed = signedAngleDeg(center, startPoint, endPoint);
  const angleDeg = Math.abs(signed);
  const direction = signed === 0 ? '-' : (signed > 0 ? '시계방향' : '반시계방향');
  const dFrames = dFramesIn != null
    ? Math.abs(dFramesIn)
    : Math.abs(Math.round((tEnd - tStart) * encodedFps));
  // 실제 경과 시간(s):
  //  - 촬영 fps = 파일 fps → 파일 타임라인이 곧 실제 시간이므로 시각 차이를 그대로 사용
  //    (VFR 파일에서 프레임 수 × 평균 간격 환산으로 생기는 오차 제거)
  //  - 촬영 fps ≠ 파일 fps (슬로우모션 변환본) → 프레임 수를 촬영 fps로 환산
  const dt = captureFps === encodedFps
    ? Math.abs(tEnd - tStart)
    : dFrames / captureFps;
  const omega = dt > 0 ? angleDeg / dt : NaN;
  return { signed, angleDeg, direction, dFrames, dt, omega };
}
