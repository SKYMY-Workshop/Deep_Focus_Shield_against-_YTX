// デフォルト設定
const DEFAULT_SETTINGS = {
  common: {
    enabled: true,
    alwaysOn: true,
    activeDays: [],
    timeSlots: [{start: '07:00', end: '12:00'}],
    grayscale: false,
    unlockDelay: false
  },
  youtube: {
    enabled: true,
    alwaysOn: true,
    activeDays: [],
    timeSlots: [{start: '07:00', end: '12:00'}],
    hideShorts: true,
    redirectHome: true,
    hideRelated: true,
    hideEndscreen: true,
    hideComments: true,
    disableAutoplay: false,
    hideHeaderBadges: false,
    hideMiniplayer: true
  },
  twitter: {
    enabled: true,
    alwaysOn: true,
    activeDays: [],
    timeSlots: [{start: '07:00', end: '12:00'}],
    hideRecommendations: false,
    hideTrends: true,
    stopAutoplay: false
  },
  tiktok: {
    block: true
  },
  darkMode: false
};

// 現在の設定を保持
let currentSettings = DEFAULT_SETTINGS;

// 設定を読み込む
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    currentSettings = result.settings || DEFAULT_SETTINGS;
  } catch (error) {
    console.error('設定の読み込みに失敗:', error);
  }
}

// 初期化
chrome.runtime.onInstalled.addListener(() => {
  loadSettings();
});

// 設定が更新されたときに再読み込み
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.settings) {
    currentSettings = changes.settings.newValue;
  }
});

// TikTokブロックの処理
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    await loadSettings();
    
    if (currentSettings.tiktok.block && details.frameId === 0) {
      // ブロックページにリダイレクト
      chrome.tabs.update(details.tabId, {
        url: `data:text/html,
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>TikTok Blocked</title>
          <style>
            body {
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            }
            .container {
              text-align: center;
              background: white;
              padding: 40px;
              border-radius: 20px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.1);
              max-width: 500px;
            }
            h1 {
              color: #667eea;
              font-size: 32px;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              font-size: 18px;
              line-height: 1.6;
            }
            .emoji {
              font-size: 64px;
              margin-bottom: 20px;
            }
            .button {
              display: inline-block;
              margin-top: 20px;
              padding: 12px 30px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 25px;
              font-weight: 500;
              transition: background 0.3s ease;
            }
            .button:hover {
              background: #764ba2;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="emoji">🧠</div>
            <h1>TikTok はブロックされています</h1>
            <p>創造的な活動に集中しましょう！<br>Anti Creative Information Shield が<br>あなたの時間を守っています。</p>
            <a href="javascript:history.back()" class="button">戻る</a>
          </div>
        </body>
        </html>`
      });
    }
  },
  {
    url: [
      { hostContains: 'tiktok.com' }
    ]
  }
);

// YouTubeホームページのリダイレクト処理
chrome.webNavigation.onCompleted.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    
    // YouTube Musicは除外
    const url = new URL(details.url);
    if (url.hostname === 'music.youtube.com') {
      return;
    }
    
    await loadSettings();
    
    if (shouldApplyRestrictions('youtube') && currentSettings.youtube.redirectHome) {
      // ホームページから登録チャンネルページへリダイレクト
      if (url.pathname === '/' || url.pathname === '/home') {
        chrome.tabs.update(details.tabId, {
          url: 'https://www.youtube.com/feed/subscriptions'
        });
      }
    }
  },
  {
    url: [
      { hostContains: 'youtube.com', hostSuffix: '.youtube.com' },
      { hostEquals: 'youtube.com' }
    ]
  }
);

// 制限を適用すべきかどうかを判定
function shouldApplyRestrictions(platform) {
  // 共通設定の常にONをチェック
  if (currentSettings.common?.alwaysOn) {
    return true;
  }
  
  const settings = currentSettings[platform];
  
  if (!settings || !settings.enabled) {
    return false;
  }
  
  // プラットフォーム固有の常にONをチェック
  if (settings.alwaysOn) {
    return true;
  }
  
  // 現在の日時を取得
  const now = new Date();
  const currentDay = now.getDay();
  const currentTime = now.getHours() * 60 + now.getMinutes();
  
  // 共通の時間制限をチェック
  if (currentSettings.common?.activeDays && currentSettings.common.activeDays.includes(currentDay)) {
    if (currentSettings.common?.timeSlots && currentSettings.common.timeSlots.length > 0) {
      for (const slot of currentSettings.common.timeSlots) {
        const [startHour, startMinute] = slot.start.split(':').map(Number);
        const [endHour, endMinute] = slot.end.split(':').map(Number);
        const startTimeMinutes = startHour * 60 + startMinute;
        const endTimeMinutes = endHour * 60 + endMinute;
        
        // 時間範囲内かチェック
        if (endTimeMinutes > startTimeMinutes) {
          if (currentTime >= startTimeMinutes && currentTime <= endTimeMinutes) {
            return true;
          }
        } else {
          if (currentTime >= startTimeMinutes || currentTime <= endTimeMinutes) {
            return true;
          }
        }
      }
    }
  }
  
  return false;
}

// 初回起動時に設定を読み込む
loadSettings();
