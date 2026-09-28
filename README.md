# Treasure Finder

ページ内の `video` 要素だけを、画面の広さや Retina 倍率に関係なく **1920×1080** の JPEG（品質 90）で残すデスクトップアプリです。

操作パネルはすぐ起動します。撮影用のブラウザは、URL を開いたときだけ立ち上がります。

## 起動

```bash
npm install
npm start
```

ブラウザで <http://127.0.0.1:47321> が開きます。URL を入れて「開く」と、撮影用の Chrome が別ウィンドウで起動します。動画が写っている状態で「この video を撮る」を押すと、`data/captures/` に JPEG が保存されます。

動作確認用のカラーバーは、パネルの「サンプル」からです。

## なぜこの構成か

撮影対象のレンダラが OS ごとに変わるのを避けるため、操作パネルと撮影ブラウザを分けています。

| 候補 | 見送りにした理由 |
| --- | --- |
| Tauri / システムの WebView | 起動は軽い。ただし Windows は WebView2、macOS は WKWebView、Linux は WebKitGTK で、動画の写り方も GPU を切るフラグも揃わない |
| WebView2 | レンダラは優秀だが Windows 専用 |
| Electron / CEF / Qt WebEngine | 描画エンジンをアプリに同梱するので、更新のたびにアプリ本体の配布が必要になる |
| 採用: Node.js + Playwright で Google Chrome を起動 | 撮影側は Win / Mac / Linux とも Chromium 系。Chrome が入っていればその自動更新がレンダラの更新になる |

Chrome が無い PC では、Playwright が配る Chromium に切り替えられます。取得はパネルの「Chromiumを取得」、または `npm run update-browser` です。Chromium の版を上げるときは `playwright` パッケージを更新してから、同じコマンドを再実行します。実行ファイルのパスを直接指定することもできます。

## ドメインごとの起動方法

ハードウェアアクセラレーションを切らないと `video` が真っ黒になるサイトがあります。標準、ソフトウェア描画（GPU とハードウェア動画デコードを無効）、SwiftShader、それに任意の起動引数を、ドメイン単位で割り当てられます。

`example.com` は `www.example.com` や `video.example.com` にも効きます。より長いホスト名を個別に登録した方が優先されます。

Cookie、ログイン状態、localStorage はアプリ専用のプロファイル（`data/user-data/`）に残ります。起動方法を切り替えても、同じレンダラなら保存先は変わりません。普段使いの Chrome プロファイルとは分けてあるので、Chrome を起動したままでもプロファイルのロックでぶつかりません。

Google Chrome と Playwright Chromium を切り替えたときだけ、プロファイルのディレクトリは別になります。バイナリが違う状態で同じユーザーデータを共有しないためです。

## 撮影

- レイアウト上のビューポートは 1920×1080、devicePixelRatio は 1 に固定します。ウィンドウが画面に収まりきらなくても、撮影座標はここを使います。
- 写っている `video` のうち、再生中で映像サイズがいちばん大きいものを選びます。iframe の中にあれば、枠ごと 1920×1080 に広げてから撮ります。
- 映像は要素いっぱいに収めます（`object-fit: contain`）。16:9 以外は上下か左右に黒帯が付きます。
- JPEG 品質は 90 です。
- User-Agent は、Google Chrome を使っているときはその Chrome 自身のデスクトップ UA です。Chromium に落としたときだけ、同じ版番号のデスクトップ Chrome に寄せた UA と Client Hints を足します。

DRM の映像は、アクセラレーションを切っても黒いままです。

## ファイル名

現在の名前はローカル時刻です。例: `20260928-080509-042.jpg`

ドメインごとの抽出は `data/config.json` の `filenameRules` にルールを書き、`src/filename.js` の `registerFilenameStrategy()` に実装を足すと繋がります。未実装の `type` はタイムスタンプに戻ります。

```json
{
  "filenameRules": {
    "default": { "type": "timestamp" },
    "domains": {
      "example.com": { "type": "timestamp" }
    }
  }
}
```

## テスト

```bash
npm test
```

撮影テストは、この PC の Google Chrome を実際に起動します。
