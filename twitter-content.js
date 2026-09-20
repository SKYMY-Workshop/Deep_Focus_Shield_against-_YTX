// Twitter/X Content Script

let settings = null;
let observer = null;
let debounceTimer = null;
// スヌーズ操作中フラグ（applyRestrictions より前に宣言しておく）
let snoozeOperationInProgress = false;

// どのビルドが動いているかをコンソールで確認できるようにする。
// 拡張をリロードしても、既に開いているタブでは古い content script が
// 動き続けるため、実際に何が走っているかの特定にこれが要る。
const DFS_BUILD = '2026-09-20e';

// 拡張が自分でタブを切り替えたときだけ記録する。
// ユーザー操作と拡張の介入を区別するための診断。
function logTabIntervention(source, toLabel) {
  console.log(`[Deep Focus Shield ${DFS_BUILD}] タブを切り替えました → ${toLabel}（${source}）`);
}

// タイムラインのタブ名。ロケール差を吸収するため配列で持つ。
const FORYOU_TAB_LABELS = ['おすすめ', 'For you'];
const FOLLOWING_TAB_LABELS = ['フォロー中', 'Following'];

// このスクリプトが inline style を書き換えた要素と、その元の値。
// 制限時間が終わったときに確実に戻せるようにするための台帳。
const hiddenElements = new Map();

function setInlineStyles(el, styles) {
  if (!el) return;
  const saved = hiddenElements.get(el) || {};
  for (const prop of Object.keys(styles)) {
    // 同じ要素に二度書き換えても、最初の値だけを保持する
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

// タブは display:none にすると幅計算が崩れるので視覚的に畳むだけにする
function collapseElement(el) {
  setInlineStyles(el, { visibility: 'hidden', width: '0', padding: '0', overflow: 'hidden' });
}

// 書き換えた inline style をすべて元に戻す。
// 以前は解除時にbodyクラスを外すだけで inline style が残り、
// 制限時間を過ぎてもリロードするまでトレンドが消えたままになっていた。
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
    checkAndReapplySnooze(); // 3h経過チェック（非同期・バックグラウンド）
  } catch (error) {
    console.error('Deep Focus Shield (X): 設定の読み込みに失敗:', error);
  }
}

// 制限を適用すべきかどうかを判定（判定ロジックは settings-defaults.js に集約）
function shouldApplyRestrictions() {
  return dfsShouldApplyRestrictions(settings, 'twitter');
}

// 制限を適用
function applyRestrictions() {
  // スヌーズ操作中は一切DOMに触らない。
  // ここを通すと setInterval(60秒) が「フォロー中」へタブを引き戻し、
  // 開いているスヌーズダイアログを閉じてしまう。
  if (snoozeOperationInProgress) return;

  const isRestricted = shouldApplyRestrictions();

  if (!isRestricted) {
    // 制限時間外の場合はすべての制限を解除
    document.body.classList.remove('acis-twitter-active');
    document.body.classList.remove('acis-twitter-recommendations-hidden');
    document.body.classList.remove('acis-twitter-trends-hidden');
    document.body.classList.remove('acis-grayscale');
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

  // 制限時間内の場合、各機能のトグル状態に応じて制限を適用
  document.body.classList.add('acis-twitter-active');

  // グレースケールモード（共通設定かつ制限時間内のみ）
  if (settings.common?.grayscale) {
    document.body.classList.add('acis-grayscale');
  } else {
    document.body.classList.remove('acis-grayscale');
  }
  
  // 既定タイムラインへ切り替え（制限時間内のみ）。
  // リスト指定とフォロー中指定のどちらを使うかは関数側で判断する。
  switchToDefaultTab();
  
  // おすすめを非表示（制限時間内のみ）
  if (settings.twitter.hideRecommendations) {
    document.body.classList.add('acis-twitter-recommendations-hidden');
    hideRecommendations();
  } else {
    document.body.classList.remove('acis-twitter-recommendations-hidden');
  }
  
  // トレンドを非表示（制限時間内のみ）
  if (settings.twitter.hideTrends) {
    document.body.classList.add('acis-twitter-trends-hidden');
    hideTrends();
  } else {
    document.body.classList.remove('acis-twitter-trends-hidden');
  }
  
  // DOMの変更を監視
  if (!observer) {
    startObserver();
  }
}

// タブ名で探す。完全一致を優先し、見つからなければ大文字小文字を無視して再試行する。
// 選択中のタブは末尾に矢印SVG分の空白が付くので trim() は必須。
function findTabByName(tabs, name) {
  const target = (name || '').trim();
  if (!target) return null;

  const exact = tabs.find(t => t.textContent.trim() === target);
  if (exact) return exact;

  const lower = target.toLowerCase();
  return tabs.find(t => t.textContent.trim().toLowerCase() === lower) || null;
}

// 既定タイムラインとして選びたいタブを返す。
// リスト指定が有効でそのタブが見つかればリストを、
// 無ければ（設定されていれば）フォロー中を返す。
function resolvePreferredTab(tabs) {
  const twitter = settings?.twitter || {};

  if (twitter.defaultListEnabled) {
    const listTab = findTabByName(tabs, twitter.defaultListName);
    if (listTab) return { tab: listTab, kind: 'list' };
  }

  if (twitter.defaultFollowing !== false) {
    const followingTab = tabs.find(t => FOLLOWING_TAB_LABELS.includes(t.textContent.trim()));
    if (followingTab) return { tab: followingTab, kind: 'following' };
  }

  return { tab: null, kind: null };
}

// 既定タイムラインへ切り替える（セッション内で初回のみ）
//
// セッションガードが要。これが無いと handleDomChanges() が200msごとに走って、
// ユーザーが選んだリストタブを毎回引き戻してしまう。
//
// フォロー中を既定にする場合は「おすすめ」にいるときだけ逃がす。
// 一方リストを既定にする場合は、フォロー中にいても目的のリストへ移す必要がある。
let defaultTabFirstAttemptAt = 0;
let warnedMissingList = false;

function switchToDefaultTab() {
  if (location.pathname !== '/home') return;

  const sessionKey = 'dfs-twitter-tab-switched';
  if (sessionStorage.getItem(sessionKey)) return;

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return; // タブバーがまだ描画されていない。次のDOM変化で再評価する。

  if (!defaultTabFirstAttemptAt) defaultTabFirstAttemptAt = Date.now();
  const givenUpWaiting = Date.now() - defaultTabFirstAttemptAt > 10000;

  const twitter = settings?.twitter || {};
  const wantsList = !!(twitter.defaultListEnabled && (twitter.defaultListName || '').trim());
  const listTab = wantsList ? findTabByName(tabs, twitter.defaultListName) : null;

  // リストタブは他のタブより遅れて描画されることがあるので少し待つ。
  // ただし名前が間違っている場合に永久に待たないよう上限を設ける。
  if (wantsList && !listTab && !givenUpWaiting) return;

  if (wantsList && !listTab && !warnedMissingList) {
    warnedMissingList = true;
    console.warn(
      `[Deep Focus Shield ${DFS_BUILD}] リストタブ「${twitter.defaultListName}」が見つかりません。` +
      `タブ名: ${tabs.map(t => t.textContent.trim()).join(' / ')}`
    );
  }

  const { tab: target, kind } = resolvePreferredTab(tabs);
  if (!target) {
    sessionStorage.setItem(sessionKey, 'true');
    return;
  }

  if (kind === 'list') {
    // 明示指定なので、どのタブにいても目的のリストへ移す
    if (target.getAttribute('aria-selected') !== 'true') {
      logTabIntervention('switchToDefaultTab(list)', target.textContent.trim());
      target.click();
    }
  } else {
    // フォロー中指定のときは「おすすめ」から逃がすだけに留める。
    // ユーザーが自分で選んだリストタブには干渉しない。
    const forYouTab = tabs.find(t => FORYOU_TAB_LABELS.includes(t.textContent.trim()));
    if (forYouTab?.getAttribute('aria-selected') === 'true') {
      logTabIntervention('switchToDefaultTab(following)', target.textContent.trim());
      target.click();
    }
  }

  // 切り替えの要否に関わらず、このセッションでの判定は済んだものとする。
  sessionStorage.setItem(sessionKey, 'true');
}

// サイドバーで非表示にしたいモジュールの見出し・aria-labelキーワード。
// 「話題」は左メニューの「話題を検索」と被るので入れないこと。
const SIDEBAR_HIDE_KEYWORDS = [
  'Trending', 'トレンド',
  'What', 'いま',
  'News', 'ニュース', '速報',
  'Follow', 'おすすめ'
];

// サイドバー上部の検索ボックス。これを含む要素はモジュールではなく
// サイドバー全体のラッパーなので、絶対に非表示にしてはいけない。
const SIDEBAR_SEARCH_SELECTOR = '[data-testid="SearchBox_Search_Input"], form[role="search"]';

function matchesSidebarKeyword(text) {
  return !!text && SIDEBAR_HIDE_KEYWORDS.some(keyword => text.includes(keyword));
}

// 見出しやトレンド項目から、そのモジュールの外枠まで遡る。
//
// Xのサイドバーはモジュールごとの data-testid を持たず、
// div[aria-label="トレンド"] のような紛らわしいラッパーが
// 検索ボックスまで含んだ状態で存在する。
// 実測した結果、各モジュールは「検索ボックスを含む親」の直下で切れているので、
// そこを境界にして登る。
function findModuleContainer(start, sidebar) {
  let node = start;

  while (node.parentElement && node.parentElement !== sidebar && sidebar.contains(node.parentElement)) {
    const parent = node.parentElement;

    // サイドバー全体のラッパーに到達した
    if (parent.querySelector(SIDEBAR_SEARCH_SELECTOR)) break;

    // 対象外の見出しまで巻き込む位置に来た
    const swallowsOtherModule = [...parent.querySelectorAll('h1, h2')]
      .some(heading => !matchesSidebarKeyword(heading.textContent));
    if (swallowsOtherModule) break;

    node = parent;
  }

  return node;
}

// 収集した候補から、実際に隠してよいものだけを残す
function pickSafeTargets(targets, sidebar) {
  const list = [...targets];
  return list.filter(el =>
    el &&
    el !== sidebar &&
    !el.querySelector(SIDEBAR_SEARCH_SELECTOR) &&
    // 入れ子になっている場合は外側だけを残す
    !list.some(other => other !== el && other.contains(el))
  );
}

// おすすめを非表示
function hideRecommendations() {
  // "For you" タブを畳んで "Following" タブに切り替える
  const tabs = document.querySelectorAll('[role="tab"]');
  let followingTab = null;
  let forYouTab = null;

  tabs.forEach(tab => {
    const text = tab.textContent.trim();
    if (FORYOU_TAB_LABELS.includes(text)) {
      forYouTab = tab;
      collapseElement(tab);
    } else if (FOLLOWING_TAB_LABELS.includes(text)) {
      followingTab = tab;
    }
  });

  // 「おすすめ」が選択中のときだけ逃がす。
  // おすすめタブを畳む以上、そこに留まらせるわけにはいかないため。
  // 逃がし先は既定タイムラインの設定に従う（リスト指定があればそのリスト）。
  //
  // 以前は「フォロー中が選択されていなければクリック」という条件で、
  // セッションガードも無かった。そのため handleDomChanges() から
  // 200msごとに呼ばれるたびに、リストタブを選んでいても引き戻していた。
  if (forYouTab && forYouTab.getAttribute('aria-selected') === 'true') {
    const escapeTo = resolvePreferredTab([...tabs]).tab || followingTab;
    if (escapeTo) {
      logTabIntervention('hideRecommendations', escapeTo.textContent.trim());
      escapeTo.click();
    }
  }

  // "Who to follow" / "Topics to follow" モジュール
  const sidebarColumn = document.querySelector('[data-testid="sidebarColumn"]');
  const scope = sidebarColumn || document.body;
  const targets = new Set();

  scope.querySelectorAll(
    '[aria-label*="Who to follow"], [aria-label*="おすすめユーザー"], ' +
    '[aria-label*="Topics"], [aria-label*="トピック"]'
  ).forEach(section => {
    targets.add(findModuleContainer(section, scope));
  });

  pickSafeTargets(targets, scope).forEach(hideElement);

  // プロモ（広告）も「おすすめ非表示」の一部として扱う
  hidePromotedContent();
}

// =============== プロモ（広告）判定 ===============
//
// 以前は twitter-style.css で svg path[d*="M19.498"] を見ていたが、
// 実機で確認したところ現在のプロモツイートにそのパスは含まれておらず、
// このルールは既に機能していなかった。
//
// 実機で判明した手がかり:
//   - X公式のラッパー div[data-testid="placementTracking"]
//     ただしこれは空の広告スロットにも付くので単独では判定に使えない
//   - ラベルは本文の外にある葉ノードで「広告」「Promoted by ○○」など
//   - 消す単位はタイムラインなら [data-testid="cellInnerDiv"]

const PROMO_LABEL_PATTERNS = [
  /^広告$/,
  /^Promoted$/,
  /^プロモーション$/,
  /^Promoted by .+/,
  /.+によるプロモーション$/
];

// 本文(tweetText)の外にプロモラベルがあるかを調べる。
// 本文を除外しないと、「広告」という語を含むだけの通常ツイートを誤検知する。
function hasPromoLabel(root) {
  if (!root) return false;

  for (const el of root.querySelectorAll('span, div')) {
    if (el.children.length) continue;

    const text = (el.textContent || '').trim();
    if (!text || text.length > 40) continue;
    if (el.closest('[data-testid="tweetText"]')) continue;

    if (PROMO_LABEL_PATTERNS.some(pattern => pattern.test(text))) return true;
  }
  return false;
}

// タイムラインで消すべき単位を返す
function promoRowFor(el) {
  return el.closest('[data-testid="cellInnerDiv"]') || el;
}

function hidePromotedContent() {
  // 1) 公式ラッパー配下で、実際にラベルが出ているもの
  document.querySelectorAll('[data-testid="placementTracking"]').forEach(wrapper => {
    if (hasPromoLabel(wrapper)) hideElement(promoRowFor(wrapper));
  });

  // 2) ラッパーが付かない場合の保険
  document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
    if (article.closest('[data-testid="placementTracking"]')) return;
    if (hasPromoLabel(article)) hideElement(promoRowFor(article));
  });

  // 3) サイドバーのプロモトレンド（「Promoted by ○○」）
  document.querySelectorAll('[data-testid="trend"]').forEach(trend => {
    if (hasPromoLabel(trend)) hideElement(trend);
  });
}

// トレンドを非表示（右側のサイドバーのみ）
//
// 以前は closest('section, aside, div') で最寄りのdivを掴んでいたため、
// div[aria-label="トレンド"]（＝検索ボックスまで含むサイドバー全体のラッパー）に
// 当たると検索窓ごと消える状態だった。
function hideTrends() {
  const sidebarColumn = document.querySelector('[data-testid="sidebarColumn"]');
  if (!sidebarColumn) return;

  const targets = new Set();

  // 見出しで判定
  sidebarColumn.querySelectorAll('h1, h2').forEach(heading => {
    if (matchesSidebarKeyword(heading.textContent)) {
      targets.add(findModuleContainer(heading, sidebarColumn));
    }
  });

  // aria-labelで判定（見出しを持たないモジュール向け）
  sidebarColumn.querySelectorAll('[aria-label]').forEach(el => {
    if (matchesSidebarKeyword(el.getAttribute('aria-label')) &&
        !el.querySelector(SIDEBAR_SEARCH_SELECTOR)) {
      targets.add(findModuleContainer(el, sidebarColumn));
    }
  });

  // トレンド項目そのものからも辿る（見出し・ラベルが取れない場合の保険）
  sidebarColumn.querySelectorAll('[data-testid="trend"]').forEach(trend => {
    targets.add(findModuleContainer(trend, sidebarColumn));
  });

  pickSafeTargets(targets, sidebarColumn).forEach(hideElement);
}

// デバウンス付きでDOM変更に対応する処理
function handleDomChanges() {
  if (snoozeOperationInProgress) return; // スヌーズ操作中はDOM操作を停止
  switchToDefaultTab();
  if (settings.twitter.hideRecommendations) {
    hideRecommendations();
  }
  if (settings.twitter.hideTrends) {
    hideTrends();
  }
}

// DOMの変更を監視（デバウンス付き、SPAナビゲーション検出も統合）
function startObserver() {
  let lastUrl = location.href;

  observer = new MutationObserver(() => {
    // スヌーズ操作中は自分のDOM操作で再発火し続けるため止める。
    // （ここにあった isProcessing はYouTube版からのコピー残骸で、
    //   どこからも代入されない常にfalseの変数だった）
    if (snoozeOperationInProgress) return;

    // SPAナビゲーション検出
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      // ナビゲーション時は少し待ってから適用
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (settings) applyRestrictions();
      }, 500);
      return;
    }

    // デバウンス: 連続するDOM変更をまとめて1回だけ処理
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleDomChanges, 200);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// =============== スヌーズ機能 ===============
//
// Xの「スヌーズするトピック」の導線（2026-09 時点で実機確認済み）:
//   選択状態の「おすすめ」タブをもう一度クリック
//     → #layers > div[role="dialog"] > div[role="group"] > div[data-testid="sheetDialog"]
//   中間の role="menuitem" は存在しない。トレンドの caret メニューとは無関係。
//   タブ内の下矢印は data-testid も aria-label も持たず、svg path の d 値のみが手がかり。
//   矢印は「おすすめ」が選択中のときだけDOMに現れるため、先に選択し直す必要がある。

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// スヌーズ操作中、画面のちらつきを抑える。
// ダイアログ(#layers)とタイムライン(primaryColumn)を一時的に不可視にする。
// display:none にすると X 側がレイアウトを再計算してしまうため、
// opacity / visibility で「描画だけ止める」形にしている。
const CLOAK_STYLE_ID = 'dfs-snooze-cloak';

function applyCloak() {
  if (document.getElementById(CLOAK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CLOAK_STYLE_ID;
  style.textContent =
    '#layers { opacity: 0 !important; pointer-events: none !important; }' +
    '[data-testid="primaryColumn"] { visibility: hidden !important; }';
  document.head.appendChild(style);
}

function removeCloak() {
  document.getElementById(CLOAK_STYLE_ID)?.remove();
}

// タイムラインのタブバーが描画されるまで待つ。
// 以前は固定で4秒待っていたが、実測では数百msで整うので待ちすぎだった。
async function waitForTimelineReady(timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (findTabByLabels(FORYOU_TAB_LABELS)) return true;
    await sleep(100);
  }
  return false;
}

// 「おすすめ」タブ内の下矢印（chevron-down）のSVGパス。
// この要素は data-testid も aria-label も持たないため d 値で識別するしかない。
// Xがアイコンを差し替えたらここが最初に壊れるので、フォールバックも用意しておく。
const FORYOU_CHEVRON_PATH = 'M3.543 8.96l1.414-1.42L12 14.59l7.043-7.05 1.414 1.42L12 17.41 3.543 8.96z';

function findTabByLabels(labels) {
  return [...document.querySelectorAll('[role="tab"]')]
    .find(t => labels.includes(t.textContent.trim())) || null;
}

// 「おすすめ」タブが展開可能な状態（＝選択中で下矢印が出ている）かどうか
function forYouTabHasChevron(tab) {
  if (!tab) return false;
  if (tab.querySelector(`svg path[d="${FORYOU_CHEVRON_PATH}"]`)) return true;
  // フォールバック: 選択中タブに含まれる唯一のsvgを矢印とみなす
  return tab.getAttribute('aria-selected') === 'true' && tab.querySelectorAll('svg').length === 1;
}

// hideRecommendations() が「おすすめ」タブに付けたinlineスタイルを一時解除する
function temporarilyShowForYouTab(tab) {
  if (!tab) return null;
  const saved = {
    visibility: tab.style.visibility,
    width: tab.style.width,
    padding: tab.style.padding,
    overflow: tab.style.overflow
  };
  tab.style.visibility = '';
  tab.style.width = '';
  tab.style.padding = '';
  tab.style.overflow = '';
  return { tab, saved };
}

function restoreForYouTab(entry) {
  if (!entry) return;
  const { tab, saved } = entry;
  tab.style.visibility = saved.visibility;
  tab.style.width = saved.width;
  tab.style.padding = saved.padding;
  tab.style.overflow = saved.overflow;
}

// スヌーズダイアログが開くまで待つ。
// [role="dialog"] だけだと他のダイアログを誤検出しうるので sheetDialog とスイッチの両方で確認する。
async function waitForSnoozeDialog(timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg &&
        dlg.querySelector('[data-testid="sheetDialog"]') &&
        dlg.querySelector('input[type="checkbox"][role="switch"]')) {
      return dlg;
    }
    await sleep(40);
  }
  return null;
}

// スヌーズダイアログを開く（「おすすめ」タブ経由）
// 戻り値の restoreState は必ず closeSnoozeDialog に渡すこと
async function openSnoozeDialog() {
  snoozeOperationInProgress = true;
  applyCloak();

  if (location.pathname !== '/home') {
    removeCloak();
    snoozeOperationInProgress = false;
    return { success: false, error: 'ホーム(/home)でのみ実行できます。Xのホームを開いてから再試行してください。' };
  }

  const previouslySelected = [...document.querySelectorAll('[role="tab"]')]
    .find(t => t.getAttribute('aria-selected') === 'true') || null;
  let shown = null;

  try {
    const forYouTab = findTabByLabels(FORYOU_TAB_LABELS);
    if (!forYouTab) {
      removeCloak();
      snoozeOperationInProgress = false;
      return { success: false, error: '「おすすめ」タブが見つかりません。ページの読み込みを待ってから再試行してください。' };
    }

    // 拡張自身がタブを隠しているので一時的に戻す
    shown = temporarilyShowForYouTab(forYouTab);

    // 下矢印は「おすすめ」が選択中のときしか存在しない。未選択なら選択し直す。
    if (!forYouTabHasChevron(forYouTab)) {
      forYouTab.click();
      const start = Date.now();
      while (Date.now() - start < 4000 && !forYouTabHasChevron(findTabByLabels(FORYOU_TAB_LABELS))) {
        await sleep(40);
      }
    }

    const readyTab = findTabByLabels(FORYOU_TAB_LABELS);
    if (!forYouTabHasChevron(readyTab)) {
      restoreForYouTab(shown);
      removeCloak();
      snoozeOperationInProgress = false;
      return { success: false, error: '「おすすめ」タブを選択状態にできませんでした。' };
    }

    // 選択中のタブをもう一度クリックするとスヌーズダイアログが開く
    readyTab.click();

    const dialog = await waitForSnoozeDialog();
    if (!dialog) {
      restoreForYouTab(shown);
      removeCloak();
      snoozeOperationInProgress = false;
      return { success: false, error: 'スヌーズダイアログが開きませんでした。Xの仕様変更の可能性があります。' };
    }

    return { success: true, dialog, restoreState: { shown, previouslySelected } };
  } catch (e) {
    restoreForYouTab(shown);
    removeCloak();
    snoozeOperationInProgress = false;
    return { success: false, error: e.message };
  }
}

// ダイアログ下部の確定ボタン。
//
// これを押さないとトグルの変更はX側に保存されない。
// ×（閉じる）で閉じると破棄されるため、以前は毎回変更を捨てていた。
//
// ラベルは選択数によって変わる（実機で確認済み）:
//   0件       → 「リセット」
//   N件(N>0)  → 「スヌーズ N トピック」
function findCommitButton(dialog) {
  const sheet = dialog.querySelector('[data-testid="sheetDialog"]') || dialog;
  const buttons = [...sheet.querySelectorAll('button, [role="button"]')].filter(b => {
    const label = b.getAttribute('aria-label');
    return label !== '閉じる' && label !== 'Close';
  });

  // ラベルで特定できるならそれを優先する
  const byLabel = buttons.find(b =>
    /^(スヌーズ|Snooze|リセット|Reset)/.test((b.innerText || '').trim())
  );
  return byLabel || buttons[buttons.length - 1] || null;
}

// 変更を確定する。押した後ダイアログが自動で閉じる場合と残る場合の両方を許容する。
async function commitSnoozeDialog(dialog) {
  const button = findCommitButton(dialog);
  if (!button) {
    return { committed: false, error: '確定ボタンが見つかりませんでした。' };
  }

  const label = (button.innerText || '').trim();
  button.click();

  // 確定するとX側がダイアログを自動で閉じる（実機確認済み）。閉じるのを待つ。
  const start = Date.now();
  while (Date.now() - start < 2500) {
    if (!document.querySelector('[role="dialog"] [data-testid="sheetDialog"]')) break;
    await sleep(40);
  }

  const stillOpen = !!document.querySelector('[role="dialog"] [data-testid="sheetDialog"]');
  return { committed: true, label, stillOpen };
}

async function closeSnoozeDialog(dialog, restoreState) {
  // 確定ボタンを押すとX側がダイアログを閉じることがあるので、
  // まだ開いている場合だけ閉じる操作を行う。
  const stillOpen = !!document.querySelector('[role="dialog"] [data-testid="sheetDialog"]');

  if (stillOpen) {
    const closeBtn = dialog?.querySelector('[aria-label="閉じる"], [aria-label="Close"]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      // Escapeは document 発火でも閉じないことを実機で確認済み。
      // 念のためマスクのクリックも試す。
      document.querySelector('[data-testid="mask"]')?.click();
    }
    // 閉じ切るのを待つ
    const start = Date.now();
    while (Date.now() - start < 1500) {
      if (!document.querySelector('[role="dialog"] [data-testid="sheetDialog"]')) break;
      await sleep(40);
    }
  }

  // 元のタブに戻す（拡張は通常「フォロー中」を選ばせているため）
  const { shown, previouslySelected } = restoreState || {};
  const target = previouslySelected && document.contains(previouslySelected)
    ? previouslySelected
    : findTabByLabels(FOLLOWING_TAB_LABELS);
  if (target && target.getAttribute('aria-selected') !== 'true') {
    target.click();
    await sleep(150);
  }
  restoreForYouTab(shown);
  removeCloak();
}

// ダイアログからトピック一覧と状態を読み取る
// 構造: [row] > [icon+text div, toggle div] > [svg, span(name)] / [div, div, input[role=switch]]
function readTopicsFromDialog(dialog) {
  const topics = [];

  dialog.querySelectorAll('input[type="checkbox"][role="switch"]').forEach((ctrl, i) => {
    // 状態: .checked プロパティで判定（aria-checked 属性は設定されていない）
    const snoozed = ctrl.checked;

    // 名前: input.parentElement（toggleコンテナ）.previousElementSibling（icon+textコンテナ）内のspanを取得
    const toggleContainer = ctrl.parentElement;
    const iconTextContainer = toggleContainer?.previousElementSibling;
    let name = null;

    if (iconTextContainer) {
      // SVG内のspanを除き、テキストを持つ最初のspanをトピック名とする
      const spans = iconTextContainer.querySelectorAll('span');
      for (const span of spans) {
        if (span.children.length === 0) {
          const text = span.textContent.trim();
          if (text.length > 0) { name = text; break; }
        }
      }
    }

    topics.push({ index: i, name: name || `トピック${i + 1}`, snoozed });
  });

  return topics;
}

// 保存済みトピックを現在のダイアログのコントロールに対応づける。
// indexだけだとXの並び順・件数が変わった瞬間に別トピックを操作してしまうため、
// 名前での一致を優先し、見つからない場合のみindexにフォールバックする。
function matchControl(saved, dialog, controls) {
  const current = readTopicsFromDialog(dialog);
  const byName = current.find(t => t.name === saved.name);
  if (byName) return controls[byName.index] || null;
  return controls[saved.index] || null;
}

// 現在のスヌーズ状態を保存する（ポップアップの「保存」ボタンから呼ばれる）
async function captureCurrentSnoozeState() {
  const result = await openSnoozeDialog();
  if (!result.success) return result;

  try {
    const topics = readTopicsFromDialog(result.dialog);
    await closeSnoozeDialog(result.dialog, result.restoreState);

    await chrome.storage.local.set({
      snoozedTopics: { topics, lastApplied: Date.now() }
    });

    return { success: true, topics };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    // ここで必ず解除しないと handleDomChanges が止まったままになり、
    // トレンド非表示まで効かなくなる
    snoozeOperationInProgress = false;
  }
}


// 手動適用の結果を保存する。
// ポップアップは処理の完了を待てない（フォーカスを失うと閉じてJSごと破棄される）ので、
// 結果はここに書いておき、次にポップアップが開いたときに読ませる。
async function recordSnoozeResult(result) {
  try {
    await chrome.storage.local.set({
      lastSnoozeResult: { ...result, at: Date.now() }
    });
  } catch (e) {
    console.error('Deep Focus Shield: スヌーズ結果の保存に失敗:', e);
  }
}

// ページ読み込みごとに実行される入口。
// 手動（ポップアップの即時適用ボタン）と自動（3時間スロットル）の両方をここで捌く。
//
// pendingSnoozeApply が { silent: true } の場合、このタブは
// background が非アクティブで開いた作業用タブなので、
// 終わったら background に頼んで自分を閉じてもらう。
async function checkAndReapplySnooze() {
  const { snoozedTopics, pendingSnoozeApply } =
    await chrome.storage.local.get(['snoozedTopics', 'pendingSnoozeApply']);

  const manual = !!pendingSnoozeApply;
  const silent = !!(pendingSnoozeApply && pendingSnoozeApply.silent);

  // 予約フラグは読んだ時点で消す。
  // 残したままだと、以降のページ読み込みでも繰り返し発火してしまう。
  if (manual) {
    await chrome.storage.local.remove('pendingSnoozeApply');
  }

  // 作業用タブを閉じてもらう。confirmed が true のときは、
  // background が他のXタブをリロードして反映させる。
  const finish = async (committed = false) => {
    if (silent) {
      try {
        await chrome.runtime.sendMessage({
          action: 'snoozeApplyFinished',
          committed: !!committed
        });
      } catch (e) { /* background が寝ている等は無視 */ }
    }
  };

  if (!snoozedTopics?.topics?.length) {
    if (manual) {
      await recordSnoozeResult({ ok: false, error: '保存されたスヌーズ設定がありません。先に「現在のスヌーズ状態を保存」を実行してください。' });
    }
    await finish();
    return;
  }

  if (!manual) {
    // 自動再適用がOFFなら何もしない
    if (settings?.twitter?.autoReapplySnooze === false) return;

    // 最後のチェックから3時間未満なら何もしない
    const hoursSinceCheck = (Date.now() - (snoozedTopics.lastChecked || 0)) / 3600000;
    if (hoursSinceCheck < 3) return;
  }

  // DOMContentLoaded直後は x.com/ のままで、SPAが /home に書き換えるのを待つ必要がある。
  // 即座に pathname を見て return すると、そのセッションでは二度と走らなくなる。
  const start = Date.now();
  while (Date.now() - start < 10000 && location.pathname !== '/home') {
    await sleep(100);
  }
  if (location.pathname !== '/home') {
    if (manual) await recordSnoozeResult({ ok: false, error: 'ホーム(/home)を開けませんでした。' });
    await finish();
    return;
  }

  // タブバーが出るまで待つ（以前の固定4秒待機を置き換え）
  const ready = await waitForTimelineReady();
  if (!ready) {
    if (manual) await recordSnoozeResult({ ok: false, error: 'タイムラインが読み込まれませんでした。' });
    await finish();
    return;
  }

  const result = await applySnoozeTopicsIfDifferent({ manual });
  await finish(result?.committed);
}

// ダイアログを開いて現在の状態と保存済みを比較し、差分があるトグルだけ変更する。
// 一致しているトグルを押すと逆にスヌーズが解除されるため、差分のみを操作するのが正しい。
async function applySnoozeTopicsIfDifferent({ manual = false } = {}) {
  const { snoozedTopics } = await chrome.storage.local.get(['snoozedTopics']);
  if (!snoozedTopics?.topics?.length) {
    return { success: false, error: '保存されたスヌーズ設定がありません。' };
  }

  const opened = await openSnoozeDialog();
  if (!opened.success) {
    console.warn('Deep Focus Shield: スヌーズ再適用をスキップしました -', opened.error);
    snoozeOperationInProgress = false;
    if (manual) await recordSnoozeResult({ ok: false, error: opened.error });
    return opened;
  }

  try {
    const dialog = opened.dialog;
    const controls = [...dialog.querySelectorAll('input[type="checkbox"][role="switch"]')];

    // 差分のあるトグルを集める
    const pending = [];
    for (const saved of snoozedTopics.topics) {
      const ctrl = matchControl(saved, dialog, controls);
      if (ctrl && ctrl.checked !== saved.snoozed) {
        pending.push({ ctrl, saved });
      }
    }

    // 全トグルを一気にクリックしてから、まとめて検証する。
    // 実測で9件のクリックが26ms、いずれも click() 直後に反映され
    // 300ms後も維持されることを確認済みなので、1件ごとの待機は不要。
    pending.forEach(({ ctrl }) => ctrl.click());
    await sleep(150);

    const changed = [];
    for (const { ctrl, saved } of pending) {
      if (ctrl.checked === saved.snoozed) {
        changed.push(saved.name);
      } else {
        console.warn('Deep Focus Shield: トグルが反映されませんでした -', saved.name);
      }
    }

    // 実際にトグルを動かしたときだけ確定する。差分ゼロで押してはいけない。
    //
    // 確定ボタンのラベルは件数ではなく「新規に追加するスヌーズがあるか」で変わる（実機確認）:
    //   追加あり   → 「スヌーズ N トピック」
    //   それ以外   → 「リセット」（変更なし・解除方向の両方でこれになる）
    //
    // 「リセット」が全解除を意味する可能性があり、部分解除（例: 政治とスポーツが
    // 確定済みで、政治だけ残したい）で押すと政治まで消えかねない。
    // 目標状態が1件以上残るのにラベルが「リセット」のときは押さずに見送る。
    let commit = null;
    if (changed.length) {
      const targetSnoozedCount = snoozedTopics.topics.filter(t => t.snoozed).length;
      const label = (findCommitButton(dialog)?.innerText || '').trim();
      const isResetLabel = /^(リセット|Reset)/.test(label);

      if (isResetLabel && targetSnoozedCount > 0) {
        commit = {
          committed: false,
          error: `確定ボタンが「${label}」表示のため見送りました（全解除になる恐れがあります）`
        };
        console.warn('Deep Focus Shield:', commit.error);
      } else {
        commit = await commitSnoozeDialog(dialog);
        if (!commit.committed) {
          console.warn('Deep Focus Shield: 確定できませんでした -', commit.error);
        }
      }
    }

    await closeSnoozeDialog(dialog, opened.restoreState);

    // 確定できたときだけ lastApplied を更新する。
    // 確定に失敗した場合は変更が破棄されているので、適用済み扱いにしてはいけない。
    const committed = !!commit?.committed;
    const now = Date.now();
    await chrome.storage.local.set({
      snoozedTopics: {
        ...snoozedTopics,
        lastChecked: now,
        ...(committed ? { lastApplied: now } : {})
      }
    });

    const result = {
      ok: true,
      total: snoozedTopics.topics.length,
      attempted: pending.length,
      changed,
      failed: pending.length - changed.length,
      committed,
      commitLabel: commit?.label || null,
      commitError: commit?.committed === false ? commit.error : null
    };
    if (manual) await recordSnoozeResult(result);
    return { success: true, ...result };

  } catch (e) {
    console.error('Deep Focus Shield: スヌーズ再適用に失敗:', e);
    if (manual) await recordSnoozeResult({ ok: false, error: e.message });
    return { success: false, error: e.message };
  } finally {
    snoozeOperationInProgress = false;
  }
}

// =============== リロード要求 ===============
//
// スヌーズを確定した後、開いているXタブをリロードして反映させる。
// ただし書きかけの投稿を消してしまわないよう、入力状態を先に確認する。
function reloadSafetyIssue() {
  // 投稿・返信・DMの入力欄。
  // [data-testid^="tweetTextarea"] は3要素ヒットするが、
  // 実際の入力欄は contenteditable のものだけで、
  // 残りはプレースホルダ「いまどうしてる？」を持つラベル要素。
  for (const el of document.querySelectorAll('[contenteditable="true"]')) {
    if ((el.textContent || '').trim()) return '入力中のテキストがあります';
  }

  for (const el of document.querySelectorAll('input[type="text"], textarea')) {
    if (el.closest('[role="search"]')) continue; // 検索欄は対象外
    if ((el.value || '').trim()) return '入力中のテキストがあります';
  }

  if (document.querySelector('[role="dialog"]')) return 'ダイアログが開いています';

  return null;
}

// =============== メッセージリスナー（設定更新時）===============
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateSettings') {
    settings = dfsMergeSettings(request.settings);
    applyRestrictions();
    return;
  }

  // スヌーズ確定後に background から送られてくる。
  // 先に応答してからリロードしないと、応答がbackgroundに届かない。
  if (request.action === 'reloadForSnooze') {
    const issue = reloadSafetyIssue();
    if (issue) {
      sendResponse({ reloaded: false, reason: issue });
    } else {
      sendResponse({ reloaded: true });
      setTimeout(() => location.reload(), 50);
    }
    return true;
  }

  // ポップアップのリスト名入力に候補を出すため、現在のタブ名を返す
  if (request.action === 'getTimelineTabs') {
    const names = [...document.querySelectorAll('[role="tab"]')]
      .map(t => t.textContent.trim())
      .filter(Boolean);
    sendResponse({ ok: true, names });
    return true;
  }

  if (request.action === 'captureSnooze') {
    captureCurrentSnoozeState()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true; // 非同期レスポンスのためチャネルを保持
  }

});

console.log(`[Deep Focus Shield ${DFS_BUILD}] X用スクリプトを読み込みました`);

// ページ読み込み完了後に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSettings);
} else {
  loadSettings();
}

// 定期的に制限状態をチェック（時間制限のため）
setInterval(() => {
  if (settings) {
    applyRestrictions();
  }
}, 60000); // 1分ごとにチェック

// SPAナビゲーション検出は startObserver() に統合済み
