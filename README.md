# Karaoke Memo — 歌いたい曲リスト & DAM★とも 精密採点履歴

単一HTML（localStorage保存）のカラオケメモアプリです。DAM★との精密採点履歴（DX-G / Ai / AiHeart）を
アカウント登録＋ボタン一発で取り込めます。

---

## 1. GitHub Pages で開く（URL発行）

このリポジトリは `index.html` がルートにあるので、GitHub Pages でそのまま公開できます。

1. GitHub の `karaoke-memo` リポジトリ → **Settings** → 左メニュー **Pages**
2. **Build and deployment** の **Source** を **Deploy from a branch** に
3. **Branch** を `main` / `/ (root)` にして **Save**
4. 1〜2分後、上部に公開URLが出ます：

   **https://wimp9216.github.io/karaoke-memo/**

このURLをスマホのホーム画面に追加すればアプリのように使えます。

---

## 2. 精密採点履歴の自動取得（proxyが必要）

clubdam.com はブラウザから直接アクセスできない（CORS制限）ため、取得には中継役の
**proxy** が必要です。方法は2通り。**A（Cloudflare Worker）を推奨**します。

### A. Cloudflare Worker（推奨・GitHub Pages上でボタン取得できる／無料）

1. https://dash.cloudflare.com にログイン（無料アカウントでOK）
2. **Workers & Pages** → **Create** → **Create Worker** → 適当な名前で **Deploy**
3. **Edit code** を開き、本リポジトリの [`proxy-worker.js`](proxy-worker.js) の中身を全部貼り付け → **Deploy**
4. 発行URL（例 `https://karaoke-proxy.xxxx.workers.dev`）をコピー
5. カラオケメモ（GitHub PagesのURL）を開く → **「設定」タブ** → 「DAM★とも連携」の
   **「⚙ アカウントと取得サーバーの設定」** を開き、URLを貼って **保存**
6. 「歌唱履歴」タブの **「⟳ 精密採点履歴を取得」** を押すだけ

> proxyはあなた専用。取得は自分の公開プロフィールに対してのみ行われます。

### B. ローカルのNodeサーバー（PCでだけ使う場合）

proxyを立てずに、自分のPCで動かす方法です。

```bash
cd karaoke-memo
node server.js
```

表示された **http://localhost:5174** をブラウザで開くと、同一オリジンのAPI経由で
そのまま「⟳ 自動取得」ボタンが使えます（proxy設定は不要）。

---

## 3. 使い方

1. 「設定」タブの「DAM★とも連携」を開く
2. **DAM★とも ID**（プロフィールURL `…Profile.do?damtomoId=●●●` の `●●●`、
   URLごと貼っても会員番号の数字でもOK）を入力して登録
3. 「歌唱履歴」タブの **「⟳ 精密採点履歴を取得」** を押す → DX-G / Ai / AiHeart を全ページ取得
4. 次回以降は連携された状態が続くので、取得ボタンを押すだけ

取り込みはこのボタン1つで完結します（CSV貼り付け・ブックマークレットによる
手動コピペは不要になったため廃止しました）。

### 取得がうまくいかないときは

proxyのURLに `&debug=1` を付けて開くと、どこで止まっているか確認できます。

```
https://<あなたのWorker>.workers.dev/?damtomoId=●●●&debug=1
```

`cdmCardNo` が取得できていれば取り込みは動きます。`cdmToken` は他人からは
常に空になる値なので、`found.cdmToken` が `false` でも問題ありません。

### 注意
- 取得には DAM★とものプロフィールが **公開設定** である必要があります。
- アカウントと取得サーバーの設定は「設定」タブにまとめてあります（普段は触りません）。

---

## 4. 見た目（通常／ダークモード）

「設定」タブの **見た目** で切り替えられます。選んだテーマはその端末に保存されます。

---

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（単一HTML / localStorage） |
| `proxy-worker.js` | Cloudflare Worker 用の取得proxy（方法A） |
| `server.js` | ローカル用サーバー（方法B・依存ゼロ） |
