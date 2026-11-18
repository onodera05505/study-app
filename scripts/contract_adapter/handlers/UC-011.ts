/**
 * UC-011 の受け持ち（まなびばの管理の経路）。
 *
 * 前提: 管理者の山田（8a0f…・作成 1758000000・権限 ap と ip）と一般の利用者の鈴木（1c7e…・作成 1758600000・権限 ip）。
 * 呼ぶ本人は管理者の山田。例の名前が notAdmin・forbiddenBeforeInvalid（役割が管理者でない）なら鈴木、noSession なら本人無し。
 * 作る操作の成功例（createAccount.ok）は鈴木がまだ居ない状態で、作られる id を実例の値にそろえる。
 * 最後の管理者の例（lastAdmin…。errors の when「重なった別の求めが先に書き込まれ、受け付けると管理者が 0 人になる」）は、
 * もう 1 人の管理者の佐藤（3e9a…）を置き、実例の要求が書き込む直前に、佐藤が山田の役割を外す求めを先に済ませる。
 */

import { withUuids } from '../kit/outside'
import { HANAKO, JIRO, YUDAI } from '../kit/people'
import { portalWorld, type PortalWorld } from '../kit/portal'
import { defineHandler, type ExampleLine, type Operation } from '../kit/protocol'

async function premise(line: ExampleLine): Promise<{ world: PortalWorld; caller: string | null }> {
  const world = await portalWorld()
  await world.account({ ...YUDAI, role: 'ADMIN', grants: ['ap', 'ip'], createdAt: 1758000000 })
  const creating = line.operation === 'createAccount' && line.case === 'ok'
  if (!creating) await world.account({ ...HANAKO, role: 'MEMBER', grants: ['ip'], createdAt: 1758600000 })
  if (line.case.startsWith('lastAdmin')) {
    await world.account({ ...JIRO, role: 'ADMIN', grants: ['ip'], createdAt: 1758300000 })
    const jiro = world.session(JIRO.id)
    world.beforeFirstWrite(() =>
      world.other(`/api/admin/accounts/${YUDAI.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...world.cookie(jiro) },
        body: JSON.stringify({ role: 'MEMBER' }),
      }),
    )
  }
  const member = line.case === 'notAdmin' || line.case === 'forbiddenBeforeInvalid'
  return { world, caller: world.session(member ? HANAKO.id : YUDAI.id) }
}

const run: Operation = async (line) => {
  const { world, caller } = await premise(line)
  if (line.operation === 'createAccount' && line.case === 'ok') return withUuids([HANAKO.id], () => world.send(line, caller))
  return world.send(line, caller)
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-011',
  operations: {
    listAccounts: run,
    createAccount: run,
    updateAccount: run,
    resetAccountPassword: run,
    deleteAccount: run,
  },
})
