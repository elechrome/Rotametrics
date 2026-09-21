// 단위 테스트: measure.js(각도/각속도 계산) + fps.js(MP4 메타데이터 파서)
// 실행: npm test  (또는 node tests/run.mjs)
import assert from 'node:assert/strict';
import { signedAngleDeg, computeMeasurement } from '../js/measure.js';
import { detectEncodedFps, snapFps } from '../js/fps.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ---------- measure.js ----------
console.log('measure.js');

test('90° 회전 (이미지 좌표: +x → +y 는 화면상 시계방향)', () => {
  const a = signedAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
  near(a, 90);
});

test('반시계방향은 음수', () => {
  const a = signedAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 });
  near(a, -90);
});

test('중심이 원점이 아니어도 동일', () => {
  const a = signedAngleDeg({ x: 100, y: 50 }, { x: 110, y: 50 }, { x: 100, y: 60 });
  near(a, 90);
});

test('179° / -179° 부호 유지', () => {
  const rad = (179 * Math.PI) / 180;
  const a = signedAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: Math.cos(rad), y: Math.sin(rad) });
  near(a, 179, 1e-6);
});

test('일반 영상: 30fps 파일 = 30fps 촬영, 60프레임 동안 90° → 45 deg/s', () => {
  const r = computeMeasurement({
    center: { x: 0, y: 0 }, startPoint: { x: 1, y: 0 }, endPoint: { x: 0, y: 1 },
    tStart: 1.0, tEnd: 3.0, encodedFps: 30, captureFps: 30,
  });
  assert.equal(r.dFrames, 60);
  near(r.dt, 2.0);
  near(r.omega, 45);
  assert.equal(r.direction, '시계방향');
});

test('슬로우모션: 240fps 촬영을 30fps 파일로 재생 — 실제 시간으로 환산', () => {
  // 파일 타임라인 2초 = 60프레임, 실제로는 60/240 = 0.25초 동안 90° → 360 deg/s
  const r = computeMeasurement({
    center: { x: 0, y: 0 }, startPoint: { x: 1, y: 0 }, endPoint: { x: 0, y: 1 },
    tStart: 1.0, tEnd: 3.0, encodedFps: 30, captureFps: 240,
  });
  assert.equal(r.dFrames, 60);
  near(r.dt, 0.25);
  near(r.omega, 360);
});

test('VFR 실시간 타임라인(촬영=파일 fps): 시각 차이를 그대로 사용', () => {
  // 60fps/20fps 혼합(평균 42.31fps) 파일에서 10프레임 × 16.667ms = 0.16667s 구간
  const r = computeMeasurement({
    center: { x: 0, y: 0 }, startPoint: { x: 1, y: 0 }, endPoint: { x: 0, y: 1 },
    tStart: 1.0, tEnd: 1.16667, encodedFps: 42.31, captureFps: 42.31,
  });
  near(r.dt, 0.16667, 1e-9);       // 프레임 환산(7/42.31=0.16545)이 아닌 실제 시각 차이
  near(r.omega, 90 / 0.16667, 1e-6);
});

test('끝 시각이 시작보다 앞이어도 크기는 동일', () => {
  const r = computeMeasurement({
    center: { x: 0, y: 0 }, startPoint: { x: 1, y: 0 }, endPoint: { x: 0, y: 1 },
    tStart: 3.0, tEnd: 1.0, encodedFps: 30, captureFps: 30,
  });
  assert.equal(r.dFrames, 60);
  near(r.omega, 45);
});

// ---------- fps.js ----------
console.log('fps.js');

test('snapFps: 통용값 스냅', () => {
  assert.equal(snapFps(239.99), 240);
  assert.equal(snapFps(29.972), 29.97);
  assert.equal(snapFps(59.9), 59.94);
  assert.equal(snapFps(31.7), 31.7);
});

// --- 합성 MP4 생성 도우미 ---
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (typeof p === 'string' ? Buffer.from(p, 'ascii') : p)));
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]);
}
function fullbox(type, version, ...payloads) {
  return box(type, Buffer.from([version, 0, 0, 0]), ...payloads);
}
function hdlrBox(handler) {
  return fullbox('hdlr', 0, u32(0), Buffer.from(handler, 'ascii'), Buffer.alloc(12), Buffer.from('name\0'));
}
function mdhdV0(timescale) {
  return fullbox('mdhd', 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
}
function mdhdV1(timescale) {
  return fullbox('mdhd', 1, Buffer.alloc(8), Buffer.alloc(8), u32(timescale), Buffer.alloc(8), u16(0x55c4), u16(0));
}
function sttsBox(entries) {
  return fullbox('stts', 0, u32(entries.length),
    ...entries.flatMap(([count, delta]) => [u32(count), u32(delta)]));
}
function videoTrak(mdhd, stts) {
  return box('trak', box('mdia', mdhd, hdlrBox('vide'), box('minf', box('stbl', stts))));
}
function soundTrak() {
  return box('trak', box('mdia', mdhdV0(44100), hdlrBox('soun'),
    box('minf', box('stbl', sttsBox([[100, 1024]])))));
}
function makeMp4({ moovAtEnd = true, mdhd, stts, withAudio = true }) {
  const ftyp = box('ftyp', 'isom', u32(0x200), 'isomiso2mp41');
  const mdat = box('mdat', Buffer.alloc(5000)); // 더미 프레임 데이터
  const traks = [];
  if (withAudio) traks.push(soundTrak()); // 오디오 트랙을 먼저 둬서 건너뛰기 검증
  traks.push(videoTrak(mdhd, stts));
  const moov = box('moov', fullbox('mvhd', 0, Buffer.alloc(96)), ...traks);
  return Buffer.concat(moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}
function bufReader(buf) {
  return {
    size: buf.length,
    read: async (start, len) => new DataView(buf.buffer, buf.byteOffset + start, len),
  };
}

await testAsync('moov가 파일 끝(mdat 뒤)에 있는 240fps 파일 감지', async () => {
  const mp4 = makeMp4({ moovAtEnd: true, mdhd: mdhdV0(24000), stts: sttsBox([[480, 100]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  assert.ok(det, '감지 실패');
  near(det.fps, 240);
  assert.equal(det.source, 'metadata');
});

await testAsync('moov가 파일 앞에 있는 29.97fps 파일 감지', async () => {
  const mp4 = makeMp4({ moovAtEnd: false, mdhd: mdhdV0(30000), stts: sttsBox([[300, 1001]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  assert.ok(det, '감지 실패');
  near(snapFps(det.fps), 29.97);
});

await testAsync('mdhd version 1 (64비트 시각 필드) 처리', async () => {
  const mp4 = makeMp4({ moovAtEnd: true, mdhd: mdhdV1(600), stts: sttsBox([[120, 10]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  assert.ok(det, '감지 실패');
  near(det.fps, 60);
});

await testAsync('stts 엔트리가 여러 개(가변 duration)면 평균 fps', async () => {
  // 100샘플×delta100 + 100샘플×delta200, timescale 24000 → 평균 delta 150 → 160fps
  const mp4 = makeMp4({ moovAtEnd: true, mdhd: mdhdV0(24000), stts: sttsBox([[100, 100], [100, 200]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  assert.ok(det, '감지 실패');
  near(det.fps, 160);
});

await testAsync('고정 프레임(CFR) 판별: uniformRatio = 1', async () => {
  const mp4 = makeMp4({ moovAtEnd: true, mdhd: mdhdV0(24000), stts: sttsBox([[480, 100]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  assert.ok(det.timing, 'timing 없음');
  near(det.timing.uniformRatio, 1);
});

await testAsync('가변 프레임(VFR) 판별: 60/20fps 혼합 → uniformRatio < 0.98', async () => {
  // IMG_6549.mov와 같은 구성: timescale 2400, 16.67ms(delta 40) 501개 + 50ms(delta 120) 131개
  const mp4 = makeMp4({ moovAtEnd: true, mdhd: mdhdV0(2400), stts: sttsBox([[501, 40], [131, 120]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  assert.ok(det.timing.uniformRatio < 0.98, `uniformRatio=${det.timing.uniformRatio}`);
  near(det.timing.maxFps, 60);
  near(det.timing.minFps, 20);
});

await testAsync('미세 지터(±1틱)는 고정으로 판별', async () => {
  // 240fps, timescale 24000: delta 100 위주에 99/101 지터 섞임
  const mp4 = makeMp4({ moovAtEnd: true, mdhd: mdhdV0(24000), stts: sttsBox([[200, 100], [20, 99], [20, 101]]) });
  const det = await detectEncodedFps(bufReader(mp4));
  near(det.timing.uniformRatio, 1);
});

await testAsync('moov가 없는(손상된) 파일 → null', async () => {
  const junk = Buffer.concat([box('ftyp', 'isom'), box('mdat', Buffer.alloc(100))]);
  const det = await detectEncodedFps(bufReader(junk));
  assert.equal(det, null);
});

await testAsync('임의의 바이너리 → 예외 없이 null', async () => {
  const junk = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
  const det = await detectEncodedFps(bufReader(junk));
  assert.equal(det, null);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (일부 실패)' : ''}`);
