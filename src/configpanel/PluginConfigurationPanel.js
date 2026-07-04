import React, { useState, useRef, useCallback, useEffect } from 'react'

const S = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0'
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 10,
    marginTop: 24
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnPrimary: { background: '#3b82f6', color: '#fff' },
  btnSave: { background: '#10b981', color: '#fff' },
  btnDanger: { background: '#ef4444', color: '#fff', padding: '4px 10px', fontSize: 11 },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 12px',
    background: '#f8f9fa',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    marginBottom: 6
  },
  itemDisabled: { opacity: 0.45 },
  dragOver: { borderColor: '#3b82f6', background: '#eef4ff' },
  handle: {
    color: '#bbb',
    fontSize: 16,
    cursor: 'grab',
    userSelect: 'none',
    flexShrink: 0,
    width: 18,
    textAlign: 'center',
    paddingTop: 8
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#e2e8f0',
    overflow: 'hidden',
    flexShrink: 0,
    fontSize: 18,
    marginTop: 2
  },
  iconImg: { width: '100%', height: '100%', objectFit: 'contain', padding: 5 },
  info: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  toggle: { flexShrink: 0, paddingTop: 8 },
  checkbox: { width: 16, height: 16, cursor: 'pointer', accentColor: '#3b82f6' },
  empty: { textAlign: 'center', padding: '30px 16px', color: '#999', fontSize: 13 },
  fieldRow: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  label: { fontSize: 13, fontWeight: 500, color: '#555', width: 160, flexShrink: 0, paddingTop: 7 },
  fieldBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  numberRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 },
  numberLabel: { fontSize: 13, fontWeight: 500, color: '#555', width: 160, flexShrink: 0 },
  input: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    width: 120,
    background: '#fff',
    color: '#333'
  },
  appInput: {
    padding: '5px 8px',
    borderRadius: 5,
    border: '1px solid #d5d5d5',
    fontSize: 13,
    background: '#fff',
    color: '#333',
    width: '100%'
  },
  appInputName: { fontWeight: 600 },
  actions: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 },
  hint: { fontSize: 11, color: '#aaa' },
  link: { color: '#3b82f6', fontWeight: 600, textDecoration: 'none' }
}

function tokenStateColor(state) {
  if (state === 'approved') return '#10b981'
  if (state === 'denied' || state === 'error') return '#ef4444'
  return '#3b82f6'
}

function uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function IconPreview({ icon, label }) {
  const iconVal = icon || ''
  if (iconVal.startsWith('/') || iconVal.startsWith('http')) {
    return (
      <div style={S.iconBox}>
        <img
          src={iconVal}
          alt={label}
          style={S.iconImg}
          onError={(e) => {
            e.target.style.display = 'none'
            e.target.parentNode.textContent = (label || '??').slice(0, 2).toUpperCase()
          }}
        />
      </div>
    )
  }
  return <div style={S.iconBox}>{iconVal || (label || '??').slice(0, 2).toUpperCase()}</div>
}

function TextField({ label, value, onChange, hint, placeholder }) {
  return (
    <div style={S.fieldRow}>
      <span style={S.label}>{label}</span>
      <div style={S.fieldBody}>
        <input
          style={{ ...S.input, width: '100%' }}
          type="text"
          value={value}
          placeholder={placeholder || ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint && <span style={S.hint}>{hint}</span>}
      </div>
    </div>
  )
}

function NumberField({ label, value, onChange, hint, placeholder }) {
  return (
    <div style={S.numberRow}>
      <span style={S.numberLabel}>{label}</span>
      <input
        style={S.input}
        type="number"
        value={value}
        placeholder={placeholder || ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
      {hint && <span style={S.hint}>{hint}</span>}
    </div>
  )
}

function SelectField({ label, value, onChange, options, hint }) {
  return (
    <div style={S.fieldRow}>
      <span style={S.label}>{label}</span>
      <div style={S.fieldBody}>
        <select style={{ ...S.input, width: '100%' }} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {hint && <span style={S.hint}>{hint}</span>}
      </div>
    </div>
  )
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {}
  const [mode, setMode] = useState(cfg.mode === 'launcher' ? 'launcher' : 'individual')
  const [ip, setIp] = useState(cfg.ip || '')
  const [port, setPort] = useState(cfg.port || 8080)
  const [serverPort, setServerPort] = useState(cfg.serverPort || '')
  const [skToken, setSkToken] = useState(cfg.skToken || '')
  // Permission level requested via the access-request API when generating a token.
  // Values match the Signal K access request spec: readonly | readwrite | admin.
  const [skAuthLevel, setSkAuthLevel] = useState('readwrite')
  const [apps, setApps] = useState(() => cfg.apps || [])

  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)

  // Access-request token generation state.
  // tokenState: '' | 'pending' | 'approved' | 'denied' | 'error'
  const [tokenState, setTokenState] = useState('')
  const [tokenMsg, setTokenMsg] = useState('')
  const [requesting, setRequesting] = useState(false)
  const pollRef = useRef(null)

  const appsRef = useRef(apps)
  appsRef.current = apps

  const statusTimeoutRef = useRef(null)
  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Poll a submitted access request until the server admin approves or denies it.
  // See https://signalk.org/specification/1.8.2/doc/access_requests.html
  const pollRequest = useCallback(
    async (href) => {
      try {
        const res = await fetch(href, { headers: { Accept: 'application/json' } })
        if (!res.ok) return // transient (e.g. 404 before the request is registered) — keep polling
        const data = await res.json()
        if (data.state !== 'COMPLETED') return // still PENDING — keep polling
        stopPolling()
        const ar = data.accessRequest || {}
        if (ar.permission === 'APPROVED' && ar.token) {
          setSkToken(ar.token)
          setTokenState('approved')
          setTokenMsg('Approved. Click Save Configuration below to store it.')
        } else if (ar.permission === 'DENIED') {
          setTokenState('denied')
          setTokenMsg('The access request was denied.')
        } else {
          setTokenState('error')
          setTokenMsg(data.message || 'The access request could not be completed.')
        }
      } catch {
        // Network hiccup — leave the interval running and try again next tick.
      }
    },
    [stopPolling]
  )

  const requestToken = useCallback(async () => {
    stopPolling()
    setRequesting(true)
    setTokenState('pending')
    setTokenMsg('Submitting access request…')
    try {
      const res = await fetch('/signalk/v1/access/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clientId: uuidv4(), description: 'Navico MFD Embedder', permissions: skAuthLevel })
      })
      const data = await res.json().catch(() => ({}))
      if (!data.href) {
        throw new Error(data.message || `Server did not return a request reference (${res.status})`)
      }
      setTokenState('pending')
      setTokenMsg('Access request submitted. Approve it in Security → Access Requests to receive the token.')
      pollRequest(data.href)
      pollRef.current = setInterval(() => pollRequest(data.href), 2000)
    } catch (e) {
      setTokenState('error')
      setTokenMsg('Access request failed: ' + (e.message || e))
    } finally {
      setRequesting(false)
    }
  }, [pollRequest, stopPolling, skAuthLevel])

  const buildConfig = useCallback(
    (appsList) => ({
      mode,
      ip,
      port,
      ...(serverPort === '' ? {} : { serverPort }),
      // Omit the token entirely when blank so clearing the field clears the
      // saved value; start() trims it again on load.
      ...(skToken.trim() ? { skToken: skToken.trim() } : {}),
      apps: appsList
    }),
    [mode, ip, port, serverPort, skToken]
  )

  const doSave = useCallback(async () => {
    if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current)
    setSaving(true)
    setStatus('Saving…')
    setStatusError(false)
    try {
      const result = save(buildConfig(apps))
      if (result && typeof result.then === 'function') {
        await result
      }
      setStatus('Configuration saved — plugin will restart')
      setStatusError(false)
      statusTimeoutRef.current = setTimeout(() => setStatus(''), 5000)
    } catch (e) {
      setStatus('Save failed: ' + (e.message || e))
      setStatusError(true)
    } finally {
      setSaving(false)
    }
  }, [apps, buildConfig, save])

  const discover = async () => {
    setDiscovering(true)
    setStatus('')
    setStatusError(false)
    try {
      const res = await fetch('/skServer/webapps')
      const allWebapps = await res.json()
      const webapps = allWebapps
        .filter((w) => w.name !== 'signalk-navico-embedder')
        .map((w) => {
          if (w.name === '@signalk/server-admin-ui') {
            return { name: w.name, label: 'SignalK Admin', url: '/admin/', icon: '/signalk-navico-embedder/signalk-logo.png', description: 'SignalK Admin' }
          }
          return {
            name: w.name,
            label: w.signalk?.displayName || w.name,
            url: `/${w.name}/`,
            icon: w.signalk?.appIcon ? `/${w.name}/${w.signalk.appIcon.replace(/^\.\//, '')}` : '',
            description: w.description || ''
          }
        })

      if (webapps.length === 0) {
        setStatus('No webapps found. Is the server fully started?')
        setStatusError(true)
        setDiscovering(false)
        return
      }

      const current = appsRef.current
      const existingUrls = new Set(current.map((a) => a.url))
      let added = 0
      const merged = [...current]
      for (const w of webapps) {
        if (!existingUrls.has(w.url)) {
          merged.push({
            enabled: true,
            url: w.url,
            label: w.label || '',
            description: w.description || '',
            icon: w.icon || ''
          })
          added++
        }
      }

      setApps(merged)
      setStatus(
        added > 0
          ? `Found ${webapps.length} webapps, added ${added} new.`
          : `All ${webapps.length} webapps already in list.`
      )
      setStatusError(false)
    } catch (e) {
      setStatus('Discovery failed: ' + e.message)
      setStatusError(true)
    }
    setDiscovering(false)
  }

  const updateApp = (i, patch) => setApps(apps.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const toggleApp = (i) => updateApp(i, { enabled: apps[i].enabled === false })
  const removeApp = (i) => setApps(apps.filter((_, j) => j !== i))

  const onDragStart = (i) => setDragIdx(i)
  const onDragOver = (e, i) => {
    e.preventDefault()
    setOverIdx(i)
  }
  const onDragLeave = () => setOverIdx(null)
  const onDrop = (e, dropIdx) => {
    e.preventDefault()
    setOverIdx(null)
    if (dragIdx !== null && dragIdx !== dropIdx) {
      const next = [...apps]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(dropIdx, 0, moved)
      setApps(next)
    }
    setDragIdx(null)
  }
  const onDragEnd = () => {
    setDragIdx(null)
    setOverIdx(null)
  }

  return (
    <div style={S.root}>
      <div style={S.sectionTitle}>Plugin Settings</div>

      <SelectField
        label="MFD display mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'individual', label: 'Individual Apps' },
          { value: 'launcher', label: 'Launcher' }
        ]}
        hint={
          mode === 'launcher'
            ? 'Announce one tile that opens the app chooser'
            : 'Announce every enabled app as its own tile'
        }
      />

      <TextField
        label="Local IP address override"
        value={ip}
        onChange={setIp}
        placeholder="auto-detect"
        hint="Leave blank to auto-detect"
      />

      <NumberField label="Proxy port" value={port} onChange={setPort} hint="default 8080" />

      <NumberField
        label="Signal K server port"
        value={serverPort}
        onChange={setServerPort}
        placeholder="auto-detect"
        hint="Leave blank to auto-detect"
      />

      <TextField
        label="Signal K auth token"
        value={skToken}
        onChange={setSkToken}
        placeholder="Leave blank if not using authentication"
        hint="Auth token injected into proxied requests."
      />

      {/* Only offer token generation when the field is empty — once a token is
          present there's nothing to request, so hide the level + generate UI. */}
      {!skToken.trim() && (
        <>
          <SelectField
            label="Authentication level"
            value={skAuthLevel}
            onChange={setSkAuthLevel}
            options={[
              { value: 'readonly', label: 'Read' },
              { value: 'readwrite', label: 'Read/Write' },
              { value: 'admin', label: 'Admin' }
            ]}
            hint="Permission level requested when generating the token. Any plugins with custom APIs will need 'admin' level."
          />

          <div style={S.fieldRow}>
            <span style={S.label} />
            <button
              style={{ ...S.btn, ...S.btnPrimary, flex: 1, justifyContent: 'center', ...(requesting ? { opacity: 0.6 } : {}) }}
              onClick={requestToken}
              disabled={requesting}
            >
              {requesting ? 'Requesting…' : 'Generate Authentication Token'}
            </button>
          </div>
        </>
      )}
      {/* Kept outside the empty-token guard so the "Approved — token inserted"
          confirmation still shows after a successful request fills the field. */}
      {tokenState && (
        <div style={{ ...S.status, color: tokenStateColor(tokenState) }}>
          {tokenMsg}
          {(tokenState === 'pending' || tokenState === 'denied') && (
            <>
              {' '}
              <a href="/admin/#/security/access/requests" target="_blank" rel="noopener noreferrer" style={S.link}>
                Open Access Requests →
              </a>
            </>
          )}
        </div>
      )}

      <div style={S.sectionTitle}>Web Apps</div>
      <button
        style={{ ...S.btn, ...S.btnPrimary, ...(discovering ? { opacity: 0.6 } : {}) }}
        onClick={discover}
        disabled={discovering}
      >
        {discovering ? 'Discovering…' : 'Discover Installed Webapps'}
      </button>
      {status && <div style={{ ...S.status, color: statusError ? '#ef4444' : '#10b981' }}>{status}</div>}

      <div style={S.sectionTitle}>MFD Apps (drag to reorder)</div>
      {apps.length === 0 ? (
        <div style={S.empty}>No apps yet. Click Discover above.</div>
      ) : (
        <div>
          {apps.map((app, i) => (
            <div
              key={app.url + i}
              onDragOver={(e) => onDragOver(e, i)}
              onDragLeave={onDragLeave}
              onDrop={(e) => onDrop(e, i)}
              style={{
                ...S.item,
                ...(app.enabled === false ? S.itemDisabled : {}),
                ...(overIdx === i ? S.dragOver : {}),
                ...(dragIdx === i ? { opacity: 0.4 } : {})
              }}
            >
              <span
                style={S.handle}
                draggable
                onDragStart={() => onDragStart(i)}
                onDragEnd={onDragEnd}
                title="Drag to reorder"
              >
                {'≡'}
              </span>
              <IconPreview icon={app.icon} label={app.label || app.url} />
              <div style={S.info}>
                <input
                  style={{ ...S.appInput, ...S.appInputName }}
                  type="text"
                  value={app.label || ''}
                  placeholder="Tile name"
                  onChange={(e) => updateApp(i, { label: e.target.value })}
                />
                <input
                  style={S.appInput}
                  type="text"
                  value={app.description || ''}
                  placeholder="Description (optional)"
                  onChange={(e) => updateApp(i, { description: e.target.value })}
                />
              </div>
              <div style={S.toggle} title="Enabled">
                <input
                  type="checkbox"
                  checked={app.enabled !== false}
                  onChange={() => toggleApp(i)}
                  style={S.checkbox}
                />
              </div>
              <button style={{ ...S.btn, ...S.btnDanger, marginTop: 6 }} onClick={() => removeApp(i)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={S.actions}>
        <button
          style={{ ...S.btn, ...S.btnSave, ...(saving ? { opacity: 0.6 } : {}) }}
          onClick={doSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
        {status && <div style={{ ...S.status, color: statusError ? '#ef4444' : '#10b981' }}>{status}</div>}
      </div>
    </div>
  )
}
