// Deep Focus Shield — ポップアップ
//
// 設定の既定値とマージは settings-defaults.js に集約している。

let currentSettings = dfsMergeSettings(null);

// =============== 読み込み ===============

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    currentSettings = dfsMergeSettings(result.settings);

    // ダークモード
    if (currentSettings.darkMode) {
      document.body.classList.add('dark-mode');
      document.getElementById('dark-mode-toggle').textContent = '☀️';
    }

    // 共通設定
    applyPlatformSettings('common');
    document.getElementById('common-grayscale').checked = currentSettings.common.grayscale;

    // YouTube設定
    document.getElementById('youtube-hide-shorts').checked = currentSettings.youtube.hideShorts;
    document.getElementById('youtube-redirect-home').checked = currentSettings.youtube.redirectHome;
    document.getElementById('youtube-hide-related').checked = currentSettings.youtube.hideRelated;
    document.getElementById('youtube-hide-endscreen').checked = currentSettings.youtube.hideEndScreen;
    document.getElementById('youtube-hide-comments').checked = currentSettings.youtube.hideComments;
    document.getElementById('youtube-hide-miniplayer').checked = currentSettings.youtube.hideMiniplayer;

    // X(Twitter)設定
    document.getElementById('twitter-default-following').checked = currentSettings.twitter.defaultFollowing;
    document.getElementById('twitter-default-list-enabled').checked = currentSettings.twitter.defaultListEnabled;
    document.getElementById('twitter-default-list-name').value = currentSettings.twitter.defaultListName || '';

    // この機能より前に保存された設定では両方ONになりうる。
    // content script はリストを優先するので、表示もそれに揃える。
    if (currentSettings.twitter.defaultListEnabled && currentSettings.twitter.defaultFollowing) {
      document.getElementById('twitter-default-following').checked = false;
    }
    updateListInputState();
    document.getElementById('twitter-hide-recommendations').checked = currentSettings.twitter.hideRecommendations;
    document.getElementById('twitter-hide-trends').checked = currentSettings.twitter.hideTrends;
    document.getElementById('twitter-auto-reapply-snooze').checked = currentSettings.twitter.autoReapplySnooze;

    // TikTok設定
    document.getElementById('tiktok-block').checked = currentSettings.tiktok.block;

  } catch (error) {
    console.error('設定の読み込みに失敗しました:', error);
    showStatus('設定の読み込みに失敗しました', 'error');
  }
}

// プラットフォームごとの設定を適用（時間設定は共通のみ）
function applyPlatformSettings(platform) {
  if (platform !== 'common') return;

  const settings = currentSettings[platform];
  if (!settings) return;

  document.getElementById(`${platform}-always-on`).checked = settings.alwaysOn;

  // 曜日設定
  document.querySelectorAll(`[data-platform="${platform}"]`).forEach(checkbox => {
    const day = parseInt(checkbox.dataset.day);
    checkbox.checked = settings.activeDays?.includes(day) || false;
  });

  // 時間スロット
  const timeSlotsContainer = document.getElementById(`${platform}-time-slots`);
  timeSlotsContainer.innerHTML = '';

  const timeSlots = settings.timeSlots?.length
    ? settings.timeSlots
    : [{ start: '07:00', end: '12:00' }];

  timeSlots.forEach((slot, index) => {
    addTimeSlot(platform, slot, index > 0);
  });
}

// 時間スロットを追加
function addTimeSlot(platform, slot = { start: '21:00', end: '24:00' }, showRemove = true) {
  const container = document.getElementById(`${platform}-time-slots`);
  const div = document.createElement('div');
  div.className = 'time-selector';
  div.innerHTML = `
    <span>制限時間：</span>
    <input type="time" class="start-time" value="${slot.start}">
    <span>～</span>
    <input type="time" class="end-time" value="${slot.end}">
    <button class="remove-time-btn" ${showRemove ? '' : 'style="display:none;"'}>✕</button>
  `;

  if (showRemove) {
    div.querySelector('.remove-time-btn').addEventListener('click', () => {
      div.remove();
      scheduleSave();
    });
  }

  // 時刻入力は1文字ごとにイベントが飛ぶのでデバウンス経由で保存する。
  // 以前はここで 'change'、DOMContentLoaded側で 'input' を二重に張っており、
  // 入力のたびに storage.sync.set と全タブへの送信が走っていた
  // （storage.sync は毎分120回の書き込み上限がある）。
  div.querySelectorAll('input[type="time"]').forEach(input => {
    input.addEventListener('input', scheduleSave);
  });

  container.appendChild(div);
}

// =============== 保存 ===============

let saveTimer = null;

// 連続した入力をまとめて1回だけ保存する
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}

// 旧バージョンが保存したプラットフォーム別のスケジュールキーを落とす。
// 判定は共通設定のみを見るようになったので、残しておくと紛らわしい。
function stripLegacyScheduleKeys(section) {
  const { alwaysOn, activeDays, timeSlots, ...rest } = section || {};
  return rest;
}

function collectCommonSchedule() {
  const activeDays = [];
  document.querySelectorAll('[data-platform="common"]:checked').forEach(checkbox => {
    activeDays.push(parseInt(checkbox.dataset.day));
  });

  const timeSlots = [];
  document.querySelectorAll('#common-time-slots .time-selector').forEach(selector => {
    timeSlots.push({
      start: selector.querySelector('.start-time').value,
      end: selector.querySelector('.end-time').value
    });
  });

  return { activeDays, timeSlots };
}

async function saveSettings() {
  try {
    const { activeDays, timeSlots } = collectCommonSchedule();

    // ポップアップが操作するキーだけを上書きし、それ以外は保持する。
    // 以前はここで youtube / twitter を作り直しており、
    // 保存のたびに alwaysOn・activeDays・timeSlots が消えていた。
    // その結果、共通の「常にON」を外すと両方の制限が一切効かなくなっていた。
    const settings = {
      ...currentSettings,
      common: {
        ...currentSettings.common,
        enabled: true,
        alwaysOn: document.getElementById('common-always-on').checked,
        activeDays,
        timeSlots,
        grayscale: document.getElementById('common-grayscale').checked
      },
      youtube: {
        ...stripLegacyScheduleKeys(currentSettings.youtube),
        enabled: true,
        hideShorts: document.getElementById('youtube-hide-shorts').checked,
        redirectHome: document.getElementById('youtube-redirect-home').checked,
        hideRelated: document.getElementById('youtube-hide-related').checked,
        hideEndScreen: document.getElementById('youtube-hide-endscreen').checked,
        hideComments: document.getElementById('youtube-hide-comments').checked,
        hideMiniplayer: document.getElementById('youtube-hide-miniplayer').checked
      },
      twitter: {
        ...stripLegacyScheduleKeys(currentSettings.twitter),
        enabled: true,
        defaultFollowing: document.getElementById('twitter-default-following').checked,
        defaultListEnabled: document.getElementById('twitter-default-list-enabled').checked,
        defaultListName: document.getElementById('twitter-default-list-name').value.trim(),
        hideRecommendations: document.getElementById('twitter-hide-recommendations').checked,
        hideTrends: document.getElementById('twitter-hide-trends').checked,
        autoReapplySnooze: document.getElementById('twitter-auto-reapply-snooze').checked
      },
      tiktok: {
        ...currentSettings.tiktok,
        block: document.getElementById('tiktok-block').checked
      },
      darkMode: document.body.classList.contains('dark-mode')
    };

    currentSettings = settings;
    await chrome.storage.sync.set({ settings });

    await notifyTabs(settings);
    showStatus('設定を保存しました', 'success');

  } catch (error) {
    console.error('設定の保存に失敗しました:', error);
    showStatus('設定の保存に失敗しました', 'error');
  }
}

// 対象タブに設定更新を通知する
async function notifyTabs(settings) {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://*.youtube.com/*',
        'https://twitter.com/*',
        'https://x.com/*'
      ]
    });

    await Promise.all(tabs.map(tab =>
      chrome.tabs.sendMessage(tab.id, { action: 'updateSettings', settings })
        .catch(() => { /* content scriptが未注入のタブは無視 */ })
    ));
  } catch (error) {
    console.log('タブへの通知に失敗しました:', error);
  }
}

// =============== 既定タイムラインのリスト指定 ===============

// 既定タイムラインは1つしか選べないので、2つのトグルを排他にする。
//
// ONにしたときだけ相手をOFFにする。OFFにしたときは相手に触らない
// （両方OFF＝既定の切り替えをしない、という状態を許すため）。
//
// checked を代入しても change イベントは発火しないので、
// 保存の二重実行にはならない。saveSettings は保存時点のDOMを読む。
function enforceDefaultTimelineExclusivity(turnedOnId) {
  const following = document.getElementById('twitter-default-following');
  const list = document.getElementById('twitter-default-list-enabled');

  if (turnedOnId === 'twitter-default-list-enabled' && list.checked) {
    following.checked = false;
  } else if (turnedOnId === 'twitter-default-following' && following.checked) {
    list.checked = false;
  }
}

// トグルがOFFのときは入力欄を触れないようにして、状態を明示する
function updateListInputState() {
  const enabled = document.getElementById('twitter-default-list-enabled').checked;
  const input = document.getElementById('twitter-default-list-name');
  const hint = document.getElementById('twitter-list-hint');

  input.disabled = !enabled;

  if (!enabled) {
    hint.textContent = '';
    return;
  }
  if (!input.value.trim()) {
    hint.textContent = '※リスト名が未入力です。入力するまで「フォロー中」が使われます';
    return;
  }
  hint.textContent = '';
}

// 開いているXタブから現在のタブ名を取得して入力候補に出す。
// リスト名はユーザーごとに違ううえ、表記ゆれで一致しないと機能しないため。
async function loadTabCandidates() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    const target = tabs.find(t => t.url.includes('/home')) || tabs[0];
    if (!target) return;

    const response = await chrome.tabs.sendMessage(target.id, { action: 'getTimelineTabs' });
    if (!response?.ok || !response.names?.length) return;

    const datalist = document.getElementById('twitter-tab-candidates');
    datalist.innerHTML = '';
    // 「おすすめ」「フォロー中」は候補から除く（専用のトグルがあるため）
    const excluded = ['おすすめ', 'For you', 'フォロー中', 'Following'];
    response.names
      .filter(name => !excluded.includes(name))
      .forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        datalist.appendChild(option);
      });
  } catch {
    // Xのタブが無い、content scriptが未注入などは無視する
  }
}

// =============== 表示 ===============

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status show ${type}`;

  setTimeout(() => {
    status.classList.remove('show');
  }, 3000);
}

// スヌーズ状態をポップアップに表示する
async function loadSnoozeStatus() {
  const { snoozedTopics } = await chrome.storage.local.get(['snoozedTopics']);
  const lastAppliedEl = document.getElementById('snooze-last-applied-text');
  const topicsListEl = document.getElementById('snooze-topics-list');

  topicsListEl.innerHTML = '';

  if (!snoozedTopics?.topics?.length) {
    lastAppliedEl.textContent = '未設定';
    return;
  }

  const date = new Date(snoozedTopics.lastApplied);
  const formatted = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 保存`;
  lastAppliedEl.textContent = formatted;

  const snoozedOnly = snoozedTopics.topics.filter(t => t.snoozed);
  if (snoozedOnly.length === 0) {
    lastAppliedEl.textContent += '（スヌーズ中のトピックなし）';
    return;
  }

  snoozedOnly.forEach(t => {
    const tag = document.createElement('span');
    tag.className = 'snooze-topic-tag';
    tag.textContent = t.name;
    topicsListEl.appendChild(tag);
  });
}

// 直近の「今すぐ適用」の結果を表示する。
// content script 側が lastSnoozeResult に書いたものを読むだけ。
async function loadSnoozeResult() {
  const { lastSnoozeResult, pendingSnoozeApply } =
    await chrome.storage.local.get(['lastSnoozeResult', 'pendingSnoozeApply']);
  const el = document.getElementById('snooze-result-text');

  if (pendingSnoozeApply) {
    el.textContent = '適用待ち：Xのホームを読み込んだ時点で実行されます';
    return;
  }
  if (!lastSnoozeResult) {
    el.textContent = '';
    return;
  }

  const d = new Date(lastSnoozeResult.at);
  const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  if (!lastSnoozeResult.ok) {
    el.textContent = `${time} 失敗: ${lastSnoozeResult.error}`;
    return;
  }
  if (!lastSnoozeResult.attempted) {
    el.textContent = `${time} 差分なし（${lastSnoozeResult.total}件とも保存状態と一致）`;
    return;
  }

  let message = `${time} ${lastSnoozeResult.changed.length}件を操作: ${lastSnoozeResult.changed.join('、')}`;
  if (lastSnoozeResult.failed > 0) {
    message += ` ／ ${lastSnoozeResult.failed}件はトグルが動きませんでした`;
  }

  // 確定ボタンを押せたかどうかが本質。押せていなければX側に保存されていない。
  if (lastSnoozeResult.committed) {
    message += ` ／ 確定済み（${lastSnoozeResult.commitLabel}）`;
  } else {
    message += ` ／ 確定できず変更は破棄されました${lastSnoozeResult.commitError ? '：' + lastSnoozeResult.commitError : ''}`;
  }

  // 開いていたXタブのリロード結果
  const reload = lastSnoozeResult.reload;
  if (reload) {
    if (reload.reloaded > 0) {
      message += ` ／ Xタブ${reload.reloaded}件をリロード`;
    }
    if (reload.skipped?.length) {
      const reasons = [...new Set(reload.skipped)].join('、');
      message += ` ／ ${reload.skipped.length}件は据え置き（${reasons}）`;
    }
  }

  el.textContent = message;
}

// 「今すぐ適用」。
//
// ユーザーが見ている画面には一切触れない。
// background に非アクティブのタブを開いてもらい、そこの content script が
// 予約フラグを見て処理し、終わったらそのタブを閉じる。
// ポップアップは結果を待たない（フォーカスを失うと閉じてJSごと破棄されるため）。
async function requestImmediateApply() {
  const { snoozedTopics } = await chrome.storage.local.get(['snoozedTopics']);
  if (!snoozedTopics?.topics?.length) {
    showStatus('保存されたスヌーズ設定がありません。先に下のボタンで保存してください。', 'error');
    return;
  }

  await chrome.storage.local.remove('lastSnoozeResult');
  await chrome.storage.local.set({ pendingSnoozeApply: { silent: true } });

  const response = await chrome.runtime.sendMessage({ action: 'openSilentSnoozeTab' });
  if (!response?.ok) {
    await chrome.storage.local.remove('pendingSnoozeApply');
    showStatus(`適用を開始できませんでした: ${response?.error || '不明なエラー'}`, 'error');
    return;
  }

  showStatus('バックグラウンドで適用しています…', 'success');
  watchSnoozeResult();
}

// 適用中はポップアップが開いている間だけ結果をポーリングして表示を更新する。
// 閉じられても content script 側の処理は続き、結果は lastSnoozeResult に残る。
let resultWatchTimer = null;

function watchSnoozeResult(timeoutMs = 20000) {
  clearInterval(resultWatchTimer);
  const startedAt = Date.now();

  resultWatchTimer = setInterval(async () => {
    const { lastSnoozeResult, pendingSnoozeApply } =
      await chrome.storage.local.get(['lastSnoozeResult', 'pendingSnoozeApply']);

    if (lastSnoozeResult) {
      clearInterval(resultWatchTimer);
      await loadSnoozeResult();
      await loadSnoozeStatus();
      return;
    }
    if (!pendingSnoozeApply && Date.now() - startedAt > 3000) {
      clearInterval(resultWatchTimer);
      await loadSnoozeResult();
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      clearInterval(resultWatchTimer);
      document.getElementById('snooze-result-text').textContent =
        '応答がありません。Xのホームが開けているか確認してください。';
    }
  }, 500);
}

// =============== 初期化 ===============

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadSnoozeStatus();
  loadSnoozeResult();
  loadTabCandidates();

  // 既定タイムラインの2つのトグルは排他
  document.getElementById('twitter-default-list-enabled').addEventListener('change', () => {
    enforceDefaultTimelineExclusivity('twitter-default-list-enabled');
    updateListInputState();
  });
  document.getElementById('twitter-default-following').addEventListener('change', () => {
    enforceDefaultTimelineExclusivity('twitter-default-following');
    updateListInputState();
  });
  document.getElementById('twitter-default-list-name').addEventListener('input', () => {
    updateListInputState();
    scheduleSave();
  });

  // ポップアップを閉じている間に適用が走っていた場合に備えて監視する
  chrome.storage.local.get('pendingSnoozeApply').then(({ pendingSnoozeApply }) => {
    if (pendingSnoozeApply) watchSnoozeResult();
  });

  // ダークモード切り替え
  document.getElementById('dark-mode-toggle').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const btn = document.getElementById('dark-mode-toggle');
    btn.textContent = document.body.classList.contains('dark-mode') ? '☀️' : '🌙';
    scheduleSave();
  });

  // 時間制限の折りたたみ
  document.querySelectorAll('.schedule-header').forEach(header => {
    header.addEventListener('click', () => {
      const platform = header.dataset.platform;
      const content = document.querySelector(`.schedule-content[data-platform="${platform}"]`);
      header.classList.toggle('collapsed');
      content.classList.toggle('collapsed');
    });
  });

  // 制限時間追加ボタン
  document.querySelectorAll('.add-time-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const platform = e.target.dataset.platform;
      addTimeSlot(platform, { start: '21:00', end: '24:00' }, true);
      scheduleSave();
    });
  });

  // チェックボックス類
  // 時刻入力のリスナーは addTimeSlot 側で張るのでここでは対象にしない
  document.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', scheduleSave);
  });

  // 今すぐ適用ボタン
  document.getElementById('snooze-apply-btn').addEventListener('click', async () => {
    const btn = document.getElementById('snooze-apply-btn');
    btn.disabled = true;
    btn.textContent = '開始しています...';
    try {
      await requestImmediateApply();
    } catch (e) {
      showStatus(`エラー: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '今すぐ適用';
    }
  });

  // スヌーズ状態を保存するボタン
  document.getElementById('snooze-capture-btn').addEventListener('click', async () => {
    const btn = document.getElementById('snooze-capture-btn');
    btn.disabled = true;
    btn.textContent = '読み取り中...';

    try {
      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      const activeXTab = tabs.find(t => t.url.includes('/home')) || tabs[0];

      if (!activeXTab) {
        showStatus('X のタブが見つかりません。Xのホームを開いてから再試行してください。', 'error');
        return;
      }

      const response = await chrome.tabs.sendMessage(activeXTab.id, { action: 'captureSnooze' });

      if (response?.success) {
        await loadSnoozeStatus();
        const count = response.topics.filter(t => t.snoozed).length;
        showStatus(`スヌーズ状態を保存しました（${count}件のトピックをスヌーズ中）`, 'success');
      } else {
        showStatus(`保存に失敗: ${response?.error || '不明なエラー'}`, 'error');
      }
    } catch (e) {
      showStatus(`エラー: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '現在のスヌーズ状態を保存';
    }
  });
});
