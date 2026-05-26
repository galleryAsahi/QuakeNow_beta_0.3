/**
 * vxse61_receiver.js
 * 顕著な地震の震源要素更新のお知らせ（VXSE61）受信・記録スクリプト
 *
 * 使い方：VSCode のターミナルで起動しっぱなしにするだけ
 *   node vxse61_receiver.js
 *
 * 動作：
 *   起動時に即1回取得 → 以降 POLL_INTERVAL_MS ごとに繰り返し
 *   新しいエントリのみ hypocenter_log.json に追記（重複スキップ）
 *   Ctrl+C で停止
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ===== 設定 =====
const LOG_PATH        = path.join(__dirname, 'hypocenter_log.json');
const POLL_INTERVAL_MS = 60 * 1000; // 取得間隔（ミリ秒）
const MAX_EVENTS       = 50;        // JSON に保持する最大件数

// Node.js 18+ はグローバル fetch あり。それ以前は node-fetch を使用
const fetchFn = (() => {
  if (typeof fetch !== 'undefined') return fetch;
  try { return require('node-fetch'); } catch { return null; }
})();

if (!fetchFn) {
  console.error('[receiver] fetch が使えません。Node.js 18以上を使用してください。');
  process.exit(1);
}

// ===== JSON ログ読み書き =====
function loadLog() {
  try {
    const data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
    return Array.isArray(data.events) ? data : { version: '1.0', events: [] };
  } catch {
    return { version: '1.0', description: '顕著な地震の震源要素更新のお知らせ（VXSE61）記録ファイル', events: [] };
  }
}

function saveLog(data) {
  data.events.sort((a, b) => new Date(b.reportDateTime || 0) - new Date(a.reportDateTime || 0));
  if (data.events.length > MAX_EVENTS) data.events = data.events.slice(0, MAX_EVENTS);
  fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ===== 時刻フォーマット変換 =====
// "2026-05-20T11:46:00+09:00" → "2026/05/20 11:46"
// JST前提（XMLの時刻はすべてJST）。パース失敗時は元の文字列をそのまま返す
function toJstSlash(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  // UTC+9 に変換
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const Y  = jst.getUTCFullYear();
  const M  = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const D  = String(jst.getUTCDate()).padStart(2, '0');
  const h  = String(jst.getUTCHours()).padStart(2, '0');
  const m  = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${Y}/${M}/${D} ${h}:${m}`;
}

// ===== VXSE61 XML パーサー =====
function parseVxse61Xml(text) {
  // 取消は無視
  const infoType = (text.match(/<InfoType[^>]*>([^<]+)<\/InfoType>/) || [])[1];
  if (infoType && infoType.trim() === '取消') return null;

  const get = tag => {
    const m = text.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`));
    return m ? m[1].trim() : '';
  };

  const reportDateTime = get('ReportDateTime');
  const arrivalTime    = get('ArrivalTime');
  const epiName        = get('Name');
  if (!arrivalTime && !reportDateTime) return null;

  // 座標パース（度分形式 "+38˚28.0'+141˚37.6'-59000/" or 度形式）
  const coordStr = (text.match(/<jmx_eb:Coordinate[^>]*>([^<]+)<\/jmx_eb:Coordinate>/) || [])[1] || '';
  let latitude = null, longitude = null, depth = null;
  if (coordStr) {
    const parseDegMin = s => {
      const dm = s.match(/^([+-]?)(\d+)[˚°](\d+\.?\d*)'?$/);
      if (dm) return (dm[1] === '-' ? -1 : 1) * (parseInt(dm[2]) + parseFloat(dm[3]) / 60);
      return parseFloat(s) || null;
    };
    const toks = coordStr.replace(/\/$/, '').match(/[+-][^+-]+/g);
    if (toks && toks.length >= 2) {
      latitude  = parseDegMin(toks[0]);
      longitude = parseDegMin(toks[1]);
      if (toks[2]) {
        const raw = parseFloat(toks[2]);
        depth = Math.round(Math.abs(raw) >= 1000 ? Math.abs(raw) / 1000 : Math.abs(raw));
      }
    }
  }

  const magRaw   = (text.match(/<jmx_eb:Magnitude[^>]*>([^<]+)<\/jmx_eb:Magnitude>/) || [])[1];
  const magnitude = magRaw ? parseFloat(magRaw) || null : null;

  return {
    arrivalTime:    toJstSlash(arrivalTime),
    reportDateTime: toJstSlash(reportDateTime),
    hypocenter: { name: epiName || null, latitude, longitude, depth, magnitude },
  };
}

// ===== 1回分の取得処理 =====
async function poll(existingKeys) {
  let added = 0;
  const newEntries = [];
  let succeeded = false;

  // --- 1st: agora（NII）---
  try {
    const LIST_URL =
      'https://agora.ex.nii.ac.jp/cgi-bin/cps/report_list.pl' +
      '?type=%E9%A1%95%E8%91%97%E3%81%AA%E5%9C%B0%E9%9C%87%E3%81%AE%E9%9C%87%E6%BA%90%E8%A6%81%E7%B4%A0%E6%9B%B4%E6%96%B0%E3%81%AE%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B' +
      '&office=%E6%B0%97%E8%B1%A1%E5%BA%81%E6%9C%AC%E5%BA1';
    const res = await fetchFn(LIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const ids = [...new Set(
      [...html.matchAll(/report_xml\.pl\?id=(\d{14}_\d+_VXSE61_\d+)/g)].map(m => m[1])
    )];
    if (ids.length === 0) throw new Error('VXSE61エントリなし');

    for (const id of ids.slice(0, 20)) {
      try {
        const xRes = await fetchFn(`https://agora.ex.nii.ac.jp/cgi-bin/cps/report_xml.pl?id=${id}`);
        if (!xRes.ok) continue;
        const entry = parseVxse61Xml(await xRes.text());
        if (!entry) continue;
        const key = entry.reportDateTime || entry.arrivalTime;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        newEntries.push(entry);
        added++;
      } catch { /* 個別失敗は無視 */ }
    }
    succeeded = true;
  } catch (e) {
    console.warn(`  [agora] 取得失敗: ${e.message}`);
  }

  // --- 2nd: 気象庁フィード（フォールバック）---
  if (!succeeded) {
    try {
      const res = await fetchFn('https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feedText = await res.text();

      const hrefs = [...feedText.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
        .filter(m => m[1].includes('震源要素更新'))
        .map(m => (m[1].match(/<link[^>]+href="([^"]+)"/) || [])[1])
        .filter(Boolean)
        .slice(0, 10);

      for (const href of hrefs) {
        try {
          const xRes = await fetchFn(href);
          if (!xRes.ok) continue;
          const entry = parseVxse61Xml(await xRes.text());
          if (!entry) continue;
          const key = entry.reportDateTime || entry.arrivalTime;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          newEntries.push(entry);
          added++;
        } catch { /* 個別失敗は無視 */ }
      }
    } catch (e) {
      console.warn(`  [気象庁フィード] 取得失敗: ${e.message}`);
    }
  }

  if (added > 0) {
    const log = loadLog();
    log.events.push(...newEntries);
    saveLog(log);
    console.log(`  → ${added} 件追記しました`);
  } else {
    console.log('  → 新しいエントリはありませんでした');
  }
}

// ===== 常駐ループ =====
async function start() {
  console.log('================================================');
  console.log('  VXSE61 receiver 起動');
  console.log(`  取得間隔: ${POLL_INTERVAL_MS / 1000} 秒`);
  console.log(`  記録先: ${LOG_PATH}`);
  console.log('  停止: Ctrl+C');
  console.log('================================================');

  // 起動時に既存キーをロードして重複防止 Set を初期化
  const log = loadLog();
  const existingKeys = new Set(log.events.map(e => e.reportDateTime || e.arrivalTime));

  // 即時1回実行
  const runOnce = async () => {
    const now = new Date().toLocaleTimeString('ja-JP');
    console.log(`[${now}] 取得中...`);
    try {
      await poll(existingKeys);
    } catch (e) {
      console.error('  予期しないエラー:', e.message);
    }
  };

  await runOnce();
  setInterval(runOnce, POLL_INTERVAL_MS);
}

start();
