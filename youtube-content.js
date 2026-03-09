// YouTube Content Script (Overlay Strategy)

let settings = null;

// デフォルト設定
const DEFAULT_SETTINGS = {
  common: {
    enabled: true,
    alwaysOn: true,
    activeDays: [],
    timeSlots: [{start: '07:00', end: '12:00'}],
    grayscale: false
  },
  youtube: {
    enabled: true,
    alwaysOn: true,
    activeDays: [],
    timeSlots: [{start: '07:00', end: '12:00'}],
    hideShorts: true,
    redirectHome: true,
    hideRelated: true,
    hideEndScreen: true,
    hideComments: true,
    hideMiniplayer: true
  }
};

// 設定を読み込む
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    if (result.settings) {
      settings = result.settings;
      if (settings.youtube && settings.youtube.hideEndScreen === undefined) {
        settings.youtube.hideEndScreen = true;
      }
      if (settings.youtube && settings.youtube.hideMiniplayer === undefined) {
        settings.youtube.hideMiniplayer = true;
      }
    } else {
      settings = DEFAULT_SETTINGS;
    }
    applyRestrictions();
  } catch (error) {
    console.error('YouTube: 設定の読み込みに失敗:', error);
  }
}

// 制限を適用すべきか判定
function shouldApplyRestrictions() {
  if (settings?.common?.alwaysOn) return true;
  if (!settings || !settings.youtube || !settings.youtube.enabled) return false;
  if (settings.youtube.alwaysOn) return true;

  const now = new Date();
  const currentDay = now.getDay();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  if (settings.common && settings.common.activeDays?.includes(currentDay)) {
    for (const slot of (settings.common.timeSlots || [])) {
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      if (end > start) {
        if (currentTime >= start && currentTime <= end) return true;
      } else {
        if (currentTime >= start || currentTime <= end) return true;
      }
    }
  }
  
  if (settings.youtube.activeDays?.includes(currentDay)) {
    for (const slot of (settings.youtube.timeSlots || [])) {
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      if (end > start) {
        if (currentTime >= start && currentTime <= end) return true;
      } else {
        if (currentTime >= start || currentTime <= end) return true;
      }
    }
  }
  return false;
}

// 制限を適用
function applyRestrictions() {
  const isRestricted = shouldApplyRestrictions();
  
  // クラスの着脱処理
  if (!isRestricted) {
    document.body.classList.remove(
      'acis-youtube-active',
      'acis-youtube-shorts-hidden',
      'acis-youtube-related-hidden',
      'acis-youtube-endscreen-hidden',
      'acis-youtube-comments-hidden',
      'acis-youtube-miniplayer-hidden',
      'acis-grayscale'
    );
    return;
  }
  
  document.body.classList.add('acis-youtube-active');
  
  // 各機能の適用（CSSクラスの付与のみで制御）
  toggleBodyClass('acis-grayscale', settings.common?.grayscale);
  toggleBodyClass('acis-youtube-shorts-hidden', settings.youtube.hideShorts);
  toggleBodyClass('acis-youtube-related-hidden', settings.youtube.hideRelated);
  toggleBodyClass('acis-youtube-endscreen-hidden', settings.youtube.hideEndScreen !== false);
  toggleBodyClass('acis-youtube-comments-hidden', settings.youtube.hideComments);
  toggleBodyClass('acis-youtube-miniplayer-hidden', settings.youtube.hideMiniplayer !== false);

  // Shortsと関連動画のDOM操作（こちらは既存のまま維持）
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

// --- 以下、既存のDOM操作関数 ---

function hideShorts() {
  const shortsShelf = document.querySelectorAll('[title="Shorts"], [aria-label*="Shorts"]');
  shortsShelf.forEach(el => {
    const section = el.closest('ytd-rich-section-renderer, ytd-reel-shelf-renderer');
    if (section) section.style.display = 'none';
  });
  const shortsTab = document.querySelector('a[title="Shorts"]');
  if (shortsTab) {
    const entry = shortsTab.closest('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer');
    if (entry) entry.style.display = 'none';
  }
  const shortsVideos = document.querySelectorAll('a[href*="/shorts/"]');
  shortsVideos.forEach(video => {
    const renderer = video.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer');
    if (renderer) renderer.style.display = 'none';
  });
}

function hideRelatedVideos() {
  const secondary = document.querySelector('#secondary, #related, #secondary-inner');
  if (secondary) secondary.style.display = 'none';
  const primary = document.querySelector('#primary');
  if (primary) primary.style.maxWidth = '100%';
}

function hideComments() {
  const comments = document.querySelector('#comments, ytd-comments, ytd-comments#comments');
  if (comments) comments.style.display = 'none';
  const commentElements = document.querySelectorAll('ytd-comments, #comment-section, .ytd-comments');
  commentElements.forEach(el => el.style.display = 'none');
}

// 監視の設定
const observer = new MutationObserver(() => {
  if (settings) applyRestrictions();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    observer.observe(document.body, { childList: true, subtree: true });
  });
} else {
  loadSettings();
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateSettings') {
    settings = request.settings;
    if (settings && settings.youtube && settings.youtube.hideEndScreen === undefined) {
      settings.youtube.hideEndScreen = true;
    }
    if (settings && settings.youtube && settings.youtube.hideMiniplayer === undefined) {
      settings.youtube.hideMiniplayer = true;
    }
    applyRestrictions();
  }
});

setInterval(() => {
  if (settings) applyRestrictions();
}, 60000);
