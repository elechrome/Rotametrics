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
    this.lastMediaTime = 0;
    this.hasRVFC = typeof video.requestVideoFrameCallback === 'function';
    this.onFrame = null; // (mediaTime) => void — UI 갱신용
    this._deltas = [];   // 재생 중 측정한 실제 프레임 간격들
    this._stepping = false;

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
        this.onFrame?.(meta.mediaTime);
        this.video.requestVideoFrameCallback(loop);
      };
      this.video.requestVideoFrameCallback(loop);
    }

    video.addEventListener('seeked', () => {
      // rVFC가 실제 프레임 시각으로 갱신하기 전의 임시값
      this.lastMediaTime = video.currentTime;
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

  frameIndex() {
    return Math.max(0, Math.floor(this.getTime() * this.encodedFps + 1e-3));
  }

  totalFrames() {
    const d = this.video.duration;
    return Number.isFinite(d) ? Math.max(1, Math.round(d * this.encodedFps)) : 0;
  }

  /** n프레임 이동 (음수 = 뒤로). ±1은 실제 프레임 변화를 검증하며 이동. */
  async step(n) {
    if (this._stepping) return; // 진행 중 중복 클릭 무시
    this.video.pause();

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

  /** 정확한 ±1 프레임: mediaTime이 실제로 바뀔 때까지 보폭을 늘리며 최대 3회 시도 */
  async _stepOne(dir) {
    const m0 = this.lastMediaTime;
    const d = this.frameDuration();
    // 앞으로: 다음 프레임 구간 안쪽을 노림 / 뒤로: 현재 프레임 시작 직전(이전 프레임 구간)
    const multipliers = dir > 0 ? [1.1, 1.7, 2.4] : [0.4, 0.9, 1.6];
    for (const k of multipliers) {
      const target = m0 + dir * k * d;
      if (target < 0 || target > this.video.duration) break;
      const m = await this._seekAndSettle(target);
      if (dir > 0 ? m > m0 + 1e-6 : m < m0 - 1e-6) return;
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
        // 미발화 환경 대비 짧은 타임아웃 병행.
        video.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 150);
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
