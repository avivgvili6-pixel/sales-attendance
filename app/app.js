(() => {
  'use strict'

  const TZ = 'Asia/Jerusalem'
  const CLOSURES = [
    ['premium', 'חבילת פרימיום'],
    ['subscriptions', 'מנויים'],
    ['trials', 'אימוני ניסיון'],
    ['personal', 'אישיים'],
  ]
  const ROLE_LABEL = { rep: 'איש מכירות', viewer: 'צופה', admin: 'מנהל' }
  const REMINDER_LABEL = {
    morning_1: 'בוקר · תזכורת 1', morning_2: 'בוקר · תזכורת 2', morning_3: 'בוקר · תזכורת 3',
    evening_1: 'סוף יום · תזכורת 1', evening_2: 'סוף יום · תזכורת 2',
    weekly: 'סיכום שבועי (ביום העבודה האחרון)', monthly: 'סיכום חודשי (ב-1 לחודש)',
  }
  const DAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']
  const ERRORS = {
    invalid_link: 'הקישור לא תקין או שבוטל. בקש קישור חדש מהמנהל.',
    not_admin: 'אין הרשאת ניהול.',
    name_required: 'צריך למלא שם.',
    no_phone: 'לאיש הזה אין מספר טלפון.',
  }

  const cfg = window.SALES_CONFIG || {}
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const $app = document.getElementById('app')

  const state = {
    token: readToken(),
    me: null,          // { person, today, workday }
    tab: null,         // today | board | admin
    mode: null,        // null | 'edit-start' | 'edit-end' | 'end-no-start'
    period: 'day',     // day | week | month
    anchor: null,      // YYYY-MM-DD
    board: null,
    admin: null,
    busy: false,
  }

  // ─── utilities ────────────────────────────────────────────────────

  function readToken() {
    const t = new URLSearchParams(location.search).get('t')
    try {
      if (t) localStorage.setItem('sales_token', t)
      return t || localStorage.getItem('sales_token')
    } catch { return t }
  }

  async function rpc(fn, args) {
    const { data, error } = await db.rpc(fn, args)
    if (error) {
      const key = Object.keys(ERRORS).find((k) => (error.message || '').includes(k))
      throw new Error(key ? ERRORS[key] : 'משהו השתבש. נסה שוב בעוד רגע.')
    }
    return data
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const num = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('he-IL'))
  const money = (n) => '₪' + Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 0 })
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—')
  const hours = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 36e5 : 0)
  const fmtHours = (h) => (h ? h.toFixed(1) : '—')

  // YYYY-MM-DD date math, done in UTC so the local zone never shifts a day.
  const d2s = (d) => d.toISOString().slice(0, 10)
  const s2d = (s) => new Date(s + 'T00:00:00Z')
  const addDays = (s, n) => { const d = s2d(s); d.setUTCDate(d.getUTCDate() + n); return d2s(d) }
  const dow = (s) => s2d(s).getUTCDay()
  const ddmm = (s) => { const [, m, d] = s.split('-'); return `${+d}.${+m}` }
  const longDate = (s) => s2d(s).toLocaleDateString('he-IL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'numeric' })
  const monthName = (s) => s2d(s).toLocaleDateString('he-IL', { timeZone: 'UTC', month: 'long', year: 'numeric' })

  function range() {
    const a = state.anchor
    if (state.period === 'day') return [a, a]
    if (state.period === 'week') { const from = addDays(a, -dow(a)); return [from, addDays(from, 6)] }
    const from = a.slice(0, 8) + '01'
    const next = s2d(from); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0)
    return [from, d2s(next)]
  }

  function toast(msg) {
    const el = document.getElementById('toast')
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => el.classList.remove('show'), 2600)
  }

  async function run(fn) {
    if (state.busy) return
    state.busy = true
    document.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try { await fn() } catch (e) { toast(e.message) } finally {
      state.busy = false
      document.querySelectorAll('button').forEach((b) => (b.disabled = false))
    }
  }

  const val = (id) => document.getElementById(id)?.value ?? ''
  const intOrNull = (v) => (String(v).trim() === '' ? null : Math.max(0, parseInt(v, 10) || 0))

  // ─── render ───────────────────────────────────────────────────────

  function render() {
    const { person, today } = state.me
    const tabs = []
    if (person.role === 'rep') tabs.push(['today', 'היום שלי'])
    tabs.push(['board', 'הצוות'])
    if (person.role === 'admin') tabs.push(['admin', 'ניהול'])

    $app.className = 'wrap' + (state.tab === 'board' || state.tab === 'admin' ? ' wide' : '')
    $app.innerHTML = `
      <header class="top">
        <h1 class="hello">שלום ${esc(person.name.split(' ')[0])}</h1>
        <span class="date">${esc(longDate(today))}</span>
      </header>
      ${tabs.length > 1 ? `<nav class="tabs">${tabs.map(([k, l]) =>
        `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>` : ''}
      <section id="view">${
        state.tab === 'today' ? viewToday()
        : state.tab === 'board' ? viewBoard()
        : viewAdmin()
      }</section>`
  }

  function stepper(id, value) {
    return `<div class="stepper">
      <button type="button" data-step="${id}" data-d="-1" aria-label="פחות">−</button>
      <input id="${id}" type="number" inputmode="numeric" min="0" value="${value ?? 0}" />
      <button type="button" data-step="${id}" data-d="1" aria-label="יותר">+</button>
    </div>`
  }

  function viewToday() {
    const w = state.me.workday
    const started = w?.started_at
    const ended = w?.ended_at

    if (w?.day_off && state.mode == null) {
      return `<div class="card">
        <h2>לא עובד היום 🌴</h2>
        <p class="muted">לא יישלחו אליך תזכורות היום.</p>
        <button class="btn ghost" data-act="day-on">בעצם אני עובד היום</button>
      </div>`
    }

    if ((!started && !ended && state.mode == null) || state.mode === 'edit-start') {
      const editing = state.mode === 'edit-start'
      return `<div class="card">
        <h2>${editing ? 'עריכת תחילת יום' : 'תחילת יום'}</h2>
        <div class="field">
          <label for="f-followups">כמה פולואפים מתוכננים היום?</label>
          ${stepper('f-followups', w?.followups_planned ?? 0)}
        </div>
        <button class="btn" data-act="check-in">${editing ? 'שמירה' : '▶ התחלתי'}</button>
        ${editing
          ? `<div class="links"><button class="link" data-act="cancel">ביטול</button></div>`
          : `<div class="links">
              <button class="link" data-act="day-off">לא עובד היום</button>
              <button class="link" data-act="end-no-start">שכחתי לסמן בבוקר · לסגירת יום</button>
            </div>`}
      </div>`
    }

    const startCard = started
      ? `<div class="card">
          <div class="status-line"><span class="dot"></span>
            התחלת ב-${time(started)}
            <span class="sub">· תכננת ${num(w.followups_planned ?? 0)} פולואפים</span>
          </div>
          ${!ended ? `<div class="links" style="justify-content:flex-start"><button class="link" data-act="edit-start">עריכה</button></div>` : ''}
        </div>`
      : ''

    if (ended && state.mode !== 'edit-end') {
      return startCard + `<div class="card">
        <h2>✓ סיימת ב-${time(ended)}</h2>
        <dl class="kv">
          ${started ? `<dt>שעות עבודה</dt><dd>${fmtHours(hours(started, ended))}</dd>` : ''}
          <dt>פולואפים מתוכננים</dt><dd>${num(w.followups_planned)}</dd>
          <dt>שיחות</dt><dd>${num(w.calls)}</dd>
          ${CLOSURES.map(([k, l]) => `<dt>${l}</dt><dd>${num(w[k])}</dd>`).join('')}
          <dt>כסף שנכנס</dt><dd>${money(w.revenue)}</dd>
        </dl>
        ${w.note ? `<div class="note">${esc(w.note)}</div>` : ''}
        <button class="btn ghost" data-act="edit-end">עריכה</button>
      </div>`
    }

    const editing = state.mode === 'edit-end'
    return startCard + `<div class="card">
      <h2>${editing ? 'עריכת סוף יום' : 'סוף יום'}</h2>
      ${started && w.followups_planned != null
        ? `<p class="muted small" style="margin:-6px 0 12px">בבוקר תכננת ${num(w.followups_planned)} פולואפים</p>` : ''}
      <div class="field">
        <label for="f-calls">כמה שיחות ביצעת?<span class="hint">לא חובה</span></label>
        <input id="f-calls" class="num-in" type="number" inputmode="numeric" min="0" value="${w?.calls ?? ''}" placeholder="—" />
      </div>
      <h3>סגירות</h3>
      ${CLOSURES.map(([k, l]) => `<div class="field"><label for="f-${k}">${l}</label>${stepper('f-' + k, w?.[k] ?? 0)}</div>`).join('')}
      <h3>כסף</h3>
      <div class="field">
        <label for="f-revenue">כמה כסף נכנס היום?</label>
        <div class="money"><span>₪</span>
          <input id="f-revenue" class="num-in" type="number" inputmode="decimal" min="0" step="any" value="${w?.revenue ?? ''}" placeholder="0" />
        </div>
      </div>
      <h3>הערה <span class="muted small">(לא חובה)</span></h3>
      <textarea id="f-note" placeholder="משהו שכדאי לדעת על היום?">${esc(w?.note ?? '')}</textarea>
      <button class="btn" data-act="check-out">${editing ? 'שמירה' : '■ סיימתי'}</button>
      ${editing || state.mode === 'end-no-start'
        ? `<div class="links"><button class="link" data-act="cancel">ביטול</button></div>` : ''}
    </div>`
  }

  function sumDays(rows) {
    const s = { days: 0, hours: 0, followups: 0, calls: 0, callsSeen: false, revenue: 0 }
    CLOSURES.forEach(([k]) => (s[k] = 0))
    for (const r of rows) {
      if (r.day_off) continue
      if (r.started_at || r.ended_at) s.days++
      s.hours += hours(r.started_at, r.ended_at)
      s.followups += r.followups_planned || 0
      if (r.calls != null) { s.calls += r.calls; s.callsSeen = true }
      CLOSURES.forEach(([k]) => (s[k] += r[k] || 0))
      s.revenue += Number(r.revenue || 0)
    }
    s.closures = CLOSURES.reduce((a, [k]) => a + s[k], 0)
    return s
  }

  function viewBoard() {
    const b = state.board
    const [from, to] = range()
    const label = state.period === 'day'
      ? (from === b?.today ? 'היום' : `${DAY_NAMES[dow(from)]} ${ddmm(from)}`)
      : state.period === 'week' ? `${ddmm(from)}–${ddmm(to)}` : monthName(from)
    const header = `<div class="period">
      <div class="seg">${[['day', 'יום'], ['week', 'שבוע'], ['month', 'חודש']].map(([k, l]) =>
        `<button data-period="${k}" class="${state.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="nav">
        <button data-shift="-1" aria-label="הקודם">‹</button>
        <span class="label">${esc(label)}</span>
        <button data-shift="1" aria-label="הבא">›</button>
      </div>
    </div>`
    if (!b) return header + `<div class="loading">טוען…</div>`

    const team = sumDays(b.days)
    const kpis = `<div class="kpis">
      <div class="kpi"><div class="k">כסף שנכנס</div><div class="v">${money(team.revenue)}</div></div>
      <div class="kpi"><div class="k">סגירות</div><div class="v">${num(team.closures)}</div></div>
      <div class="kpi"><div class="k">שיחות</div><div class="v">${team.callsSeen ? num(team.calls) : '—'}</div></div>
      <div class="kpi"><div class="k">פולואפים מתוכננים</div><div class="v">${num(team.followups)}</div></div>
    </div>`

    if (!b.people.length) return header + `<div class="empty">עוד אין אנשי מכירות.</div>`

    if (state.period === 'day') {
      const isToday = from === b.today
      return header + kpis + b.people.map((p) => {
        const w = b.days.find((d) => d.person_id === p.id)
        let chip
        if (w?.day_off) chip = `<span class="chip">לא עובד</span>`
        else if (w?.ended_at) chip = `<span class="chip ok">סיים ${time(w.ended_at)}</span>`
        else if (w?.started_at) chip = `<span class="chip work">${isToday ? 'עובד' : 'לא סגר יום'} · מ-${time(w.started_at)}</span>`
        else chip = `<span class="chip warn">${isToday ? 'עוד לא התחיל' : 'לא דיווח'}</span>`
        return `<div class="card">
          <div class="rep-head"><span class="name">${esc(p.name)}</span>${chip}</div>
          ${w && !w.day_off ? `<div class="mini">
            <div><div class="k">התחיל</div><div class="v">${time(w.started_at)}</div></div>
            <div><div class="k">סיים</div><div class="v">${time(w.ended_at)}</div></div>
            <div><div class="k">שעות</div><div class="v">${fmtHours(hours(w.started_at, w.ended_at))}</div></div>
            <div><div class="k">פולואפים</div><div class="v">${num(w.followups_planned)}</div></div>
            <div><div class="k">שיחות</div><div class="v">${num(w.calls)}</div></div>
            <div><div class="k">כסף</div><div class="v big">${w.ended_at ? money(w.revenue) : '—'}</div></div>
            ${CLOSURES.map(([k, l]) => `<div><div class="k">${l}</div><div class="v">${w.ended_at ? num(w[k]) : '—'}</div></div>`).join('')}
          </div>${w.note ? `<div class="note">${esc(w.note)}</div>` : ''}` : ''}
        </div>`
      }).join('')
    }

    const rows = b.people.map((p) => ({ name: p.name, s: sumDays(b.days.filter((d) => d.person_id === p.id)) }))
    rows.push({ name: 'סה״כ צוות', s: team, total: true })
    return header + kpis + `<div class="table-wrap"><table>
      <thead><tr><th></th><th>ימים</th><th>שעות</th><th>פולואפים</th><th>שיחות</th>
        ${CLOSURES.map(([, l]) => `<th>${l}</th>`).join('')}<th>כסף</th></tr></thead>
      <tbody>${rows.map(({ name, s, total }) => `<tr class="${total ? 'total' : ''}">
        <td>${esc(name)}</td><td>${s.days}</td><td>${fmtHours(s.hours)}</td><td>${num(s.followups)}</td>
        <td>${s.callsSeen ? num(s.calls) : '—'}</td>
        ${CLOSURES.map(([k]) => `<td>${num(s[k])}</td>`).join('')}<td>${money(s.revenue)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="export"><button class="btn ghost small" data-act="csv">ייצוא לאקסל</button></div>`
  }

  function viewAdmin() {
    const a = state.admin
    if (!a) return `<div class="loading">טוען…</div>`
    const s = a.settings || {}
    const workDays = (s.work_days || '').split(',').filter(Boolean).map(Number)
    const needsSetup = !s.app_url || !s.greenapi_instance || !s.greenapi_token

    return `
      ${needsSetup ? `<div class="card" style="border-color:var(--warn)">
        <h2>⚠️ להשלמת ההתקנה</h2>
        <p class="muted" style="margin:0">${!s.app_url ? 'צריך לשמור את כתובת האתר. ' : ''}${!s.greenapi_instance || !s.greenapi_token ? 'צריך לחבר את Green API כדי שהודעות וואטסאפ יישלחו.' : ''}</p>
      </div>` : ''}

      <div class="card">
        <h2>אנשים</h2>
        ${a.people.map((p) => `<div class="person ${p.active ? '' : 'inactive'}">
          <div class="row1"><span class="name">${esc(p.name)}</span>
            <span class="chip">${ROLE_LABEL[p.role]}</span>${p.active ? '' : '<span class="chip">לא פעיל</span>'}
            <span class="phone">${esc(p.phone || 'אין טלפון')}</span></div>
          <div class="actions">
            <button class="btn ghost small" data-copy="${esc(p.link)}">העתקת קישור</button>
            ${p.phone ? `<button class="btn ghost small" data-test="${p.id}">הודעת בדיקה</button>` : ''}
            <button class="btn ghost small" data-edit="${p.id}">עריכה</button>
          </div>
        </div>`).join('')}
        <div id="person-form"></div>
        <button class="btn ghost" data-edit="new">+ הוספת איש</button>
      </div>

      <div class="card stack">
        <h2>הגדרות</h2>
        <div><label for="s-app_url">כתובת האתר</label>
          <div style="display:flex;gap:8px"><input id="s-app_url" type="url" class="ltr" value="${esc(s.app_url)}" placeholder="https://…" />
          <button class="btn ghost small" data-act="use-url">הכתובת הנוכחית</button></div></div>
        <div><label>ימי עבודה (תזכורות נשלחות רק בימים האלה)</label>
          <div class="days">${DAY_NAMES.map((n, i) => `<label><input type="checkbox" data-wd="${i}" ${workDays.includes(i) ? 'checked' : ''}/> ${n}</label>`).join('')}</div></div>
        <h3>Green API (שליחת וואטסאפ)</h3>
        <div><label for="s-greenapi_url">apiUrl</label><input id="s-greenapi_url" type="url" class="ltr" value="${esc(s.greenapi_url)}" /></div>
        <div class="grid2">
          <div><label for="s-greenapi_instance">idInstance</label><input id="s-greenapi_instance" type="text" class="ltr" value="${esc(s.greenapi_instance)}" /></div>
          <div><label for="s-greenapi_token">apiTokenInstance</label><input id="s-greenapi_token" type="text" class="ltr" value="${esc(s.greenapi_token)}" /></div>
        </div>
        <button class="btn" data-act="save-settings">שמירת הגדרות</button>
      </div>

      <div class="card">
        <h2>תזכורות וסיכומים</h2>
        <p class="muted small" style="margin-top:-8px">בהודעות אפשר להשתמש ב-{name} וב-{link}.</p>
        ${(a.reminders || []).map((r) => `<div class="rem" data-rem="${r.kind}">
          <div class="row1">
            <span class="name">${REMINDER_LABEL[r.kind] || r.kind}</span>
            <input type="time" value="${r.at_time.slice(0, 5)}" data-f="at" />
            <label class="small"><input type="checkbox" data-f="on" ${r.enabled ? 'checked' : ''}/> פעיל</label>
          </div>
          ${r.audience === 'not_started' || r.audience === 'not_ended'
            ? `<textarea data-f="msg" style="margin-top:8px">${esc(r.message)}</textarea>` : ''}
        </div>`).join('')}
        <button class="btn" data-act="save-reminders">שמירת תזכורות</button>
      </div>

      <div class="card">
        <h2>הודעות אחרונות</h2>
        ${a.log.length ? `<div class="table-wrap"><table class="log">
          <thead><tr><th>מתי</th><th>סוג</th><th>למי</th><th>סטטוס</th></tr></thead>
          <tbody>${a.log.map((l) => `<tr>
            <td>${new Date(l.created_at).toLocaleString('he-IL', { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(REMINDER_LABEL[l.kind]?.split(' (')[0] || (l.kind === 'test' ? 'בדיקה' : l.kind))}</td>
            <td>${esc(l.name || l.phone)}</td>
            <td title="${esc(l.response || '')}">${l.status_code == null ? (s.greenapi_instance ? '…' : 'לא נשלח') : l.status_code === 200 ? '✓' : '✗ ' + l.status_code}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">עוד לא נשלחו הודעות.</p>'}
        <div class="export"><button class="btn ghost small" data-act="reload-admin">רענון</button></div>
      </div>`
  }

  function personForm(p) {
    const el = document.getElementById('person-form')
    el.innerHTML = `<div class="card stack" style="background:var(--soft);margin-top:12px">
      <h2>${p ? 'עריכה' : 'איש חדש'}</h2>
      <div><label for="p-name">שם</label><input id="p-name" type="text" value="${esc(p?.name)}" /></div>
      <div><label for="p-phone">טלפון לוואטסאפ</label><input id="p-phone" type="tel" class="ltr" value="${esc(p?.phone)}" placeholder="050-0000000" /></div>
      <div><label for="p-role">תפקיד</label><select id="p-role">
        ${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${(p?.role || 'rep') === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <label><input id="p-active" type="checkbox" ${p?.active === false ? '' : 'checked'} /> פעיל</label>
      <button class="btn" data-save-person="${p?.id || ''}">שמירה</button>
      <div class="links">
        ${p ? `<button class="link" data-newlink="${p.id}">ביטול הקישור הישן ויצירת קישור חדש</button>` : ''}
        <button class="link" data-act="close-person">סגירה</button>
      </div>
    </div>`
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // ─── data loading ─────────────────────────────────────────────────

  async function loadBoard() {
    const [from, to] = range()
    state.board = null
    render()
    state.board = await rpc('app_board', { p_token: state.token, p_from: from, p_to: to })
    render()
  }

  async function loadAdmin() {
    state.admin = await rpc('app_admin', { p_token: state.token })
    render()
  }

  async function openTab(tab) {
    state.tab = tab
    try { sessionStorage.setItem('sales_tab', tab) } catch {}
    render()
    if (tab === 'board') await loadBoard()
    if (tab === 'admin') await loadAdmin()
  }

  function csv() {
    const b = state.board
    const names = Object.fromEntries(b.people.map((p) => [p.id, p.name]))
    const head = ['תאריך', 'שם', 'לא עובד', 'התחלה', 'סיום', 'שעות', 'פולואפים מתוכננים', 'שיחות',
      ...CLOSURES.map(([, l]) => l), 'כסף', 'הערה']
    const lines = b.days
      .filter((d) => names[d.person_id])
      .map((d) => [d.day, names[d.person_id], d.day_off ? 'כן' : '',
        d.started_at ? time(d.started_at) : '', d.ended_at ? time(d.ended_at) : '',
        hours(d.started_at, d.ended_at) ? hours(d.started_at, d.ended_at).toFixed(2) : '',
        d.followups_planned ?? '', d.calls ?? '', ...CLOSURES.map(([k]) => d[k] ?? 0), d.revenue ?? '', d.note ?? ''])
    const body = [head, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }))
    const [from, to] = range()
    a.download = `נוכחות-${from}-${to}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // ─── events ───────────────────────────────────────────────────────

  $app.addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t || state.busy) return
    const d = t.dataset

    if (d.tab) return run(() => openTab(d.tab))
    if (d.step) {
      const input = document.getElementById(d.step)
      input.value = Math.max(0, (parseInt(input.value, 10) || 0) + Number(d.d))
      return
    }
    if (d.period) { state.period = d.period; return run(loadBoard) }
    if (d.shift) {
      const n = Number(d.shift)
      if (state.period === 'day') state.anchor = addDays(state.anchor, n)
      else if (state.period === 'week') state.anchor = addDays(state.anchor, 7 * n)
      else { const x = s2d(state.anchor.slice(0, 8) + '01'); x.setUTCMonth(x.getUTCMonth() + n); state.anchor = d2s(x) }
      return run(loadBoard)
    }
    if (d.copy) {
      navigator.clipboard?.writeText(d.copy).then(() => toast('הקישור הועתק'), () => prompt('העתק את הקישור:', d.copy))
      return
    }
    if (d.edit) return personForm(d.edit === 'new' ? null : state.admin.people.find((p) => p.id === d.edit))
    if (d.test) return run(async () => {
      state.admin = await rpc('app_admin_test', { p_token: state.token, p_id: d.test })
      toast('נשלחה הודעת בדיקה'); render()
      setTimeout(() => state.tab === 'admin' && run(loadAdmin), 4000)
    })
    if (d.newlink) {
      if (!confirm('הקישור הישן יפסיק לעבוד. להמשיך?')) return
      return run(async () => {
        state.admin = await rpc('app_admin_new_link', { p_token: state.token, p_id: d.newlink })
        toast('נוצר קישור חדש'); render()
      })
    }
    if ('savePerson' in d) return run(async () => {
      state.admin = await rpc('app_admin_save_person', {
        p_token: state.token, p_id: d.savePerson || null, p_name: val('p-name'),
        p_phone: val('p-phone'), p_role: val('p-role'), p_active: document.getElementById('p-active').checked,
      })
      toast('נשמר'); render()
    })

    const act = d.act
    if (!act) return
    const me = (data) => { state.me = data; state.mode = null; render() }
    const actions = {
      'check-in': () => run(async () => {
        me(await rpc('app_check_in', { p_token: state.token, p_followups: intOrNull(val('f-followups')) ?? 0 }))
        toast('יום טוב! ההתחלה נרשמה')
      }),
      'check-out': () => {
        const revenue = val('f-revenue').trim()
        if (revenue === '') { toast('כמה כסף נכנס היום? אם לא נכנס, רשום 0'); document.getElementById('f-revenue').focus(); return }
        return run(async () => {
          const wasEnded = !!state.me.workday?.ended_at
          const args = { p_token: state.token, p_calls: intOrNull(val('f-calls')), p_revenue: Math.max(0, Number(revenue) || 0), p_note: val('f-note') }
          CLOSURES.forEach(([k]) => (args['p_' + k] = intOrNull(val('f-' + k)) ?? 0))
          me(await rpc('app_check_out', args))
          toast(wasEnded ? 'נשמר' : 'תודה! היום נסגר')
        })
      },
      'day-off': () => run(async () => { me(await rpc('app_day_off', { p_token: state.token, p_off: true })); toast('סומן: לא עובד היום') }),
      'day-on': () => run(async () => me(await rpc('app_day_off', { p_token: state.token, p_off: false }))),
      'edit-start': () => { state.mode = 'edit-start'; render() },
      'edit-end': () => { state.mode = 'edit-end'; render() },
      'end-no-start': () => { state.mode = 'end-no-start'; render() },
      cancel: () => { state.mode = null; render() },
      csv,
      'use-url': () => { document.getElementById('s-app_url').value = location.origin + location.pathname },
      'save-settings': () => run(async () => {
        const values = {}
        ;['app_url', 'greenapi_url', 'greenapi_instance', 'greenapi_token'].forEach((k) => (values[k] = val('s-' + k)))
        values.work_days = [...document.querySelectorAll('[data-wd]')].filter((c) => c.checked).map((c) => c.dataset.wd).join(',')
        state.admin = await rpc('app_admin_save_settings', { p_token: state.token, p_values: values })
        toast('ההגדרות נשמרו'); render()
      }),
      'save-reminders': () => run(async () => {
        for (const el of document.querySelectorAll('[data-rem]')) {
          const msg = el.querySelector('[data-f="msg"]')
          state.admin = await rpc('app_admin_save_reminder', {
            p_token: state.token, p_kind: el.dataset.rem,
            p_at: el.querySelector('[data-f="at"]').value || '00:00',
            p_message: msg ? msg.value : null,
            p_enabled: el.querySelector('[data-f="on"]').checked,
          })
        }
        toast('התזכורות נשמרו'); render()
      }),
      'reload-admin': () => run(loadAdmin),
      'close-person': () => { document.getElementById('person-form').innerHTML = '' },
    }
    actions[act]?.()
  })

  // When the app comes back to the foreground, refresh what's on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.me || state.busy || state.mode) return
    rpc('app_me', { p_token: state.token }).then((data) => {
      const dayChanged = data.today !== state.me.today
      state.me = data
      if (dayChanged) state.anchor = data.today
      if (state.tab === 'board') loadBoard().catch(() => {})
      else if (state.tab === 'today') render()
    }).catch(() => {})
  })

  // ─── start ────────────────────────────────────────────────────────

  async function start() {
    if (!state.token) {
      $app.innerHTML = `<div class="card" style="margin-top:40px"><h2>צריך קישור אישי</h2>
        <p class="muted" style="margin:0">פתח את המערכת מהקישור האישי שקיבלת בוואטסאפ.</p></div>`
      return
    }
    try {
      state.me = await rpc('app_me', { p_token: state.token })
    } catch (e) {
      $app.innerHTML = `<div class="card" style="margin-top:40px"><h2>לא הצלחנו להיכנס</h2>
        <p class="muted" style="margin:0">${esc(e.message)}</p></div>`
      return
    }
    state.anchor = state.me.today
    const role = state.me.person.role
    let saved = null
    try { saved = sessionStorage.getItem('sales_tab') } catch {}
    const allowed = role === 'rep' ? ['today', 'board'] : role === 'admin' ? ['board', 'admin'] : ['board']
    await run(() => openTab(allowed.includes(saved) ? saved : allowed[0]))
  }

  start()
})()
