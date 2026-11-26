/** UC-039「学びとまなびばを本番に用意して出し、本番の保存先を手入れする」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。止まり方は各要件のテストが見る）。
 *  運用者の手元を影の根（tests/server/UC-039_fixture.local.ts）に置き、配備の道具は偽物、本番の後半が回す各段の道具は呼ばれたことを
 *  記録する包みにする。本番の SSO の一巡は、まなびばと学びの代わりの相手（tests/server/UC-039_counterparts.ts）に向けて回す。
 *  手元のほかへの接続と本体のチェックアウトへの書き込みは OS の囲いが断つ。 */

import { afterAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/server/lib/auth'
import { startCounterparts } from '../server/UC-039_counterparts'
import { FAKE_SSO_SECRET, crashed, learningDb, pagesCalls, portalDb, projectOf, redact, removeShadows, runTool, secretsPut, shadow39, sql, storageCalls } from '../server/UC-039_fixture.local'

afterAll(removeShadows)

const STEPS = ['build_target_dataset.py', 'build_seed.py', 'check_seed.py', 'd1_migrations.sh', 'seed_remote.sh', 'deploy-pages.sh', 'align_app_settings.sh']

describe('UC-039 学びとまなびばを本番に用意して出し、本番の保存先を手入れする', () => {
  // @scenario UC-039
  it('運用者が学びを本番に用意し、まなびばと共有秘密を置き、後半を回して本番に出し、本番の SSO の一巡が通ることを見る', async () => {
    const s = shadow39('scenario', { wrap: Object.fromEntries(STEPS.map((f) => [f, 0])) })
    s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)

    // 1〜2. 運用者が学びを指定して本番の用意を回し、システムが配信先・構造の変更・署名の秘密を用意する
    const prepared = await runTool(s, 'bootstrap_personal.sh', ['mkt'])
    expect(crashed(prepared), redact(prepared.out)).toBe(false)
    expect(prepared.code, redact(prepared.out)).toBe(0)
    expect(storageCalls(prepared).some((a) => a[1] === 'migrations' && a[2] === 'apply' && a.includes(projectOf('mkt').db!)), '構造の変更を当てていない').toBe(true)
    expect((secretsPut(s).JWT_SECRET ?? []).length, '署名の秘密を置いていない').toBe(1)

    // 3. 運用者が、まなびばを組み立て、共有秘密を学び側の配信先に置く
    const portal = await runTool(s, 'build_portal.py', [])
    expect(portal.code, redact(portal.out)).toBe(0)
    const secret = await runTool(s, 'set_sso_secret.sh', [])
    expect(secret.code, redact(secret.out)).toBe(0)
    expect(pagesCalls(secret).some((a) => a[3] === 'SSO_SECRET' && a.includes(projectOf('mkt').project!)), '共有秘密を置いていない').toBe(true)

    // 4〜5. 運用者が学びを指定して本番に出す後半を回し、システムが投入から模試の設定までを順に回す
    const finished = await runTool(s, 'finish_remote.sh', ['mkt'])
    expect(crashed(finished), redact(finished.out)).toBe(false)
    expect(finished.code, redact(finished.out)).toBe(0)
    const calledAt = (tool: string) => finished.log.findIndex((e) => e.tool === tool)
    const order = ['check_seed.py', 'seed_remote.sh', 'deploy-pages.sh', 'align_app_settings.sh'].map(calledAt)
    expect(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), `後半の順が違う: ${order.join(',')}`).toBe(true)

    // 6. 運用者が、本番の SSO の一巡を確かめる（手元の確かめの利用者を置き、本番のまなびばと学びの代わりの相手に向けて回す）
    sql(learningDb(s, 'local', 'mkt'), `INSERT INTO users (id, email, name, password_hash) VALUES ('ac', 'apicheck@example.com', 'ac', '${await hashPassword('apicheck-pass-1234')}');`)
    portalDb(s, 'remote')
    learningDb(s, 'remote', 'mkt')
    const counterparts = await startCounterparts(s, 'mkt')
    const smoke = await runTool(s, 'check_sso_prod_smoke.py', ['mkt'], { applySeed: true }, counterparts.env).finally(() => counterparts.close())

    // 7. 運用者が、学びが本番に出て SSO が通ることを見る
    expect(smoke.code, `本番の SSO の一巡が通らない: ${redact(smoke.out)}`).toBe(0)
  }, 300_000)
})
