// Deep Focus Shield — 設定の既定値と共通ロジック
//
// background / popup / 各 content script から読み込まれる唯一の定義元。
// 以前は4ファイルに DEFAULT_SETTINGS が重複しており、
// background だけキー名が hideEndscreen（小文字s）でズレていた。

const DFS_DEFAULT_SETTINGS = {
  // 曜日・時間帯の設定はここにしか無い。
  // ポップアップの時間設定UIも data-platform="common" の1組だけ。
  common: {
    enabled: true,
    alwaysOn: true,
    activeDays: [],
    timeSlots: [{ start: '07:00', end: '12:00' }],
    grayscale: false
  },
  youtube: {
    enabled: true,
    hideShorts: true,
    redirectHome: false,
    hideRelated: true,
    hideEndScreen: true,
    hideComments: false,
    hideMiniplayer: true
  },
  twitter: {
    enabled: true,
    defaultFollowing: true,
    // 既定タイムラインにしたいリストのタブ名。
    // 名前はユーザーごとに違うのでテキストで持つ。
    defaultListEnabled: false,
    defaultListName: '',
    hideRecommendations: false,
    hideTrends: true,
    // 保存したスヌーズ状態を、ページを開いたときに自動で貼り直すか
    autoReapplySnooze: true
  },
  tiktok: {
    block: true
  },
  darkMode: false
};

// 保存済み設定に既定値を補い、必ず完全な形にして返す。
// 旧バージョンが保存した設定や、一部キーを欠いた設定でも
// settings.youtube.redirectHome のような参照が例外にならないことを保証する。
function dfsMergeSettings(stored) {
  const merged = JSON.parse(JSON.stringify(DFS_DEFAULT_SETTINGS));
  if (!stored || typeof stored !== 'object') return merged;

  for (const key of Object.keys(merged)) {
    const value = stored[key];
    if (value === undefined) continue;

    const isPlainObject = v =>
      v !== null && typeof v === 'object' && !Array.isArray(v);

    if (isPlainObject(value) && isPlainObject(merged[key])) {
      Object.assign(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// 指定プラットフォームに制限を適用すべきかを判定する。
//
// 曜日・時間帯はすべて共通設定（common）で決まる。
// ポップアップに存在する時間設定は data-platform="common" の1組だけで、
// プラットフォームごとの時間設定UIは存在しない。
//
// 以前はここで platformSettings.alwaysOn を見ており、
// その既定値が true のうえUIから切る手段が無かったため、
// 共通の「常にON」を外しても必ず true で打ち切られ、
// 曜日・時間帯の設定が一切反映されない状態だった。
function dfsShouldApplyRestrictions(settings, platform, now = new Date()) {
  if (!settings) return false;

  // プラットフォームごとの有効/無効（現状UIは無く常にtrue。将来のkill-switch用）
  const platformSettings = settings[platform];
  if (!platformSettings || !platformSettings.enabled) return false;

  const common = settings.common || {};
  if (common.alwaysOn) return true;

  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  if (!common.activeDays?.includes(day)) return false;

  for (const slot of (common.timeSlots || [])) {
    const [startHour, startMinute] = String(slot?.start).split(':').map(Number);
    const [endHour, endMinute] = String(slot?.end).split(':').map(Number);
    if ([startHour, startMinute, endHour, endMinute].some(Number.isNaN)) continue;

    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;

    if (end > start) {
      if (minutes >= start && minutes <= end) return true;
    } else {
      // 終了が開始以下なら日をまたぐ範囲とみなす（例 22:00〜02:00）
      if (minutes >= start || minutes <= end) return true;
    }
  }

  return false;
}
