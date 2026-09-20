// ブロックページの「戻る」ボタン。
// 拡張ページでは javascript: URL もインラインハンドラも使えないため、
// ここでイベントを登録する。

document.getElementById('back-button').addEventListener('click', () => {
  // 履歴がTikTok以外に戻れるなら戻る。
  // 直接TikTokを開いた（履歴が無い）場合は閉じるか新規タブへ。
  if (history.length > 1) {
    history.back();
  } else {
    location.replace('about:blank');
  }
});
