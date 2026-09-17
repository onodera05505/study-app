/* まなびば の画面（要件 §15）。依存なし。API は同一オリジンの /api。 */
(() => {
  const $ = (s) => document.querySelector(s)
  const params = new URLSearchParams(location.search)
  const next = params.get('next')
  const denied = params.get('denied')

  let me = null
  let grants = []
  let learnings = []

  async function api(path, init) {
    const res = await fetch('/api' + path, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'Content-Type': 'application/json' } : {},
      body: init?.body ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok) throw new Error((data && data.error) || '通信に失敗しました')
    return data
  }

  function show(id, on) {
    const el = $(id)
    if (el) el.hidden = !on
  }
  function notice(text, kind) {
    const el = $('#notice')
    el.textContent = text
    el.className = 'notice' + (kind ? ' ' + kind : '')
    el.hidden = !text
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

  function renderGrid() {
    const grid = $('#grid')
    grid.innerHTML = learnings
      .map((l) => {
        const ok = grants.includes(l.key)
        const inner = `<span class="kind">${esc(l.kind)}</span><span class="brand">${esc(l.brand)}</span><span class="desc">${esc(l.desc)}</span>`
        return ok
          ? `<a class="card learning" href="/sso/start?app=${encodeURIComponent(l.key)}">${inner}<span class="go">開く →</span></a>`
          : `<div class="card learning locked">${inner}<span class="go muted">権限なし</span></div>`
      })
      .join('')
  }

  function renderAdmin(accounts) {
    const thead = $('#acc-table thead')
    const tbody = $('#acc-table tbody')
    thead.innerHTML =
      '<tr><th>名前</th><th>メール</th>' +
      learnings.map((l) => `<th class="c">${esc(l.brand)}</th>`).join('') +
      '<th>役割</th><th></th></tr>'
    tbody.innerHTML = accounts
      .map(
        (a) =>
          `<tr data-id="${esc(a.id)}"><td>${esc(a.name)}</td><td class="mono">${esc(a.email)}</td>` +
          learnings
            .map(
              (l) =>
                `<td class="c"><input type="checkbox" data-grant="${esc(l.key)}" ${a.grants.includes(l.key) ? 'checked' : ''} aria-label="${esc(a.name)} に ${esc(l.brand)}"></td>`,
            )
            .join('') +
          `<td>${a.role === 'ADMIN' ? '管理者' : '利用者'}</td>` +
          `<td class="ops"><button type="button" class="btn small" data-reset>PW 再設定</button>${a.id !== me.id ? '<button type="button" class="btn small" data-del>削除</button>' : ''}</td></tr>`,
      )
      .join('')
    tbody.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', async (e) => {
        const tr = e.target.closest('tr')
        const id = tr.dataset.id
        const gs = [...tr.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => x.dataset.grant)
        try {
          await api('/admin/accounts/' + id, { method: 'PUT', body: { grants: gs } })
          notice('権限を保存しました', 'ok')
        } catch (err) {
          notice(err.message, 'ng')
          e.target.checked = !e.target.checked
        }
      })
    })
    tbody.querySelectorAll('[data-reset]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        const tr = e.target.closest('tr')
        const pw = prompt(`${tr.children[0].textContent} の新しいパスワード（8 文字以上）。本人に伝えてください`)
        if (!pw) return
        try {
          await api('/admin/accounts/' + tr.dataset.id + '/password', { method: 'POST', body: { password: pw } })
          notice('パスワードを再設定しました（その人のログイン中のセッションは切れます）', 'ok')
        } catch (err) {
          notice(err.message, 'ng')
        }
      })
    })
    tbody.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        const tr = e.target.closest('tr')
        if (!confirm(`${tr.children[0].textContent}（${tr.children[1].textContent}）を削除します。学び側の進捗は残ります。よいですか`)) return
        try {
          await api('/admin/accounts/' + tr.dataset.id, { method: 'DELETE' })
          await loadAdmin()
          notice('削除しました', 'ok')
        } catch (err) {
          notice(err.message, 'ng')
        }
      })
    })
    const fs = $('#new-grants')
    fs.innerHTML =
      '<legend>開ける学び</legend>' +
      learnings.map((l) => `<label class="inline"><input type="checkbox" name="grants" value="${esc(l.key)}"> ${esc(l.brand)}</label>`).join('')
  }

  async function loadAdmin() {
    const d = await api('/admin/accounts')
    renderAdmin(d.accounts)
  }

  async function afterLogin(data) {
    me = data.account
    grants = data.grants
    $('#who').textContent = `${me.name} としてログイン中`
    show('#who', true)
    show('#login', false)
    if (next && next.startsWith('/sso/start')) {
      location.replace(next)
      return
    }
    show('#home', true)
    renderGrid()
    if (me.role === 'ADMIN') {
      show('#admin', true)
      await loadAdmin()
    }
  }

  async function boot() {
    try {
      learnings = (await api('/learnings')).learnings
    } catch (e) {
      notice('学びの一覧が取れませんでした。再読み込みしてください', 'ng')
    }
    if (denied) {
      const l = learnings.find((x) => x.key === denied)
      notice(`「${l ? l.brand : denied}」を開く権限がありません。管理者に頼んでください`, 'ng')
    }
    try {
      const d = await api('/me')
      await afterLogin(d)
    } catch {
      show('#login', true)
      if (next) notice('ログインすると、選んだ学びへ進みます', '')
    }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    const err = $('#login-error')
    err.hidden = true
    try {
      const d = await api('/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } })
      await afterLogin(d)
    } catch (ex) {
      err.textContent = ex.message
      err.hidden = false
    }
  })

  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    const msg = $('#pw-msg')
    try {
      await api('/me/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } })
      msg.textContent = 'パスワードを変えました'
      msg.className = 'small ok'
      f.reset()
    } catch (ex) {
      msg.textContent = ex.message
      msg.className = 'small error'
    }
    msg.hidden = false
  })

  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {})
    location.replace('/')
  })

  $('#new-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    const msg = $('#new-msg')
    const gs = [...f.querySelectorAll('input[name=grants]:checked')].map((x) => x.value)
    try {
      await api('/admin/accounts', { method: 'POST', body: { email: f.email.value, name: f.name.value, password: f.password.value, grants: gs } })
      msg.textContent = '作りました。メールと初期パスワードを本人に伝えてください'
      msg.className = 'small ok'
      f.reset()
      await loadAdmin()
    } catch (ex) {
      msg.textContent = ex.message
      msg.className = 'small error'
    }
    msg.hidden = false
  })

  boot()
})()
