# 私の世界の見方 オンライン

「私の世界の見方」を友人同士で遊ぶための招待制 Web アプリです。画面とサーバー処理は新規実装し、カード内容には既存 ata の[単語カード](https://github.com/ddsotos/ata/blob/main/game_server/ata_things.json)と[お題カード](https://github.com/ddsotos/ata/blob/main/game_server/ata_descriptions.json)を使います。

## ローカルで起動

必要環境: Node.js 22 以降、npm。

```sh
npm install
npm run dev
```

`wrangler dev` がローカル Worker、Durable Object、画面をまとめて起動します。表示されたローカル URL を開き、別のブラウザまたはプライベートウィンドウを使って2人以上で試せます。Cloudflare アカウントへのログインはローカル起動には不要です。

手元の Node.js が18系で、システム全体の更新を避けたい場合は、ビルド後に一時的な Node.js 22 で Wrangler を起動できます。

```sh
npm run build
npm exec --yes --package=node@22 -- wrangler dev
```

別のターミナルで `npm exec --yes --package=node@22 -- node scripts/smoke.mjs` を実行すると、部屋作成から5点到達、切断復帰、観戦者の参加、リセット、除外まで確認できます。

## Cloudflare へ公開

1. Cloudflare アカウントを用意し、`npx wrangler login` を実行します。
2. `wrangler.toml` の Worker 名を自分のアカウント内で使う名前に変更します。
3. `npm run deploy` を実行します。初回公開では SQLite Durable Object の `GameRoom` クラスが作成されます。
4. 発行された `workers.dev` URL を開いて部屋を作成し、別ブラウザで招待 URL から入室します。

ログイン前の公開確認には `npx wrangler deploy --temporary` も使えます。一時アカウントには引き取り期限があり、継続利用するには表示された引き取り URL から自分の Cloudflare アカウントへ紐づけてください。引き取り URL は秘密情報として扱います。

公開 URL を別の実端末で開き、1台は Wi-Fi、もう1台は携帯回線で参加・回答・切断復帰を確認すると、ローカル表示では分からない接続問題を検出できます。

利用状況と Durable Objects の無料枠を Cloudflare ダッシュボードで定期的に確認してください。公開 URL を独自ドメインに割り当てる場合は Cloudflare DNS で設定します。

## 遊び方

- 作成者が部屋を作り、招待 URL または QR コードを共有します。
- 作成者は待機画面の「CPUを追加」から空席へCPUを入れられます。CPUは準備完了済みとして扱われ、1人でもCPUと対戦できます。作成者はCPUをプレイヤー一覧から除外できます。
- 2〜8人が参加し、全員が「準備完了」にしたら作成者が開始します。
- 親以外は5枚の手札から1枚を選び、確定ボタンで提出します。親も手札を見られますが、そのラウンドでは選択できません。
- 親は回答を1枚ずつ公開し、一番好きな回答を選んで確定します。公開済みの回答を表示したまま選ばれた1枚を強調し、3秒のカウントダウン後に回答者と得点を公開します。
- プレイヤーの回答が選ばれるとその人が1点、ダミーが選ばれると親が1点減点（0点が下限）です。
- 5点に達した人が出たラウンドの結果後にゲーム終了です。同じ部屋で再戦できます。
- プレイヤーが切断するとゲームを止めます。本人の復帰で自動再開し、戻らない場合は作成者が除外できます。
- 作成者が2分間戻らない場合、接続中で入室が最も早いプレイヤーへ管理を引き継ぎます。

## 構成

- `src/`: TypeScript の UI、スマートフォン対応スタイル
- `worker/`: 部屋 API、WebSocket、ゲーム進行と Durable Object
- `data/`: 再利用するカード JSON
- `wrangler.toml`: Workers、静的アセット、SQLite Durable Object の設定

ゲーム状態は Durable Object の SQLite ストレージに保存し、24時間操作のない部屋を削除します。プレイヤーの手札は認証済みの本人にだけ配信します。アカウント登録はなく、復帰用トークンをブラウザのローカルストレージに保存します。

## Jev CPU

Cloudflare AI の [`typesafe/jev`](https://developers.cloudflare.com/ai/models/typesafe/jev/) を Worker の AI binding から呼びます。回答者のCPUはお題と5枚の手札、親のCPUはお題と公開済みの回答から、Jev の Choice で1枚を選びます。候補以外のカードは採用しません。

ローカルの Wrangler では AI binding が使えない環境があるため、その場合とモデルの応答がない場合は候補からランダムに選び、ゲームを続けます。実際に Jev を使う動作は、Cloudflare アカウントで AI binding を有効にして公開した環境で確認してください。Jev の利用には Cloudflare のモデル利用料金がかかります。利用条件と料金はリンク先で確認してください。

CPUの動作確認は `npm run smoke:cpu`、Jev のリクエスト形式と代替動作の確認は `npm run test:cpu-choice` で実行できます。

### Cloudflare を通さず Jev の入力を試す

Node.js 22 以降で `npm run jev:direct` を実行し、表示される `http://127.0.0.1:8790` を開きます。この環境の Node.js が 22 未満なら、`npm exec --yes --package=node@22 -- node --experimental-strip-types scripts/jev-direct.mjs` で起動できます。画面で回答側・親側の初期入力を選び、お題、候補、指示文または入力 JSON を編集して送信します。生の Jev 応答と選択カードを表示します。

[TypeSafe のダッシュボード](https://console.typesafe.ai/)で取得した API キーを画面に入力するか、起動前に `TYPESAFE_API_KEY` 環境変数へ設定します。キーは画面内では保存しません。TypeSafe API はローカル HTML からのブラウザ直接通信を許可しないため、localhost の Node サーバーが `https://api.typesafe.ai/v1/systemone` に直接送ります。Cloudflare は使いません。送信はボタン操作時だけで、TypeSafe 側の利用料金が発生する可能性があります。

Jev の実応答を単独で確認するには、Cloudflare の `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN`、または TypeSafe の `TYPESAFE_API_KEY` を環境変数に設定し、`npm exec --yes --package=node@22 -- node --experimental-strip-types scripts/jev-live.mjs` を実行します。スクリプトは CPU と同じ入力を送り、返されたカードが候補内か検査して、モデル名と応答を表示します。キーはリポジトリやチャットに記載しないでください。Cloudflare の Worker 内で Jev が動いたかは、デプロイ後に Worker ログの `CPU Jev choice accepted` で確認できます。代替選択時は理由を含む警告を出します。
