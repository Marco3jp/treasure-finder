# Treasure Finder

ページ内の `video` 要素だけを、画面の広さや Retina 倍率に関係なく **1920×1080** の JPEG（品質 90）で残すデスクトップアプリです。

操作パネルはすぐ起動します。撮影用のブラウザは、URL を開いたときだけ立ち上がります。

## 起動

普段使っている Google Chrome を、別プロセス・別ユーザーデータで起動します。ホストに Node.js は要りません。配布物は Bun で作った単一実行ファイルです。

Windows なら、ビルド済みの `treasure-finder-win.exe` を置くだけで動きます。Google Chrome が入っていることが前提です。

```text
treasure-finder-win.exe
```

起動すると、いつも使っているブラウザで <http://127.0.0.1:47321> が開きます。URL を入れて「開く」と、撮影用の Chrome がもう一つのウィンドウで起動します。動画が写っている状態で「この video を撮る」を押すと、実行ファイルと同じ場所の `data/captures/` に JPEG が保存されます。

終了は、コンソールで Ctrl+C です。撮影用 Chrome も一緒に閉じます。

データを別の場所に置きたいときは、`TREASURE_FINDER_HOME` にそのフォルダを指定します。`data/` はその中に作られます。

### 単一実行ファイルを作る

ビルドするマシンにだけ [Bun](https://bun.sh) が要ります。出来た実行ファイルを動かす側には、Bun も Node.js も要りません。

```bash
bun run build:win
bun run build:mac
bun run build:linux
```

成果物は `dist/` に出ます。Windows 向けは `dist/treasure-finder-win.exe` です。クロスコンパイルできるので、Windows 以外からでも Windows 用を作れます。

### ソースから動かす

```bash
npm start
```

Bun があるなら `bun src/server.js` でも同じです。このときはリポジトリ直下の `data/` を使います。

動作確認用のカラーバーは、パネルの「サンプル」からです。

## なぜこの構成か

撮影対象のレンダラが OS ごとに変わるのを避けるため、操作パネルと撮影ブラウザを分けています。

| 候補 | 見送りにした理由 |
| --- | --- |
| Tauri / システムの WebView | 起動は軽い。ただし Windows は WebView2、macOS は WKWebView、Linux は WebKitGTK で、動画の写り方も GPU を切るフラグも揃わない |
| WebView2 | レンダラは優秀だが Windows 専用 |
| Electron / CEF / Qt WebEngine | 描画エンジンをアプリに同梱するので、更新のたびにアプリ本体の配布が必要になる |
| Node.js + Playwright | 撮影側は Chromium 系に揃う。ただし実行する PC に Node.js と依存パッケージが要る |
| 採用: Bun の単一実行ファイルから、入っている Google Chrome を起動 | 実行ファイルひとつで起動できる。レンダラの更新は Chrome 自身の自動更新に任せられる |

Chrome のハードウェアアクセラレーションは、プロセスを起動したときの引数で決まります。既に開いている Chrome の中のスレッドとして、別の GPU 設定だけを足すことはできません。その代わり、普段の Chrome とは別の `--user-data-dir` で別プロセスを起動します。普段のウィンドウを開いたままでも、プロファイルのロックではぶつかりません。

ログイン、Cookie、localStorage は、その専用ディレクトリ（`data/user-data/`）に残ります。起動方法を切り替えてブラウザを開き直しても、同じ実行ファイルなら保存先は変わりません。

実行ファイルのパスを直接指定することもできます。Google Chrome 以外の Chromium 系を指したときだけ、User-Agent を同じ版番号のデスクトップ Chrome に寄せます。

## ドメインごとの起動方法

ハードウェアアクセラレーションを切らないと `video` が真っ黒になるサイトがあります。標準、ソフトウェア描画（GPU とハードウェア動画デコードを無効）、SwiftShader、それに任意の起動引数を、ドメイン単位で割り当てられます。

`example.com` は `www.example.com` や `video.example.com` にも効きます。より長いホスト名を個別に登録した方が優先されます。

Google Chrome と、パスを指定した別バイナリでは、ユーザーデータのディレクトリを分けます。バイナリが違う状態で同じユーザーデータを共有しないためです。

## 撮影

- 普段のビューポートはウィンドウの大きさのままです。撮影中だけ 1920×1080 に固定して、撮り終えたら戻します。devicePixelRatio は 1 に固定します。
- 表示の大きさで配信の画質を選ぶプレイヤーのために、`video` を 1920×1080 に広げてから、映像がその解像度に上がったフレームを待って撮ります。5 秒待っても上がらなければ、その時点の映像で撮ります。
- 写っている `video` のうち、再生中で映像サイズがいちばん大きいものを選びます。iframe の中にあれば、枠ごと 1920×1080 に広げてから撮ります。
- 映像は要素いっぱいに収めます（`object-fit: contain`）。16:9 以外は上下か左右に黒帯が付きます。
- JPEG 品質は 90 です。
- User-Agent は、Google Chrome を使っているときはその Chrome 自身のデスクトップ UA です。別バイナリに切り替えたときだけ、同じ版番号のデスクトップ Chrome に寄せた UA と Client Hints を足します。

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
