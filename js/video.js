// 비디오 재생/프레임 탐색 컨트롤러.
// requestVideoFrameCallback(rVFC)으로 "실제 표시된 프레임"의 mediaTime을 추적해서
// currentTime의 부정확함(시킹 목표값 ≠ 프레임 경계)을 보정한다.

export class VideoController {
  constructor(video) {
    this.video = video;
    this.encodedFps = 30; // 파일 fps — 감지 후 app.js가 갱신
    this.lastMediaTime = 0;
    this.hasRVFC = typeof video.requestVideoFrameCallback === 'function';
    this.onFrame = null; // (mediaTime) => void — UI 갱신용

    if (this.hasRVFC) {
      const loop = (_now, meta) => {
        this.lastMediaTime = meta.mediaTime;
        this.onFrame?.(meta.mediaTime);
        this.video.requestVideoFrameCallback(loop);
      };
      this.video.requestVideoFrameCallback(loop);
    }

    video.addEventListener('seeked', () => {
      // rVFC가 새 프레임으로 갱신하기 전의 임시값
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

  frameIndex() {
    return Math.max(0, Math.floor(this.getTime() * this.encodedFps + 1e-3));
  }

  totalFrames() {
    const d = this.video.duration;
    return Number.isFinite(d) ? Math.max(1, Math.round(d * this.encodedFps)) : 0;
  }

  /** n프레임 이동 (음수 = 뒤로). 프레임 중앙 시각으로 시킹해 경계 반올림 오류를 피한다. */
  step(n) {
    this.video.pause();
    const idx = Math.max(0, Math.min(this.frameIndex() + n, this.totalFrames() - 1));
    this.seekTo((idx + 0.5) / this.encodedFps);
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
