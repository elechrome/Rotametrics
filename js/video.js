// 비디오 재생/프레임 탐색 컨트롤러.
// requestVideoFrameCallback(rVFC)으로 "실제 표시된 프레임"의 mediaTime을 추적한다.
//
// 프레임 스텝은 산술 계산(현재시각 ± n/fps)만으로는 신뢰할 수 없다:
// 아이폰 영상은 VFR(가변 프레임레이트)인 경우가 많아 목표 시각이 같은 프레임
// 구간에 떨어지거나(움직임 없음) 두 프레임을 건너뛸 수 있다. 그래서 ±1 스텝은
// 시킹 후 실제 mediaTime이 바뀌었는지 검증하고, 안 바뀌었으면 보폭을 늘려 재시도한다.

export class VideoController {
  constructor(video) {
    this.video = video;
    this.encodedFps = 30; // 파일 fps — 감지 후 app.js가 갱신
    this.frameTimes = null; // 모든 프레임의 표시 시각 표 (메타데이터에서 추출 성공 시)
    this.lastMediaTime = 0;
    this.hasRVFC = typeof video.requestVideoFrameCallback === 'function';
    this.onFrame = null; // (mediaTime) => void — UI 갱신용
    this._deltas = [];   // 재생 중 측정한 실제 프레임 간격들
    this._stepping = false;
    this._pendingIdx = null; // 표 기반 스텝의 연타 대응용 목표 인덱스
    this._lastPresented = -1; // rVFC가 보고한 "실제 표시된 프레임"의 시각 (seeked로 오염되지 않음)

    if (this.hasRVFC) {
      let prev = null;
      const loop = (_now, meta) => {
        if (prev !== null && !this.video.paused) {
          const d = meta.mediaTime - prev;
          if (d > 1e-5 && d < 0.5) {
            this._deltas.push(d);
            if (this._deltas.length > 30) this._deltas.shift();
          }
        }
        prev = meta.mediaTime;
        this.lastMediaTime = meta.mediaTime;
        this._lastPresented = meta.mediaTime;
        this.onFrame?.(meta.mediaTime);
        this.video.requestVideoFrameCallback(loop);
      };
      this.video.requestVideoFrameCallback(loop);
    }

    video.addEventListener('seeked', () => {
      // rVFC가 실제 프레임 시각으로 갱신하기 전의 임시값
      this.lastMediaTime = video.currentTime;
      this._pendingIdx = null;
      this.onFrame?.(this.getTime());
    });
    video.addEventListener('timeupdate', () => {
      if (!this.hasRVFC) this.onFrame?.(video.currentTime);
    });
  }

  /** 현재 표시 중인 프레임의 미디어 시각(s) */
  getTime() {
    return this.hasRVFC ? this.lastMediaTime : this.video.currentTime;
  }

  /** 실측 프레임 간격(중앙값). 실측치가 없으면 1/encodedFps. */
  frameDuration() {
    if (this._deltas.length >= 5) {
      const sorted = [...this._deltas].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    return 1 / this.encodedFps;
  }

  /** 프레임 표 설정 (null이면 산술 방식으로 폴백) */
  setFrameTable(times) {
    this.frameTimes = times && times.length ? times : null;
    this._pendingIdx = null;
  }

  /** 시각 t가 속한 프레임 번호 */
  frameIndexAt(t) {
    const ft = this.frameTimes;
    if (!ft) return Math.max(0, Math.floor(t * this.encodedFps + 1e-3));
    // 이진 탐색: ft[i] <= t 인 마지막 i
    const tt = t + 1e-4;
    let lo = 0, hi = ft.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ft[mid] <= tt) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  frameIndex() {
    return this.frameIndexAt(this.getTime());
  }

  totalFrames() {
    if (this.frameTimes) return this.frameTimes.length;
    const d = this.video.duration;
    return Number.isFinite(d) ? Math.max(1, Math.round(d * this.encodedFps)) : 0;
  }

  /** 프레임 idx의 중앙 시각 — 여기로 시킹하면 반올림 오차 없이 해당 프레임이 표시됨 */
  _frameMidTime(idx) {
    const ft = this.frameTimes;
    const t0 = ft[idx];
    const t1 = idx + 1 < ft.length ? ft[idx + 1] : t0 + this.frameDuration();
    return (t0 + t1) / 2;
  }

  /** n프레임 이동 (음수 = 뒤로) */
  async step(n) {
    this.video.pause();

    // 프레임 표가 있으면 정확한 좌표로 단번에 이동 (연타는 pendingIdx로 누적)
    if (this.frameTimes) {
      const base = this._pendingIdx ?? this.frameIndex();
      const idx = Math.max(0, Math.min(base + n, this.frameTimes.length - 1));
      this._pendingIdx = idx;
      this.seekTo(this._frameMidTime(idx));
      return;
    }

    if (this._stepping) return; // 진행 중 중복 클릭 무시

    if (!this.hasRVFC) {
      // 폴백: 산술 이동 (프레임 중앙 시각으로)
      const idx = Math.max(0, Math.min(this.frameIndex() + n, this.totalFrames() - 1));
      this.seekTo((idx + 0.5) / this.encodedFps);
      return;
    }

    this._stepping = true;
    try {
      if (Math.abs(n) === 1) {
        await this._stepOne(Math.sign(n));
      } else {
        // 다중 스텝은 산술 이동으로 충분 (오차 ±1프레임 허용)
        const d = this.frameDuration();
        await this._seekAndSettle(this.lastMediaTime + n * d + 0.5 * d * Math.sign(n));
      }
    } finally {
      this._stepping = false;
    }
  }

  /** 정확한 ±1 프레임: "실제로 새 프레임이 표시됨"(rVFC 보고)이 확인될 때까지 보폭 확대 재시도.
   *  시킹 목표 시각(seeked의 currentTime)으로 판정하면 긴 프레임(VFR) 위에서
   *  이동하지 않았는데 성공으로 오판한다 — 반드시 _lastPresented로만 검증. */
  async _stepOne(dir) {
    const p0 = this._lastPresented;
    const m0 = p0 >= 0 ? p0 : this.lastMediaTime;
    const d = this.frameDuration();
    // VFR에서 평균보다 3배 긴 프레임(예: 60fps 기준 50ms)도 넘을 수 있는 보폭 시퀀스
    const multipliers = dir > 0 ? [1.1, 2.1, 3.2, 4.3] : [0.4, 1.2, 2.3, 3.4];
    for (const k of multipliers) {
      const target = m0 + dir * k * d;
      if (target < 0 || target > this.video.duration) break;
      await this._seekAndSettle(target);
      const p = this._lastPresented;
      if (p !== p0 && (dir > 0 ? p > m0 + 1e-6 : p < m0 - 1e-6)) return;
    }
  }

  /** 시킹 후 seeked + rVFC(실제 프레임 시각 갱신)까지 대기하고 lastMediaTime 반환 */
  _seekAndSettle(t) {
    return new Promise((resolve) => {
      const video = this.video;
      let done = false;
      let safety = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        video.removeEventListener('seeked', onSeeked);
        resolve(this.lastMediaTime);
      };
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        // 일시정지 상태의 시킹에서도 새 프레임 표시 시 rVFC가 발화한다.
        // 미발화(같은 프레임 유지) 판정 대기 — 길수록 안전하지만 +1 재시도 지연이 체감됨.
        video.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 140);
      };
      video.addEventListener('seeked', onSeeked);
      safety = setTimeout(finish, 500); // seeked 자체가 안 오는 경우 안전망
      this.seekTo(t);
    });
  }

  seekTo(t) {
    const d = this.video.duration;
    if (!Number.isFinite(d)) return;
    this.video.currentTime = Math.max(0, Math.min(t, d - 1e-4));
  }

  togglePlay() {
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }
}
