// 측정 기록 저장(localStorage) + CSV 내보내기

const KEY = 'rotametrics.history.v1';

export function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 저장공간 부족 등 */ }
}

export function add(record) {
  const list = load();
  list.unshift(record);
  save(list);
  return list;
}

export function remove(id) {
  const list = load().filter((r) => r.id !== id);
  save(list);
  return list;
}

export function toCsv(list) {
  const header = ['저장시각', '영상', '파일FPS', '촬영FPS', '시작프레임', '끝프레임', '프레임수',
    '각도(deg)', '방향', '실제시간(s)', '각속도(deg/s)'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = list.map((r) => [
    r.savedAt, r.videoName, r.encodedFps, r.captureFps,
    r.startFrame, r.endFrame, r.dFrames,
    r.angleDeg.toFixed(2), r.direction, r.dt.toFixed(5), r.omega.toFixed(2),
  ].map(esc).join(','));
  // BOM: 엑셀에서 한글 헤더가 깨지지 않도록
  return '﻿' + [header.join(','), ...rows].join('\n') + '\n';
}

export function downloadCsv(list) {
  const blob = new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `rotametrics_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
