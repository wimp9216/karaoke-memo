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
5. カラオケメモ（GitHub PagesのURL）を開く → 「歌唱履歴」タブ → アカウント登録後に出る
   **「🌐 取得サーバー(proxy)の設定」** にURLを貼って **保存**
6. **「⟳ 精密採点履歴を自動取得」** を押すだけ

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

1. 「歌唱履歴」タブを開く
2. **DAM★とも ID**（プロフィールURL `…Profile.do?damtomoId=●●●` の `●●●`、
   URLごと貼っても会員番号の数字でもOK）と、**パスワード**（この端末用の合言葉）を入力して登録
3. **「⟳ 精密採点履歴を自動取得」** を押す → DX-G / Ai / AiHeart を全ページ取得
4. 次回からは **パスワードを入力するだけ** でアカウント連携 → 取得

### パスワードについて
- 端末内にアカウント情報を **暗号化して保存**（AES-GCM + PBKDF2）するための合言葉です。
- **DAM★とものログインパスワードではありません。**
- 復元できないため、忘れた場合は「アカウントを削除」して登録し直してください
  （取り込み済みの履歴は残ります）。

### 注意
- 取得には DAM★とものプロフィールが **公開設定** である必要があります。
- 暗号化保存は HTTPS または http://localhost で動作します。

---

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（単一HTML / localStorage） |
| `proxy-worker.js` | Cloudflare Worker 用の取得proxy（方法A） |
| `server.js` | ローカル用サーバー（方法B・依存ゼロ） |
