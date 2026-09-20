// YouTube Content Script (Overlay Strategy)
//
// 設定の既定値・マージ・時間帯判定は settings-defaults.js に集約している。

let settings = null;
let observer = null;
let debounceTimer = null;

// このスクリプトが inline style で隠した要素と、その元の値。
// 制限時間が終わったときに確実に戻せるようにするための台帳。
const hiddenElements = new Map();

function setInlineStyles(el, styles) {
  if (!el) return;
  const saved = hiddenElements.get(el) || {};
  for (const prop of Object.keys(styles)) {
    if (!(prop in saved)) saved[prop] = el.style[prop];
  }
  hiddenElements.set(el, saved);
  for (const [prop, value] of Object.entries(styles)) {
    el.style[prop] = value;
  }
}

function hideElement(el) {
  setInlineStyles(el, { display: 'none' });
}

// 書き換えた inline style をすべて元に戻す。
// 以前は解除時にbodyクラスを外すだけで inline style が残り、
// 制限時間を過ぎてもリロードするまで関連動画とコメントが消えたままだった。
function unhideAllElements() {
  for (const [el, saved] of hiddenElements) {
    for (const [prop, value] of Object.entries(saved)) {
      el.style[prop] = value;
    }
  }
  hiddenElements.clear();
}

// 設定を読み込む
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    settings = dfsMergeSettings(result.settings);
    applyRestrictions();
  } catch (error) {
    console.error('Deep Focus Shield (YouTube): 設定の読み込みに失敗:', error);
  }
}

// 制限を適用すべきか判定（判定ロジックは settings-defaults.js に集約）
function shouldApplyRestrictions() {
  return dfsShouldApplyRestrictions(settings, 'youtube');
}

const BODY_CLASSES = [
  'acis-youtube-active',
  'acis-youtube-shorts-hidden',
  'acis-youtube-related-hidden',
  'acis-youtube-endscreen-hidden',
  'acis-youtube-comments-hidden',
  'acis-youtube-miniplayer-hidden',
  'acis-grayscale'
];

// 制限を適用
function applyRestrictions() {
  if (!settings) return;

  if (!shouldApplyRestrictions()) {
    document.body.classList.remove(...BODY_CLASSES);
    unhideAllElements();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    return;
  }

  // 前回隠した要素を一度すべて戻してから貼り直す。
  // こうしないと、トグルをOFFにしても inline style が残って消えたままになる。
  // 同期処理なので途中で再描画は挟まらない。
  unhideAllElements();

  document.body.classList.add('acis-youtube-active');

  // CSSクラスで制御する機能
  toggleBodyClass('acis-grayscale', settings.common?.grayscale);
  toggleBodyClass('acis-youtube-shorts-hidden', settings.youtube.hideShorts);
  toggleBodyClass('acis-youtube-related-hidden', settings.youtube.hideRelated);
  toggleBodyClass('acis-youtube-endscreen-hidden', settings.youtube.hideEndScreen);
  toggleBodyClass('acis-youtube-comments-hidden', settings.youtube.hideComments);
  toggleBodyClass('acis-youtube-miniplayer-hidden', settings.youtube.hideMiniplayer);

  // DOM操作で制御する機能
  applyDomHiding();

  if (!observer) {
    startObserver();
  }
}

// DOM操作による非表示処理をまとめて適用する
function applyDomHiding() {
  if (!settings) return;
  if (settings.youtube.hideShorts) hideShorts();
  if (settings.youtube.hideRelated) hideRelatedVideos();
  if (settings.youtube.hideComments) hideComments();
}

// ヘルパー関数: クラスの切り替え
function toggleBodyClass(className, condition) {
  if (condition) {
    document.body.classList.add(className);
  } else {
    document.body.classList.remove(className);
  }
}

// --- 以下、DOM操作関数 ---

function hideShorts() {
  document.querySelectorAll('[title="Shorts"], [aria-label*="Shorts"]').forEach(el => {
    hideElement(el.closest('ytd-rich-section-renderer, ytd-reel-shelf-renderer'));
  });

  const shortsTab = document.querySelector('a[title="Shorts"]');
  if (shortsTab) {
    hideElement(shortsTab.closest('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer'));
  }

  document.querySelectorAll('a[href*="/shorts/"]').forEach(video => {
    hideElement(video.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer'));
  });
}

function hideRelatedVideos() {
  hideElement(document.querySelector('#secondary'));
  hideElement(document.querySelector('#related'));
  // 関連動画を消した分だけ本編を広げる
  setInlineStyles(document.querySelector('#primary'), { maxWidth: '100%' });
}

function hideComments() {
  document.querySelectorAll('#comments, ytd-comments, #comment-section').forEach(hideElement);
}

// DOMの変更を監視（デバウンス付き）
function startObserver() {
  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyDomHiding, 200);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSettings);
} else {
  loadSettings();
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'updateSettings') {
    settings = dfsMergeSettings(request.settings);
    applyRestrictions();
  }
});

// 定期的に制限状態をチェック（時間制限のため）
setInterval(() => {
  if (settings) applyRestrictions();
}, 60000);
