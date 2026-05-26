/**
 * eq_detector.js — ingen084方式リアルタイム地震検知エンジン
 *
 * アルゴリズム概要 (https://qiita.com/ingen084/items/82985e8d3227c97c608d):
 *   1. 各観測点ごとに過去 HISTORY_SEC 秒分の v値履歴を保持
 *   2. 上昇幅 (max - min) が RISE_THRESH を超えた観測点を「揺れ候補」と判定
 *   3. 揺れ候補の近隣 NEIGHBOR_RADIUS km 以内の観測点を確認
 *      → NEIGHBOR_MIN 点以上が同様に上昇していれば「イベント確定」
 *   4. 検知した観測点をイベントにグループ化。別イベントの観測点と隣接した場合はマージ
 *   5. イベント終了時間は観測された最大震度に応じて動的延長
 *   6. 異常値除外: 揺れ未検知 かつ 高値 かつ 変化量小 の観測点を弾く
 *
 * 使い方:
 *   const detector = new EqDetector(KYOSHIN_LAT, KYOSHIN_LON);
 *   detector.onEventNew    = (event) => { ... }  // 新規イベント
 *   detector.onEventUpdate = (event) => { ... }  // 推定震源更新
 *   detector.onEventEnd    = (event) => { ... }  // イベント終了
 *
 *   // 毎フレーム (_kyoshinDraw 末尾などから)
 *   detector.feed(rawString, Date.now());
 */

'use strict';

// =====================================================================
// 定数
// =====================================================================
const _DEG2RAD = Math.PI / 180;
const _R_EARTH = 6371;

function _haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * _DEG2RAD;
  const dLon = (lon2 - lon1) * _DEG2RAD;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * _DEG2RAD) * Math.cos(lat2 * _DEG2RAD)
          * Math.sin(dLon / 2) ** 2;
  return 2 * _R_EARTH * Math.asin(Math.sqrt(a));
}

// v値 → リアルタイム震度 (ingen084方式の強さ区分に対応)
function _vToIntensity(v) {
  if (v < 25)  return null;   // データなし
  if (v < 35)  return -2.0;   // ほぼ0
  if (v < 45)  return -1.0;   // 微動
  if (v < 55)  return  1.0;   // 震度1
  if (v < 65)  return  2.0;   // 震度2 (Medium下限)
  if (v < 75)  return  3.0;   // 震度3 (Medium)
  if (v < 80)  return  4.0;   // 震度4 (Strong下限)
  if (v < 85)  return  5.0;   // 震度5弱
  if (v < 90)  return  6.0;   // 震度5強
  if (v < 95)  return  7.0;   // 震度6弱
  return                8.0;  // 震度6強〜7
}

// ingen084の強さ区分 (Weaker / Weak / Medium / Strong / Stronger)
function _intensityLevel(intensity) {
  if (intensity === null || intensity < -1.5) return 0; // 対象外
  if (intensity < -1.0) return 1; // Weaker
  if (intensity <  1.0) return 2; // Weak
  if (intensity <  3.0) return 3; // Medium
  if (intensity <  5.0) return 4; // Strong
  return                       5; // Stronger
}

// イベント終了時間 [ms] を最大強度から決定
function _holdMs(level) {
  //  Weaker:5s  Weak:10s  Medium:20s  Strong:40s  Stronger:90s
  return [0, 5000, 10000, 20000, 40000, 90000][level] ?? 10000;
}

// =====================================================================
// 最小二乗震源推定 (Geiger法簡易版)  ※着未着ではなく上昇開始時刻差を使用
// =====================================================================
function _leastSquaresHypocenter(arrivals, vp) {
  if (arrivals.length < 3) return null;
  const pts = [...arrivals].sort((a, b) => a.t - b.t);
  const t0ref = pts[0].t / 1000;

  let lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  let lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  let lr = 0.05, prevRmse = Infinity;

  for (let iter = 0; iter < 40; iter++) {
    let sumRes2 = 0, gLat = 0, gLon = 0;
    for (let i = 1; i < pts.length; i++) {
      const dtObs  = (pts[i].t - pts[0].t) / 1000;
      const di     = _haversine(lat, lon, pts[i].lat, pts[i].lon);
      const d0     = _haversine(lat, lon, pts[0].lat, pts[0].lon);
      const dtPred = (di - d0) / vp;
      const res    = dtObs - dtPred;
      sumRes2     += res ** 2;
      const EL = 0.005;
      gLat += res * ((_haversine(lat+EL, lon, pts[i].lat, pts[i].lon) - _haversine(lat+EL, lon, pts[0].lat, pts[0].lon)) / vp - dtPred) / EL;
      gLon += res * ((_haversine(lat, lon+EL, pts[i].lat, pts[i].lon) - _haversine(lat, lon+EL, pts[0].lat, pts[0].lon)) / vp - dtPred) / EL;
    }
    const rmse = Math.sqrt(sumRes2 / (pts.length - 1)) * vp;
    if (Math.abs(prevRmse - rmse) < 0.05) break;
    prevRmse = rmse;
    const norm = Math.sqrt(gLat**2 + gLon**2) || 1;
    lat += lr * gLat / norm;
    lon += lr * gLon / norm;
    lr *= 0.93;
  }
  const d0 = _haversine(lat, lon, pts[0].lat, pts[0].lon);
  return {
    lat: +lat.toFixed(4), lon: +lon.toFixed(4),
    originTime: pts[0].t / 1000 - d0 / vp,
    rmseKm: +prevRmse.toFixed(2), nPts: pts.length,
  };
}

// =====================================================================
// EqEvent — 1つの地震イベント
// =====================================================================
let _eventIdCounter = 0;

class EqEvent {
  constructor(startMs) {
    this.id        = ++_eventIdCounter;
    this.startMs   = startMs;
    this.endMs     = startMs + 10000; // 初期10秒、震度に応じて延長
    this.stations  = new Set();       // 所属観測点インデックス
    this.maxLevel  = 0;
    this.arrivals  = [];              // 震源推定用: [{idx,lat,lon,t}]
    this.estimate  = null;            // 最新推定結果
  }

  // 観測点追加 & 終了時間更新
  addStation(idx, lat, lon, nowMs, level) {
    if (!this.stations.has(idx)) {
      this.stations.add(idx);
      this.arrivals.push({ idx, lat, lon, t: nowMs });
    }
    if (level > this.maxLevel) this.maxLevel = level;
    // 終了時間を最大強度に応じて延長
    const hold = _holdMs(this.maxLevel);
    this.endMs = Math.max(this.endMs, nowMs + hold);
  }

  isActive(nowMs) { return nowMs < this.endMs; }

  get levelName() {
    return ['—', 'Weaker', 'Weak', 'Medium', 'Strong', 'Stronger'][this.maxLevel] ?? '?';
  }
}

// =====================================================================
// EqDetector — メインクラス
// =====================================================================
class EqDetector {
  /**
   * @param {number[]} stationsLat
   * @param {number[]} stationsLon
   */
  constructor(stationsLat, stationsLon) {
    this.lat   = stationsLat;
    this.lon   = stationsLon;
    this.count = stationsLat.length;

    // ===== 設定 =====
    this.kyoshinOffset  = 50;    // KYOSHIN_OFFSET
    this.historyFrames  = 10;    // 保持するフレーム数 (~10秒)
    this.riseThresh     = 0.8;   // 上昇幅の閾値 (リアルタイム震度単位)
    this.neighborRadius = 60;    // 近隣観測点の探索半径 [km]
    this.neighborMin    = 2;     // 近隣で条件を満たす最低点数
    this.vp             = 6.0;   // P波速度 [km/s]
    // 異常値除外: 未検知かつ高値(v≥75=震度4以上)かつ変化量<1.0の観測点
    this.anomalyMinV    = 75;
    this.anomalyMaxRise = 1.0;

    // ===== コールバック =====
    /** @type {(event: EqEvent) => void} */ this.onEventNew    = null;
    /** @type {(event: EqEvent) => void} */ this.onEventUpdate = null;
    /** @type {(event: EqEvent) => void} */ this.onEventEnd    = null;

    // ===== 内部ステート =====
    this._history    = Array.from({ length: this.count }, () => []); // 各観測点の v値リング
    this._stationEvent = new Array(this.count).fill(null); // 観測点 → イベントID
    this._events     = new Map();   // id → EqEvent
    this._anomalies  = new Set();   // 異常値除外対象
    this._neighbors  = null;        // 事前計算した近隣リスト (遅延初期化)
  }

  // ------------------------------------------------------------------
  // 近隣リスト事前計算 (初回feedで一度だけ実行)
  // ------------------------------------------------------------------
  _buildNeighbors() {
    this._neighbors = [];
    for (let i = 0; i < this.count; i++) {
      const nb = [];
      for (let j = 0; j < this.count; j++) {
        if (i === j) continue;
        if (_haversine(this.lat[i], this.lon[i], this.lat[j], this.lon[j]) <= this.neighborRadius) {
          nb.push(j);
        }
      }
      this._neighbors.push(nb);
    }
  }

  // ------------------------------------------------------------------
  // 毎フレーム呼ぶ
  // ------------------------------------------------------------------
  feed(raw, nowMs) {
    if (!raw) return;
    if (!this._neighbors) this._buildNeighbors();

    const data = raw.slice(this.kyoshinOffset);

    // --- Step1: v値をパース、履歴に追加 ---
    const vs = new Array(this.count).fill(-1);
    for (let i = 0; i < this.count; i++) {
      const s = data.slice(i * 2, i * 2 + 2);
      if (s.length < 2) break;
      const v = parseInt(s, 10);
      if (!isNaN(v) && v !== 99) vs[i] = v;

      const hist = this._history[i];
      hist.push(v);
      if (hist.length > this.historyFrames) hist.shift();
    }

    // --- Step2: 上昇幅を計算し、揺れ候補を判定 ---
    const risingSet = new Set();
    for (let i = 0; i < this.count; i++) {
      const hist = this._history[i];
      if (hist.length < 3) continue;
      if (this._anomalies.has(i)) continue;

      const validHist = hist.filter(v => v >= 0 && v !== 99);
      if (!validHist.length) continue;
      const maxV = Math.max(...validHist);
      const minV = Math.min(...validHist);
      const rise = _vToIntensity(maxV) - _vToIntensity(minV);
      if (rise !== null && rise >= this.riseThresh) {
        risingSet.add(i);
      }
    }

    // --- Step3: 近隣確認 → イベント割り当て ---
    for (const i of risingSet) {
      const neighbors = this._neighbors[i];
      let risingNeighbors = 0;
      for (const j of neighbors) {
        if (risingSet.has(j)) risingNeighbors++;
      }
      if (risingNeighbors < this.neighborMin) continue; // 近隣不足 → スキップ

      // 現在の強度
      const curV = vs[i];
      const intensity = _vToIntensity(curV < 0 ? 25 : curV);
      const level = _intensityLevel(intensity);
      if (level === 0) continue;

      // イベントへの割り当て
      const existingId = this._stationEvent[i];
      if (existingId !== null) {
        // 既存イベントを更新
        const ev = this._events.get(existingId);
        if (ev) ev.addStation(i, this.lat[i], this.lon[i], nowMs, level);
      } else {
        // 近隣観測点がどのイベントに属しているか探す
        let targetEvent = null;
        let oldestStart = Infinity;
        for (const j of neighbors) {
          const jId = this._stationEvent[j];
          if (jId !== null) {
            const ev = this._events.get(jId);
            if (ev && ev.startMs < oldestStart) {
              oldestStart = ev.startMs;
              targetEvent = ev;
            }
          }
        }

        if (targetEvent) {
          // 既存イベントにマージ
          targetEvent.addStation(i, this.lat[i], this.lon[i], nowMs, level);
          this._stationEvent[i] = targetEvent.id;
          // 近隣のイベントもマージ（より古い方に統合）
          for (const j of neighbors) {
            const jId = this._stationEvent[j];
            if (jId !== null && jId !== targetEvent.id) {
              this._mergeEvents(targetEvent.id, jId, nowMs);
            }
          }
        } else {
          // 新規イベント
          const ev = new EqEvent(nowMs);
          ev.addStation(i, this.lat[i], this.lon[i], nowMs, level);
          this._stationEvent[i] = ev.id;
          this._events.set(ev.id, ev);
          if (this.onEventNew) this.onEventNew(ev);
        }
      }
    }

    // --- Step4: アクティブイベントの推定震源を更新 ---
    for (const [id, ev] of this._events) {
      if (!ev.isActive(nowMs)) continue;
      if (ev.arrivals.length >= 3) {
        const result = _leastSquaresHypocenter(ev.arrivals, this.vp);
        if (result) {
          const updated = !ev.estimate || ev.estimate.nPts !== result.nPts;
          ev.estimate = result;
          if (updated && this.onEventUpdate) this.onEventUpdate(ev);
        }
      }
    }

    // --- Step5: 終了イベントの後処理 ---
    for (const [id, ev] of this._events) {
      if (!ev.isActive(nowMs)) {
        // 観測点の割り当て解除
        for (const idx of ev.stations) {
          this._stationEvent[idx] = null;
        }
        if (this.onEventEnd) this.onEventEnd(ev);
        this._events.delete(id);
      }
    }

    // --- Step6: 異常値除外の更新 ---
    this._updateAnomalies(vs, nowMs);
  }

  // ------------------------------------------------------------------
  // イベントマージ: other を target に吸収
  // ------------------------------------------------------------------
  _mergeEvents(targetId, otherId, nowMs) {
    const target = this._events.get(targetId);
    const other  = this._events.get(otherId);
    if (!target || !other) return;

    for (const idx of other.stations) {
      this._stationEvent[idx] = targetId;
      const arr = other.arrivals.find(a => a.idx === idx);
      if (arr && !target.stations.has(idx)) {
        target.arrivals.push(arr);
        target.stations.add(idx);
      }
    }
    if (other.maxLevel > target.maxLevel) {
      target.maxLevel = other.maxLevel;
      target.endMs = Math.max(target.endMs, nowMs + _holdMs(target.maxLevel));
    }
    this._events.delete(otherId);
  }

  // ------------------------------------------------------------------
  // 異常値除外: 検知中でない かつ 高値 かつ 変化量小 → 除外リストに追加
  // ------------------------------------------------------------------
  _updateAnomalies(vs, nowMs) {
    const anyDetecting = this._events.size > 0;
    if (anyDetecting) return; // 地震検知中は除外しない

    for (let i = 0; i < this.count; i++) {
      const v = vs[i];
      if (v < this.anomalyMinV) continue;

      const hist = this._history[i].filter(x => x >= 0);
      if (hist.length < 5) continue;
      const maxV = Math.max(...hist);
      const minV = Math.min(...hist);
      const rise = (_vToIntensity(maxV) ?? 0) - (_vToIntensity(minV) ?? 0);
      if (rise < this.anomalyMaxRise) {
        this._anomalies.add(i);
      }
    }

    // 異常値が収まったら除外を解除
    for (const i of this._anomalies) {
      const hist = this._history[i].filter(x => x >= 0);
      if (!hist.length) continue;
      const maxV = Math.max(...hist);
      const minV = Math.min(...hist);
      const rise = (_vToIntensity(maxV) ?? 0) - (_vToIntensity(minV) ?? 0);
      if (rise >= this.anomalyMaxRise) this._anomalies.delete(i);
    }
  }

  // ------------------------------------------------------------------
  // 公開プロパティ
  // ------------------------------------------------------------------
  get activeEvents() { return [...this._events.values()]; }
  get anomalyCount() { return this._anomalies.size; }
}

window.EqDetector = EqDetector;
