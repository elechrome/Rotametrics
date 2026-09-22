import { VideoController } from './video.js';
import { detectEncodedFps, estimateFpsByPlayback, fileReader, snapFps } from './fps.js';
import { Picker } from './picker.js';
import { computeMeasurement } from './measure.js';
import * as history from './history.js';

const APP_VERSION = 'v13'; // sw.js의 CACHE 버전과 함께 올릴 것

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  screenLoad: $('screen-load'),
  screenMeasure: $('screen-measure'),
  fileInput: $('file-input'),
  video: $('video'),
  stage: $('stage'),
  world: $('world'),
  overlay: $('overlay'),
  loupe: $('loupe'),
  encodedFpsValue: $('encoded-fps-value'),
  encodedFpsSelect: $('encoded-fps-select'),
  captureFpsSelect: $('capture-fps-select'),
  captureFpsCustom: $('capture-fps-custom'),
  fpsHint: $('fps-hint'),
  scrub: $('scrub'),
  btnPlay: $('btn-play'),
  btnB10: $('btn-b10'),
  btnB1: $('btn-b1'),
  btnF1: $('btn-f1'),
  btnF10: $('btn-f10'),
  frameLabel: $('frame-label'),
  stepText: $('step-text'),
  stepChips: $('step-chips'),
  stepStatus: $('step-status'),
  btnBack: $('btn-back'),
  btnConfirm: $('btn-confirm'),
  resultCard: $('result-card'),
  resOmega: $('res-omega'),
  resAngle: $('res-angle'),
  resDir: $('res-dir'),
  resFrames: $('res-frames'),
  resDt: $('res-dt'),
  resFps: $('res-fps'),
  btnSave: $('btn-save'),
  btnNew: $('btn-new'),
  btnNewSame: $('btn-new-same'),
  historyList: $('history-list'),
  btnExport: $('btn-export'),
  btnChangeVideo: $('btn-change-video'),
};

// ---------- 상태 ----------
const state = {
  file: null,
  url: null,
  encodedFps: null,      // 파일 fps
  encodedSource: null,   // 'metadata' | 'playback' | 'manual'
  timing: null,          // 프레임 간격 균일도 {uniformRatio, minFps, maxFps}
  step: 'center',        // 'center' | 'start' | 'end' | 'done'
  tStart: null,
  tEnd: null,
  startFrame: null,
  endFrame: null,
  result: null,
  saved: false,
  scrubbing: false,
};

const STEP_DEFS = {
  center: {
    text: '① 회전 중심을 터치로 지정하세요. 한 손가락 드래그로 미세 조정, 두 손가락으로 확대/이동합니다.',
    confirm: '중심 확정',
    point: 'center',
  },
  start: {
    text: '② 시작 프레임으로 이동한 뒤, 회전 시작 지점을 터치로 지정하세요. 확정 시 현재 프레임이 시작 시각으로 기록됩니다.',
    confirm: '시작점 확정',
    point: 'start',
  },
  end: {
    text: '③ 끝 프레임으로 이동한 뒤, 회전 끝 지점을 터치로 지정하세요. 확정 시 각속도를 계산합니다.',
    confirm: '끝점 확정 · 계산',
    point: 'end',
  },
  done: {
    text: '측정 완료 — 결과를 저장하거나 새 측정을 시작하세요.',
    confirm: null,
    point: null,
  },
};

const videoCtl = new VideoController(els.video);
const picker = new Picker({
  stage: els.stage,
  world: els.world,
  video: els.video,
  frame: document.getElementById('framecanvas'),
  overlay: els.overlay,
  loupe: els.loupe,
});
picker.onChange = () => render();

// ---------- 동영상 로드 ----------

els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 같은 파일 재선택 허용
  if (file) await loadVideo(file);
});

els.btnChangeVideo.addEventListener('click', () => els.fileInput.click());

function waitMetadata(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });
}

async function loadVideo(file) {
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.url = URL.createObjectURL(file);
  state.encodedFps = null;
  state.encodedSource = null;
  state.timing = null;
  videoCtl.setFrameTable(null);
  resetMeasurement({ keepCenter: false });

  els.video.src = state.url;
  els.screenLoad.hidden = true;
  els.screenMeasure.hidden = false;
  els.encodedFpsValue.textContent = '감지 중…';
  els.encodedFpsValue.classList.remove('warn');
  els.encodedFpsSelect.hidden = true;

  try {
    await waitMetadata(els.video);
  } catch {
    alert('이 동영상을 재생할 수 없습니다. 다른 파일을 선택해주세요.');
    els.screenLoad.hidden = false;
    els.screenMeasure.hidden = true;
    return;
  }

  els.scrub.max = els.video.duration;
  els.scrub.value = 0;
  picker.fit();
  setStep('center');
  // 첫 프레임 즉시 표시 — 잠깐 재생해 프레임이 그려진 것을 확인 후 정지
  // (재생 없이는 iOS가 첫 프레임을 디코드하지 않아 검은 화면으로 남음)
  await showFirstFrame();

  // FPS 감지: 메타데이터 → 재생 추정 → 수동
  let det = await detectEncodedFps(fileReader(file));
  if (!det) det = await estimateFpsByPlayback(els.video).catch(() => null);
  if (det) {
    state.timing = det.timing || null;
    videoCtl.setFrameTable(det.frameTimes || null); // 프레임 시각 표 → 정확한 탐색/계산
    setEncodedFps(snapFps(det.fps), det.source);
  } else {
    state.encodedFps = null;
    state.encodedSource = null;
    renderFps();
  }
  render();
}

/** 프레임이 실제로 그려질 때까지 대기. 그려지면 true. */
function waitFramePainted(timeoutMs) {
  const v = els.video;
  return new Promise((resolve) => {
    if (typeof v.requestVideoFrameCallback !== 'function') {
      setTimeout(() => resolve(true), 150); // 확인 불가 환경 — 낙관적으로 진행
      return;
    }
    let done = false;
    v.requestVideoFrameCallback(() => { if (!done) { done = true; resolve(true); } });
    setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
  });
}

/** 첫 프레임 강제 표시: ①음소거 재생 → ②실패 시 시킹 폴백(0.05s, 0.2s) */
async function showFirstFrame() {
  const v = els.video;
  try {
    await v.play(); // muted + playsinline
    const painted = await waitFramePainted(500);
    v.pause();
    if (painted) return;
  } catch {
    v.pause(); // 자동재생 차단(iOS 홈화면 앱 등) → 시킹 폴백으로
  }
  for (const t of [0.05, 0.2]) {
    videoCtl.seekTo(t);
    if (await waitFramePainted(500)) return;
  }
}

// ---------- FPS UI ----------

const SOURCE_LABEL = { metadata: '자동 감지', playback: '재생 추정', manual: '수동' };

function setEncodedFps(fps, source) {
  state.encodedFps = fps;
  state.encodedSource = source;
  videoCtl.encodedFps = fps;
  els.scrub.step = String(1 / fps);
  renderFps();
  render();
}

function renderFps() {
  const v = els.encodedFpsValue;
  const t = state.timing;
  const isVfr = t && t.uniformRatio < 0.98;
  if (state.encodedFps) {
    v.textContent = `${state.encodedFps} `;
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = `(${SOURCE_LABEL[state.encodedSource] || ''})`;
    v.appendChild(src);
    // 고정/가변 프레임 배지 (메타데이터 분석이 가능했던 경우)
    if (t) {
      const badge = document.createElement('span');
      badge.className = 'badge ' + (isVfr ? 'warn' : 'ok');
      badge.textContent = isVfr
        ? `가변 ${t.minFps.toFixed(0)}~${t.maxFps.toFixed(0)}fps`
        : '고정';
      v.appendChild(badge);
    }
    v.classList.remove('warn');
  } else {
    v.textContent = '감지 실패';
    v.classList.add('warn');
    els.encodedFpsSelect.hidden = false;
  }

  // 힌트
  let hint = '';
  if (!state.encodedFps) {
    hint = '파일 FPS를 직접 선택해주세요. 프레임 이동과 시간 계산에 필요합니다.';
  } else if (isVfr) {
    hint = '⚠️ 프레임 간격이 가변인 영상입니다. 촬영 FPS를 "파일과 동일"로 두면 시간 계산은 정확하지만, '
      + '정밀 측정에는 밝은 조명에서 고정 fps(자동 FPS 끔)로 촬영한 영상을 권장합니다.';
  } else if (state.encodedFps >= 100) {
    hint = '고속 촬영(슬로우모션 원본) 파일로 감지되었습니다. 촬영 FPS가 같다면 그대로 두세요.';
  } else {
    hint = '슬로우모션을 일반 파일로 내보낸 경우(재생이 실제보다 느린 경우), 촬영 FPS를 실제 값(예: 240)으로 선택하세요.';
  }
  els.fpsHint.textContent = hint;
  els.fpsHint.hidden = !hint;
}

// 감지된 값을 터치하면 수동 선택으로 전환
els.encodedFpsValue.addEventListener('click', () => {
  els.encodedFpsSelect.hidden = false;
  if (state.encodedFps) els.encodedFpsSelect.value = String(state.encodedFps);
});

els.encodedFpsSelect.addEventListener('change', () => {
  const v = parseFloat(els.encodedFpsSelect.value);
  if (v > 0) setEncodedFps(v, 'manual');
});

els.captureFpsSelect.addEventListener('change', () => {
  els.captureFpsCustom.hidden = els.captureFpsSelect.value !== 'custom';
  render();
});
els.captureFpsCustom.addEventListener('input', render);

function getCaptureFps() {
  const sel = els.captureFpsSelect.value;
  if (sel === 'same') return state.encodedFps;
  if (sel === 'custom') {
    const v = parseFloat(els.captureFpsCustom.value);
    return v > 0 ? v : null;
  }
  const v = parseFloat(sel);
  return v > 0 ? v : null;
}

// ---------- 트랜스포트 ----------

// 시킹 완료 후 프레임 캔버스를 여러 번 갱신 — 디코더가 늦게 준비되거나
// rVFC가 발화하지 않는 iOS 상황에서도 새 프레임이 반드시 표시되도록
els.video.addEventListener('seeked', () => {
  picker.drawVideoFrame();
  setTimeout(() => picker.drawVideoFrame(), 80);
  setTimeout(() => picker.drawVideoFrame(), 250);
});

els.btnPlay.addEventListener('click', () => videoCtl.togglePlay());
els.video.addEventListener('play', () => {
  els.btnPlay.textContent = '❚❚';
  // rVFC 미지원 환경: 재생 중에는 rAF로 프레임 캔버스를 갱신
  if (!videoCtl.hasRVFC) {
    const loop = () => {
      if (els.video.paused || els.video.ended) return;
      picker.drawVideoFrame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
});
els.video.addEventListener('pause', () => { els.btnPlay.textContent = '▶'; });

els.btnB10.addEventListener('click', () => videoCtl.step(-10));
els.btnB1.addEventListener('click', () => videoCtl.step(-1));
els.btnF1.addEventListener('click', () => videoCtl.step(1));
els.btnF10.addEventListener('click', () => videoCtl.step(10));

els.scrub.addEventListener('pointerdown', () => { state.scrubbing = true; });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  els.scrub.addEventListener(ev, () => { state.scrubbing = false; });
}
els.scrub.addEventListener('input', () => {
  els.video.pause();
  videoCtl.seekTo(parseFloat(els.scrub.value));
});

videoCtl.onFrame = (t) => {
  picker.drawVideoFrame(); // 프레임이 준비될 때마다 캔버스에 직접 표시
  if (!state.scrubbing) els.scrub.value = String(t);
  const known = !!(videoCtl.frameTimes || state.encodedFps);
  els.frameLabel.innerHTML =
    (known ? `#${videoCtl.frameIndexAt(t)} / ${videoCtl.totalFrames()}` : '#– / –') +
    `<br><small>${t.toFixed(3)} s</small>`;
};

// ---------- 단계 진행 ----------

function setStep(step) {
  state.step = step;
  picker.setActivePoint(STEP_DEFS[step].point);
  render();
}

function resetMeasurement({ keepCenter }) {
  picker.reset({ keepCenter });
  state.tStart = null;
  state.tEnd = null;
  state.startFrame = null;
  state.endFrame = null;
  state.result = null;
  state.saved = false;
}

els.btnConfirm.addEventListener('click', () => {
  const step = state.step;
  if (step === 'center') {
    setStep('start');
  } else if (step === 'start') {
    els.video.pause();
    state.tStart = videoCtl.getTime();
    state.startFrame = videoCtl.frameIndex();
    setStep('end');
  } else if (step === 'end') {
    els.video.pause();
    state.tEnd = videoCtl.getTime();
    state.endFrame = videoCtl.frameIndex();
    computeResult();
  }
});

els.btnBack.addEventListener('click', () => {
  if (state.step === 'start') {
    setStep('center');
  } else if (state.step === 'end') {
    state.tStart = null;
    state.startFrame = null;
    picker.clearPoint('end');
    setStep('start');
  } else if (state.step === 'done') {
    state.result = null;
    state.tEnd = null;
    state.endFrame = null;
    setStep('end');
  }
});

function computeResult() {
  const captureFps = getCaptureFps();
  if (!state.encodedFps || !captureFps) {
    alert('FPS가 설정되지 않았습니다. 상단에서 파일 FPS/촬영 FPS를 확인해주세요.');
    return;
  }
  // 프레임 표가 있으면 정확한 프레임 수, 없으면 평균 fps로 환산
  const dFrames = videoCtl.frameTimes
    ? Math.abs(videoCtl.frameIndexAt(state.tEnd) - videoCtl.frameIndexAt(state.tStart))
    : Math.abs(Math.round((state.tEnd - state.tStart) * state.encodedFps));
  if (dFrames === 0) {
    alert('시작과 끝이 같은 프레임입니다. 끝 프레임으로 이동한 뒤 다시 확정해주세요.');
    return;
  }
  state.result = computeMeasurement({
    center: picker.points.center,
    startPoint: picker.points.start,
    endPoint: picker.points.end,
    tStart: state.tStart,
    tEnd: state.tEnd,
    encodedFps: state.encodedFps,
    captureFps,
    dFrames,
  });
  state.result.captureFps = captureFps;
  state.saved = false;
  setStep('done');
}

// ---------- 렌더링 ----------

function render() {
  const def = STEP_DEFS[state.step];
  els.stepText.textContent = def.text;

  // 확정 버튼 — 지점이 지정되면 활성화. FPS 문제는 숨은 비활성화 대신 안내문으로 표시
  if (def.confirm) {
    els.btnConfirm.textContent = def.confirm;
    els.btnConfirm.hidden = false;
    const hasPoint = !!picker.points[def.point];
    els.btnConfirm.disabled = !hasPoint;
    let status = '';
    if (!hasPoint) {
      status = '영상 화면에서 지점을 터치하면 버튼이 활성화됩니다.';
    } else if (state.step === 'end' && (!state.encodedFps || !getCaptureFps())) {
      status = '⚠️ 상단의 FPS 설정이 비어 있습니다. 파일 FPS/촬영 FPS를 확인해주세요.';
    }
    els.stepStatus.textContent = status;
    els.stepStatus.hidden = !status;
  } else {
    els.btnConfirm.hidden = true;
    els.stepStatus.hidden = true;
  }
  els.btnBack.disabled = state.step === 'center';

  // 칩
  const chips = [];
  const chip = (cls, label, set) =>
    `<span class="chip chip-${cls}${set ? ' set' : ''}">${label}${set ? ' ✓' : ''}</span>`;
  chips.push(chip('center', '중심', !!picker.points.center));
  chips.push(chip('start', state.startFrame != null ? `시작 #${state.startFrame}` : '시작점', !!picker.points.start));
  chips.push(chip('end', state.endFrame != null && state.step === 'done' ? `끝 #${state.endFrame}` : '끝점', !!picker.points.end));
  els.stepChips.innerHTML = chips.join('');

  // 결과 카드
  const r = state.result;
  els.resultCard.hidden = !(state.step === 'done' && r);
  if (r) {
    els.resOmega.textContent = formatNum(r.omega);
    els.resAngle.textContent = `${r.angleDeg.toFixed(2)}°`;
    els.resDir.textContent = r.direction;
    els.resFrames.textContent = `${r.dFrames} 프레임`;
    els.resDt.textContent = `${formatNum(r.dt, 5)} s`;
    els.resFps.textContent = `파일 ${state.encodedFps} / 촬영 ${r.captureFps}`;
    els.btnSave.disabled = state.saved;
    els.btnSave.textContent = state.saved ? '저장됨 ✓' : '기록에 저장';
  }
}

function formatNum(v, maxDecimals = 2) {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const decimals = abs >= 100 ? 1 : abs >= 1 ? 2 : Math.min(maxDecimals, 4);
  return v.toFixed(decimals);
}

// ---------- 결과 저장 / 새 측정 ----------

els.btnSave.addEventListener('click', () => {
  const r = state.result;
  if (!r || state.saved) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  history.add({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    videoName: state.file ? state.file.name : '',
    encodedFps: state.encodedFps,
    captureFps: r.captureFps,
    startFrame: state.startFrame,
    endFrame: state.endFrame,
    dFrames: r.dFrames,
    angleDeg: r.angleDeg,
    direction: r.direction,
    dt: r.dt,
    omega: r.omega,
  });
  state.saved = true;
  renderHistory();
  render();
});

els.btnNew.addEventListener('click', () => {
  resetMeasurement({ keepCenter: false });
  setStep('center');
});

els.btnNewSame.addEventListener('click', () => {
  resetMeasurement({ keepCenter: true });
  setStep('start');
});

// ---------- 측정 기록 ----------

function renderHistory() {
  const list = history.load();
  if (list.length === 0) {
    els.historyList.innerHTML = '<li class="empty">저장된 측정이 없습니다.</li>';
    return;
  }
  els.historyList.innerHTML = list.map((r) => `
    <li class="history-item" data-id="${r.id}">
      <span class="h-omega">${formatNum(r.omega)}<small> deg/s</small></span>
      <span class="h-detail">
        <span class="h-name">${escapeHtml(r.videoName)}</span>
        ${r.angleDeg.toFixed(1)}° · ${r.dFrames}fr · ${formatNum(r.dt, 4)}s · ${r.direction} · ${r.savedAt}
      </span>
      <button class="h-del" title="삭제">✕</button>
    </li>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

els.historyList.addEventListener('click', (e) => {
  const btn = e.target.closest('.h-del');
  if (!btn) return;
  const item = btn.closest('.history-item');
  if (item && confirm('이 측정 기록을 삭제할까요?')) {
    history.remove(item.dataset.id);
    renderHistory();
  }
});

els.btnExport.addEventListener('click', () => {
  const list = history.load();
  if (list.length === 0) {
    alert('내보낼 측정 기록이 없습니다.');
    return;
  }
  history.downloadCsv(list);
});

// ---------- 초기화 ----------

document.getElementById('app-version').textContent = APP_VERSION;
renderHistory();
render();

// 서비스워커 (HTTPS/localhost에서만 동작 — LAN http에서는 조용히 건너뜀)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
