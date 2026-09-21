// 터치 기반 3점(중심/시작/끝) 선택기.
//  - 한 손가락: 활성 점 배치/드래그 (드래그 중 돋보기 표시)
//  - 두 손가락: 핀치 줌 + 팬
// 점 좌표는 영상 원본 픽셀 좌표계로 저장한다.

export const POINT_COLORS = {
  center: '#f87171',
  start: '#4ade80',
  end: '#60a5fa',
};

const LOUPE_SIZE = 140; // css px
const LOUPE_MAG = 3;    // 현재 화면 배율 대비 추가 확대
const MAX_SCALE = 12;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class Picker {
  constructor({ stage, world, video, overlay, loupe }) {
    this.stage = stage;
    this.world = world;
    this.video = video;
    this.overlay = overlay;
    this.loupe = loupe;
    this.ctx = overlay.getContext('2d');

    this.points = { center: null, start: null, end: null };
    this.activeKey = null;   // 지금 터치로 지정 중인 점
    this.onChange = null;    // (key, point) => void

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.baseW = 0;
    this.baseH = 0;

    this.pointers = new Map();
    this.pinch = null;
    this.dragging = false;

    this._bind();
  }

  _bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this._down(e));
    st.addEventListener('pointermove', (e) => this._move(e));
    st.addEventListener('pointerup', (e) => this._up(e));
    st.addEventListener('pointercancel', (e) => this._up(e));
    window.addEventListener('resize', () => this.fit());
  }

  /** 영상 크기에 맞춰 world를 스테이지에 contain-fit하고 줌을 초기화 */
  fit() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    const s = Math.min(cw / vw, ch / vh);
    this.baseW = vw * s;
    this.baseH = vh * s;
    this.world.style.width = this.baseW + 'px';
    this.world.style.height = this.baseH + 'px';
    if (this.overlay.width !== vw) { this.overlay.width = vw; this.overlay.height = vh; }
    this.scale = 1;
    this.tx = (cw - this.baseW) / 2;
    this.ty = (ch - this.baseH) / 2;
    this._applyTransform();
  }

  setActivePoint(key) { this.activeKey = key; }

  clearPoint(key) { this.points[key] = null; this.draw(); }

  reset({ keepCenter = false } = {}) {
    const center = keepCenter ? this.points.center : null;
    this.points = { center, start: null, end: null };
    this.draw();
  }

  // ---------- 포인터 처리 ----------

  _down(e) {
    e.preventDefault();
    this.stage.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      // 핀치 시작 — 진행 중이던 점 드래그는 중단
      this.dragging = false;
      this._hideLoupe();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d0: dist(a, b), m0: mid(a, b), s0: this.scale, tx0: this.tx, ty0: this.ty };
    } else if (this.pointers.size === 1 && this.activeKey) {
      this.dragging = true;
      this._placeAt(e.clientX, e.clientY);
    }
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this._pinchUpdate(a, b);
    } else if (this.dragging && this.pointers.size === 1) {
      this._placeAt(e.clientX, e.clientY);
    }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.dragging && this.pointers.size === 0) {
      this.dragging = false;
      this._hideLoupe();
    }
  }

  _pinchUpdate(a, b) {
    const { d0, m0, s0, tx0, ty0 } = this.pinch;
    const rect = this.stage.getBoundingClientRect();
    const s = clamp(s0 * dist(a, b) / Math.max(d0, 1), 1, MAX_SCALE);
    const m = mid(a, b);
    // 시작 시 중점 아래에 있던 world 좌표가 현재 중점 아래에 오도록 팬
    const wx = (m0.x - rect.left - tx0) / s0;
    const wy = (m0.y - rect.top - ty0) / s0;
    this.scale = s;
    this.tx = (m.x - rect.left) - wx * s;
    this.ty = (m.y - rect.top) - wy * s;
    this._applyTransform();
  }

  _applyTransform() {
    // world가 스테이지 밖으로 완전히 나가지 않게 클램프 (최소 margin px는 보이게)
    const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
    const w = this.baseW * this.scale, h = this.baseH * this.scale;
    const margin = 40;
    this.tx = clamp(this.tx, margin - w, cw - margin);
    this.ty = clamp(this.ty, margin - h, ch - margin);
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.draw();
  }

  _clientToVideo(cx, cy) {
    const r = this.world.getBoundingClientRect(); // transform 반영된 사각형
    return {
      x: clamp((cx - r.left) / r.width * this.video.videoWidth, 0, this.video.videoWidth),
      y: clamp((cy - r.top) / r.height * this.video.videoHeight, 0, this.video.videoHeight),
    };
  }

  _placeAt(cx, cy) {
    if (!this.activeKey) return;
    const pt = this._clientToVideo(cx, cy);
    this.points[this.activeKey] = pt;
    this.draw();
    this._drawLoupe(pt, cx, cy);
    this.onChange?.(this.activeKey, pt);
  }

  // ---------- 돋보기 ----------

  _drawLoupe(videoPt, cx, cy) {
    const loupe = this.loupe;
    const dpr = window.devicePixelRatio || 1;
    if (loupe.width !== LOUPE_SIZE * dpr) {
      loupe.width = LOUPE_SIZE * dpr;
      loupe.height = LOUPE_SIZE * dpr;
      loupe.style.width = LOUPE_SIZE + 'px';
      loupe.style.height = LOUPE_SIZE + 'px';
    }
    const g = loupe.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

    const r = this.world.getBoundingClientRect();
    const cssPerVid = r.width / this.video.videoWidth; // 현재 화면 배율 포함
    const srcSize = LOUPE_SIZE / (LOUPE_MAG * cssPerVid); // 돋보기에 담길 영상 영역(영상 px)

    g.save();
    g.beginPath();
    g.arc(LOUPE_SIZE / 2, LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#000';
    g.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    try {
      g.drawImage(this.video,
        videoPt.x - srcSize / 2, videoPt.y - srcSize / 2, srcSize, srcSize,
        0, 0, LOUPE_SIZE, LOUPE_SIZE);
    } catch { /* 프레임 미준비 등 */ }
    // 십자선
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 14);
    g.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 + 14);
    g.moveTo(LOUPE_SIZE / 2 - 14, LOUPE_SIZE / 2);
    g.lineTo(LOUPE_SIZE / 2 + 14, LOUPE_SIZE / 2);
    g.stroke();
    g.restore();

    // 테두리 링 — 활성 점 색상
    g.strokeStyle = POINT_COLORS[this.activeKey] || '#fff';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(LOUPE_SIZE / 2, LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 2, 0, Math.PI * 2);
    g.stroke();

    // 손가락 위쪽에 배치 (위 공간이 없으면 아래)
    const srect = this.stage.getBoundingClientRect();
    let lx = cx - srect.left - LOUPE_SIZE / 2;
    let ly = cy - srect.top - LOUPE_SIZE - 30;
    if (ly < 4) ly = cy - srect.top + 30;
    lx = clamp(lx, 4, srect.width - LOUPE_SIZE - 4);
    ly = clamp(ly, 4, srect.height - LOUPE_SIZE - 4);
    loupe.style.left = lx + 'px';
    loupe.style.top = ly + 'px';
    loupe.hidden = false;
  }

  _hideLoupe() { this.loupe.hidden = true; }

  // ---------- 오버레이 렌더링 (영상 픽셀 좌표계) ----------

  draw() {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const { center, start, end } = this.points;
    // 줌 배율에 반비례시켜 화면상 두께를 일정하게 유지
    const k = Math.max(1.5, W / 450) / this.scale;

    const line = (a, b, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = k * 1.4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };

    if (center && start) line(center, start, POINT_COLORS.start);
    if (center && end) line(center, end, POINT_COLORS.end);

    // 두 직선 사이 각도 호
    if (center && start && end) {
      const a1 = Math.atan2(start.y - center.y, start.x - center.x);
      const a2 = Math.atan2(end.y - center.y, end.x - center.x);
      let diff = a2 - a1;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const rad = 0.4 * Math.min(dist(center, start), dist(center, end));
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = k * 1.2;
      ctx.beginPath();
      ctx.arc(center.x, center.y, rad, a1, a1 + diff, diff < 0);
      ctx.stroke();
    }

    for (const key of ['center', 'start', 'end']) {
      const p = this.points[key];
      if (p) this._marker(p, POINT_COLORS[key], k);
    }
  }

  _marker(p, color, k) {
    const ctx = this.ctx;
    const r = k * 9;
    // 흰 후광 + 색 원
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = k * 3.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = k * 1.8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    // 중앙 점 + 십자 틱
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, k * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = k * 1.2;
    ctx.beginPath();
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      ctx.moveTo(p.x + dx * r, p.y + dy * r);
      ctx.lineTo(p.x + dx * (r + k * 5), p.y + dy * (r + k * 5));
    }
    ctx.stroke();
  }
}
