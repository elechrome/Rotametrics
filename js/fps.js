// 파일 FPS(인코딩 fps) 감지
//  ① MP4/MOV 컨테이너 메타데이터 파싱 (mdhd timescale + stts 샘플 duration)
//  ② 실패 시 requestVideoFrameCallback으로 재생하며 프레임 간격 추정
//  ③ 그래도 실패하면 호출 측(UI)에서 수동 선택
//
// 파서는 reader 인터페이스({size, read(start, len) → DataView})를 받으므로
// 브라우저(File)와 Node(fs) 양쪽에서 테스트 가능.

const SNAP_TARGETS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120, 200, 239.76, 240];

/** 감지된 fps를 가장 가까운 통용값(29.97, 240 등)에 스냅. 0.5% 이내인 후보 중 최근접, 없으면 소수 2자리 반올림. */
export function snapFps(fps) {
  let best = null, bestDiff = Infinity;
  for (const t of SNAP_TARGETS) {
    const diff = Math.abs(fps - t);
    if (diff / t < 0.005 && diff < bestDiff) {
      best = t;
      bestDiff = diff;
    }
  }
  return best ?? Math.round(fps * 100) / 100;
}

/** 브라우저 File → reader */
export function fileReader(file) {
  return {
    size: file.size,
    read: async (start, len) => new DataView(await file.slice(start, start + len).arrayBuffer()),
  };
}

/** 메타데이터에서 비디오 트랙 fps 감지. 실패 시 null. */
export async function detectEncodedFps(reader) {
  try {
    const tops = await scanTopLevel(reader);
    const moovEntry = tops.find((b) => b.type === 'moov');
    if (!moovEntry || moovEntry.size > 64 * 1024 * 1024) return null;
    const view = await reader.read(moovEntry.offset, moovEntry.size);
    const moov = { view, start: moovEntry.headerLen, end: moovEntry.size };

    // 일반 MP4/MOV: moov의 stts에 샘플이 있음
    const res = parseMoovFps(moov);
    if (res) return { fps: res.fps, source: 'metadata', timing: res.timing, frameTimes: res.frameTimes };

    // 조각형(fMP4, MediaRecorder/화면녹화 등): 샘플이 moof 조각들에 있음
    if (tops.some((b) => b.type === 'moof')) {
      const frag = await parseFragmented(reader, moov, tops);
      if (frag) return { fps: frag.fps, source: 'metadata', timing: frag.timing, frameTimes: frag.frameTimes };
    }
    return null;
  } catch {
    return null;
  }
}

function boxTypeAt(view, offset) {
  if (offset + 4 > view.byteLength) return '';
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** 최상위 박스 목록을 훑는다 (본문은 읽지 않음 — mdat이 커도 헤더만 확인) */
async function scanTopLevel(reader) {
  const fileSize = reader.size;
  const tops = [];
  let offset = 0;
  while (offset + 8 <= fileSize && tops.length < 100000) {
    const head = await reader.read(offset, Math.min(16, fileSize - offset));
    let boxSize = head.getUint32(0);
    const type = boxTypeAt(head, 4);
    let headerLen = 8;
    if (boxSize === 1) {
      if (head.byteLength < 16) break;
      boxSize = Number(head.getBigUint64(8));
      headerLen = 16;
    } else if (boxSize === 0) {
      boxSize = fileSize - offset; // 마지막 박스
    }
    if (boxSize < headerLen) break; // 손상된 파일
    tops.push({ type, offset, headerLen, size: boxSize });
    offset += boxSize;
  }
  return tops;
}

/** view의 [start, end) 구간에 있는 자식 박스들을 순회 */
function* boxes(view, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = boxTypeAt(view, offset + 4);
    let headerLen = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(view.getBigUint64(offset + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerLen || offset + size > end) return;
    yield { type, start: offset + headerLen, end: offset + size };
    offset += size;
  }
}

function findBox(view, start, end, type) {
  for (const b of boxes(view, start, end)) if (b.type === type) return b;
  return null;
}

/** moov 안의 비디오 trak에서 fps = timescale × 샘플수 ÷ 재생틱 */
function parseMoovFps({ view, start, end }) {
  for (const trak of boxes(view, start, end)) {
    if (trak.type !== 'trak') continue;
    const mdia = findBox(view, trak.start, trak.end, 'mdia');
    if (!mdia) continue;

    // hdlr: FullBox(4) + pre_defined(4) + handler_type(4)
    const hdlr = findBox(view, mdia.start, mdia.end, 'hdlr');
    if (!hdlr || boxTypeAt(view, hdlr.start + 8) !== 'vide') continue;

    // mdhd: version에 따라 timescale 위치가 다름
    const mdhd = findBox(view, mdia.start, mdia.end, 'mdhd');
    if (!mdhd) continue;
    const version = view.getUint8(mdhd.start);
    const timescale = version === 1
      ? view.getUint32(mdhd.start + 20)
      : view.getUint32(mdhd.start + 12);
    if (!timescale) continue;

    const minf = findBox(view, mdia.start, mdia.end, 'minf');
    const stbl = minf && findBox(view, minf.start, minf.end, 'stbl');
    const stts = stbl && findBox(view, stbl.start, stbl.end, 'stts');
    if (!stts) continue;

    // stts: FullBox(4) + entry_count(4) + [sample_count(4), sample_delta(4)]*
    const entryCount = view.getUint32(stts.start + 4);
    let samples = 0, ticks = 0;
    const entries = [];
    for (let i = 0; i < entryCount; i++) {
      const off = stts.start + 8 + i * 8;
      if (off + 8 > stts.end) break;
      const count = view.getUint32(off);
      const delta = view.getUint32(off + 4);
      samples += count;
      ticks += count * delta;
      if (delta > 0) entries.push([count, delta]);
    }
    if (samples > 0 && ticks > 0) {
      // 프레임 표는 부가 기능 — 어떤 이유로든 실패해도 fps 감지는 살아야 한다
      let frameTimes = null;
      try {
        const ctts = findBox(view, stbl.start, stbl.end, 'ctts');
        const edts = findBox(view, trak.start, trak.end, 'edts');
        const elst = edts && findBox(view, edts.start, edts.end, 'elst');
        frameTimes = buildFrameTimes({ view, entries, samples, ctts, elst, timescale });
      } catch {
        frameTimes = null;
      }
      return {
        fps: timescale * samples / ticks,
        timing: analyzeTiming(entries, timescale, samples),
        frameTimes,
      };
    }
  }
  return null;
}

/**
 * 모든 프레임의 표시 시각(초) 표를 만든다 — 정확한 프레임 탐색/계산용.
 * stts(디코드 간격) + ctts(표시 오프셋, 있으면) + elst(시작 오프셋, 있으면).
 * 복잡한 편집(배속≠1)이나 비정상 크기면 null (호출 측은 산술 방식으로 폴백).
 */
function buildFrameTimes({ view, entries, samples, ctts, elst, timescale }) {
  if (!samples || samples > 500000) return null;

  // 디코드 타임스탬프(DTS)
  const times = new Float64Array(samples);
  let t = 0, i = 0;
  for (const [count, delta] of entries) {
    for (let k = 0; k < count; k++) { times[i++] = t; t += delta; }
  }

  // ctts가 있으면 표시 시각(PTS) = DTS + offset, 표시 순서로 정렬
  if (ctts) {
    const version = view.getUint8(ctts.start);
    const n = view.getUint32(ctts.start + 4);
    let j = 0;
    for (let e = 0; e < n && j < samples; e++) {
      const off = ctts.start + 8 + e * 8;
      if (off + 8 > ctts.end) return null;
      const count = view.getUint32(off);
      const offset = version === 1 ? view.getInt32(off + 4) : view.getUint32(off + 4);
      for (let k = 0; k < count && j < samples; k++) times[j++] += offset;
    }
    times.sort();
  }

  // elst: 시작 오프셋 보정. 배속이 있는 편집은 지원하지 않음
  let base = ctts ? times[0] : 0;
  if (elst) {
    const ev = view.getUint8(elst.start);
    const n = view.getUint32(elst.start + 4);
    let o = elst.start + 8;
    let mediaStart = null;
    const entrySize = ev === 1 ? 20 : 12;
    for (let e = 0; e < n; e++) {
      if (o + entrySize > elst.end) return null; // 손상/비표준 elst
      let mediaTime, rateInt;
      if (ev === 1) { mediaTime = Number(view.getBigInt64(o + 8)); rateInt = view.getInt16(o + 16); o += 20; }
      else { mediaTime = view.getInt32(o + 4); rateInt = view.getInt16(o + 8); o += 12; }
      if (mediaTime >= 0) {
        if (rateInt !== 1) return null; // 배속 편집 → 표 사용 불가
        if (mediaStart === null) mediaStart = mediaTime;
      }
    }
    if (mediaStart !== null) base = mediaStart;
  }

  const out = new Float64Array(samples);
  for (let k = 0; k < samples; k++) out[k] = (times[k] - base) / timescale;
  return out;
}

/** moov에서 비디오 트랙의 track_ID와 timescale을 찾는다 (fMP4용) */
function findVideoTrackInfo(view, start, end) {
  for (const trak of boxes(view, start, end)) {
    if (trak.type !== 'trak') continue;
    const mdia = findBox(view, trak.start, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(view, mdia.start, mdia.end, 'hdlr');
    if (!hdlr || boxTypeAt(view, hdlr.start + 8) !== 'vide') continue;
    const mdhd = findBox(view, mdia.start, mdia.end, 'mdhd');
    const tkhd = findBox(view, trak.start, trak.end, 'tkhd');
    if (!mdhd || !tkhd) continue;
    const mv = view.getUint8(mdhd.start);
    const timescale = mv === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12);
    const tv = view.getUint8(tkhd.start);
    const trackId = tv === 1 ? view.getUint32(tkhd.start + 20) : view.getUint32(tkhd.start + 12);
    if (timescale && trackId) return { trackId, timescale };
  }
  return null;
}

/**
 * 조각형 MP4(fMP4): moof/traf/trun 조각들에서 비디오 샘플 시각을 수집.
 * MediaRecorder(브라우저 녹화), 화면 녹화, 스트리밍 저장 파일이 이 구조.
 */
async function parseFragmented(reader, moov, tops) {
  const info = findVideoTrackInfo(moov.view, moov.start, moov.end);
  if (!info) return null;
  const { trackId, timescale } = info;

  // mvex/trex의 트랙 기본 샘플 duration
  let trexDur = 0;
  const mvex = findBox(moov.view, moov.start, moov.end, 'mvex');
  if (mvex) {
    for (const b of boxes(moov.view, mvex.start, mvex.end)) {
      // trex: FullBox(4) + track_ID(4) + desc_index(4) + default_duration(4) + ...
      if (b.type === 'trex' && moov.view.getUint32(b.start + 4) === trackId) {
        trexDur = moov.view.getUint32(b.start + 12);
      }
    }
  }

  const MAX_SAMPLES = 500000;
  const times = [];       // 샘플 표시 시각(틱)
  const durHist = new Map(); // duration → count (fps/균일도 분석용)
  let samples = 0, ticks = 0;
  let runningTime = 0;    // tfdt가 없을 때의 누적 시각
  let tableOk = true;

  for (const top of tops) {
    if (top.type !== 'moof') continue;
    if (top.size > 8 * 1024 * 1024) return null;
    const v = await reader.read(top.offset, top.size);

    for (const traf of boxes(v, top.headerLen, top.size)) {
      if (traf.type !== 'traf') continue;
      const tfhd = findBox(v, traf.start, traf.end, 'tfhd');
      if (!tfhd || v.getUint32(tfhd.start + 4) !== trackId) continue;

      // tfhd 선택 필드 건너뛰기 → 조각 기본 duration
      const tfFlags = v.getUint32(tfhd.start) & 0xffffff;
      let o = tfhd.start + 8;
      if (tfFlags & 0x01) o += 8; // base-data-offset
      if (tfFlags & 0x02) o += 4; // sample-description-index
      let fragDur = trexDur;
      if (tfFlags & 0x08) { fragDur = v.getUint32(o); o += 4; }

      // tfdt: 조각의 시작 시각
      const tfdt = findBox(v, traf.start, traf.end, 'tfdt');
      let t = runningTime;
      if (tfdt) {
        const tv = v.getUint8(tfdt.start);
        t = tv === 1 ? Number(v.getBigUint64(tfdt.start + 4)) : v.getUint32(tfdt.start + 4);
      }

      for (const trun of boxes(v, traf.start, traf.end)) {
        if (trun.type !== 'trun') continue;
        const trVersion = v.getUint8(trun.start);
        const trFlags = v.getUint32(trun.start) & 0xffffff;
        const count = v.getUint32(trun.start + 4);
        let p = trun.start + 8;
        if (trFlags & 0x01) p += 4; // data-offset
        if (trFlags & 0x04) p += 4; // first-sample-flags
        const perSample =
          ((trFlags & 0x100) ? 4 : 0) + ((trFlags & 0x200) ? 4 : 0) +
          ((trFlags & 0x400) ? 4 : 0) + ((trFlags & 0x800) ? 4 : 0);
        if (p + count * perSample > trun.end) return null; // 손상 방어

        for (let i = 0; i < count; i++) {
          let dur = fragDur;
          if (trFlags & 0x100) { dur = v.getUint32(p); p += 4; }
          if (trFlags & 0x200) p += 4; // size
          if (trFlags & 0x400) p += 4; // flags
          let cts = 0;
          if (trFlags & 0x800) { cts = trVersion === 1 ? v.getInt32(p) : v.getUint32(p); p += 4; }
          if (samples < MAX_SAMPLES) times.push(t + cts);
          else tableOk = false;
          if (dur > 0) durHist.set(dur, (durHist.get(dur) || 0) + 1);
          t += dur;
          samples++;
          ticks += dur;
        }
      }
      runningTime = t;
    }
  }

  if (!samples || !ticks) return null;
  const entries = [...durHist.entries()].map(([delta, count]) => [count, delta]);

  let frameTimes = null;
  if (tableOk && times.length) {
    times.sort((a, b) => a - b);
    const base = times[0];
    frameTimes = new Float64Array(times.length);
    for (let i = 0; i < times.length; i++) frameTimes[i] = (times[i] - base) / timescale;
  }

  return {
    fps: timescale * samples / ticks,
    timing: analyzeTiming(entries, timescale, samples),
    frameTimes,
  };
}

/** 프레임 간격 균일도 분석 — CFR/VFR 판별용 */
function analyzeTiming(entries, timescale, samples) {
  if (!entries.length || !samples) return null;
  // 가중 중앙값 (프레임 수 기준)
  const sorted = [...entries].sort((a, b) => a[1] - b[1]);
  let acc = 0, median = sorted[0][1];
  for (const [count, delta] of sorted) {
    acc += count;
    if (acc >= samples / 2) { median = delta; break; }
  }
  // 중앙값 ±2% 이내(또는 1틱 이내 지터)를 "균일"로 간주
  const tol = Math.max(1, median * 0.02);
  let uniform = 0;
  let minDelta = Infinity, maxDelta = 0;
  for (const [count, delta] of entries) {
    if (Math.abs(delta - median) <= tol) uniform += count;
    if (delta < minDelta) minDelta = delta;
    if (delta > maxDelta) maxDelta = delta;
  }
  return {
    uniformRatio: uniform / samples,     // 1.0에 가까울수록 고정 프레임
    minFps: timescale / maxDelta,        // 가장 느린 순간
    maxFps: timescale / minDelta,        // 가장 빠른 순간
  };
}

/**
 * 폴백: 잠깐 재생하면서 rVFC의 mediaTime 간격 중앙값으로 fps 추정.
 * 재생 위치/음소거 상태는 원복한다. 실패 시 null.
 */
export async function estimateFpsByPlayback(video, { samples = 24, timeoutMs = 4000 } = {}) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const t0 = video.currentTime;
  const wasMuted = video.muted;
  video.muted = true;
  try {
    const fps = await new Promise((resolve) => {
      const deltas = [];
      let last = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (deltas.length < 4) return resolve(null);
        deltas.sort((a, b) => a - b);
        resolve(1 / deltas[Math.floor(deltas.length / 2)]);
      };
      const timer = setTimeout(finish, timeoutMs);
      const cb = (_now, meta) => {
        if (finished) return;
        if (last !== null) {
          const d = meta.mediaTime - last;
          if (d > 1e-5) deltas.push(d);
        }
        last = meta.mediaTime;
        if (deltas.length >= samples) finish();
        else video.requestVideoFrameCallback(cb);
      };
      video.requestVideoFrameCallback(cb);
      video.play().catch(finish);
    });
    return fps ? { fps, source: 'playback' } : null;
  } finally {
    video.pause();
    video.muted = wasMuted;
    video.currentTime = t0;
  }
}
