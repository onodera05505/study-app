# 25. SSO を wrangler.jsonc の env に入れたら、API 検査が全対象で「検査用アカウントを用意できなかった」で落ちる

- **日付/場所**: 2026-09-17 / `scripts/check_api.sh`（ローカルの wrangler dev、msg を出す前のリハーサル）
- **症状**: `bash scripts/check_api.sh msg` が `検査用アカウントを用意できなかった` / `404 が返った（201 か 409 のはず）: {'error': 'アカウントはまなびばで作ります'}` で止まる。msg に限らず全対象で同じ
- **原因**: SSO の配備で `SSO_PORTAL_URL` を wrangler.jsonc の各 env の vars に入れた。ローカルの wrangler dev もその値を読むので学び側が SSO 有効になり、パスワード登録が 404 になった。check_api.py は「ローカルは SSO 未設定」を前提にパスワードで検査用アカウントを作っていた
- **対処**: check_api.sh の wrangler dev に `--var "SSO_PORTAL_URL:"`（空で上書き。`ssoOn = !!env.SSO_PORTAL_URL` が偽になる）を足した。SSO 有効の経路は `check_sso_flow.py`（ローカル）と `check_sso_prod.sh`（本番）が見る
- **再発防止**: check_api.sh 自体が SSO を切って起動する。check_api.py は SSO 有効の環境を検出すると警告を出す
- **アプローチへの反映**: 無し（中央の「不変条件を門に落とす」に当たる行が無かった（grep: 門の前提, 環境の値）。認証の方式を切り替えたときに既存の検査の前提が崩れるかは、この PJ の配備の受入で見る）
- **事前の質問**: 聞いても防げない（理由: SSO の配備時は check_api を回しておらず、次の対象のリハーサルで初めて出た。配備の受入に全対象の check_api を入れるべきだった）
- **詳細**: `docs/作業ログ_2026-09-17_SSO.md`
- **検索語**: check_api, 検査用アカウント, 404, SSO_PORTAL_URL, アカウントはまなびばで作ります
