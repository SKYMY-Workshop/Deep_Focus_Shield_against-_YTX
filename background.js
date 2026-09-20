// Deep Focus Shield — background service worker
//
// 設定の既定値・マージ・時間帯判定は settings-defaults.js に集約している。
importScripts('settings-defaults.js');

let currentSettings = dfsMergeSettings(null);

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    currentSettings = dfsMergeSettings(result.settings);
  } catch (error) {
    console.error('Deep Focus Shield: 設定の読み込みに失敗:', error);
  }
}

// MV3のservice workerは停止・再起動するため、起動経路ごとに読み直す
chrome.runtime.onInstalled.addListener(loadSettings);
chrome.runtime.onStartup.addListener(loadSettings);
loadSettings();

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.settings) {
    currentSettings = dfsMergeSettings(changes.settings.newValue);
  }
});

// =============== TikTokブロック ===============

// 以前は data: URL に遷移させていたが、Chromeはトップフレームの data: URL
// 遷移を禁止しているため拡張内のページに差し替えた。
const BLOCKED_PAGE_URL = chrome.runtime.getURL('blocked.html');

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;

    await loadSettings();
    if (!currentSettings.tiktok?.block) return;

    chrome.tabs.update(details.tabId, { url: BLOCKED_PAGE_URL })
      .catch(() => { /* タブが既に閉じられている等は無視 */ });
  },
  { url: [{ hostContains: 'tiktok.com' }] }
);

// =============== YouTubeホームのリダイレクト ===============

const YOUTUBE_HOME_PATHS = new Set(['/', '/home']);
const YOUTUBE_SUBSCRIPTIONS_URL = 'https://www.youtube.com/feed/subscriptions';

async function maybeRedirectYouTubeHome(details) {
  if (details.frameId !== 0) return;

  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }

  // YouTube Musicは対象外
  if (url.hostname === 'music.youtube.com') return;
  if (!YOUTUBE_HOME_PATHS.has(url.pathname)) return;

  await loadSettings();
  if (!dfsShouldApplyRestrictions(currentSettings, 'youtube')) return;
  if (!currentSettings.youtube?.redirectHome) return;

  chrome.tabs.update(details.tabId, { url: YOUTUBE_SUBSCRIPTIONS_URL })
    .catch(() => { /* タブが既に閉じられている等は無視 */ });
}

const YOUTUBE_NAV_FILTER = {
  url: [
    { hostSuffix: '.youtube.com' },
    { hostEquals: 'youtube.com' }
  ]
};

// onCompleted だとホームを描画し切ってから飛ばすことになり、
// おすすめ動画が一瞬見えてしまう。描画前の onBeforeNavigate で捕まえる。
chrome.webNavigation.onBeforeNavigate.addListener(maybeRedirectYouTubeHome, YOUTUBE_NAV_FILTER);
// YouTubeはSPAなので、ロゴクリック等のページ内遷移はこちらで拾う。
chrome.webNavigation.onHistoryStateUpdated.addListener(maybeRedirectYouTubeHome, YOUTUBE_NAV_FILTER);

// =============== スヌーズの無音適用 ===============
//
// ポップアップの「今すぐ適用」は、ユーザーが見ている画面に一切触れずに処理したい。
// そこで非アクティブのタブで x.com/home を開き、content script に処理させ、
// 終わったらこのタブを閉じる。
//
// Xはバックグラウンドタブ（document.hidden === true）でも通常通り描画するため、
// タイムラインもスヌーズダイアログも問題なく操作できる（実測で1秒弱）。
//
// service worker は停止しうるので、作業用タブのIDはメモリではなく
// chrome.storage.session に持たせる。
const SILENT_TAB_KEY = 'silentSnoozeTabIds';

async function getSilentTabIds() {
  try {
    const stored = await chrome.storage.session.get(SILENT_TAB_KEY);
    const ids = stored[SILENT_TAB_KEY];
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

async function setSilentTabIds(ids) {
  try {
    await chrome.storage.session.set({ [SILENT_TAB_KEY]: ids });
  } catch { /* session storage が使えない環境では諦める */ }
}

async function openSilentSnoozeTab() {
  const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
  const ids = await getSilentTabIds();
  ids.push(tab.id);
  await setSilentTabIds(ids);

  // content script が応答しなかった場合の保険。作業用タブを残さない。
  setTimeout(async () => {
    const current = await getSilentTabIds();
    if (current.includes(tab.id)) {
      await setSilentTabIds(current.filter(id => id !== tab.id));
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }, 60000);

  return tab.id;
}

// 自分が開いた作業用タブのときだけ閉じる。ユーザーのタブは絶対に閉じない。
async function closeSilentSnoozeTab(tabId) {
  const ids = await getSilentTabIds();
  if (!ids.includes(tabId)) return false;

  await setSilentTabIds(ids.filter(id => id !== tabId));
  chrome.tabs.remove(tabId).catch(() => {});
  return true;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ids = await getSilentTabIds();
  if (ids.includes(tabId)) {
    await setSilentTabIds(ids.filter(id => id !== tabId));
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openSilentSnoozeTab') {
    openSilentSnoozeTab()
      .then(tabId => sendResponse({ ok: true, tabId }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.action === 'snoozeApplyFinished') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ closed: false });
      return true;
    }
    finishSilentSnooze(tabId, !!request.committed)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ closed: false }));
    return true;
  }
});

// 作業用タブを閉じ、スヌーズを確定できていたら他のXタブをリロードする。
// スヌーズはリロードしないとタイムラインに反映されないため。
async function finishSilentSnooze(workerTabId, committed) {
  const closed = await closeSilentSnoozeTab(workerTabId);

  if (!committed) {
    return { closed, reloaded: 0, skipped: [] };
  }

  const summary = await reloadOpenXTabs(workerTabId);
  await mergeReloadSummary(summary);
  return { closed, ...summary };
}

// 開いているXタブにリロードを依頼する。
// 実際にリロードするかは各タブの content script が判断する
// （書きかけの投稿があるタブはリロードしない）。
async function reloadOpenXTabs(excludeTabId) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  } catch {
    return { reloaded: 0, skipped: [] };
  }

  const silentIds = await getSilentTabIds();
  const targets = tabs.filter(t =>
    t.id !== excludeTabId && !silentIds.includes(t.id)
  );

  const results = await Promise.all(targets.map(tab =>
    chrome.tabs.sendMessage(tab.id, { action: 'reloadForSnooze' })
      .catch(() => ({ reloaded: false, reason: '応答なし' }))
  ));

  return {
    reloaded: results.filter(r => r?.reloaded).length,
    skipped: results.filter(r => r && !r.reloaded).map(r => r.reason || '不明')
  };
}

// ポップアップに出すため、リロード結果を lastSnoozeResult に足す。
// content script が先に書いているので、読んでから足す。
async function mergeReloadSummary(summary) {
  try {
    const { lastSnoozeResult } = await chrome.storage.local.get('lastSnoozeResult');
    if (!lastSnoozeResult) return;
    await chrome.storage.local.set({
      lastSnoozeResult: { ...lastSnoozeResult, reload: summary }
    });
  } catch { /* 失敗しても本処理には影響しない */ }
}
