/**
 * Web / Desktop client for `dsh-qoder-bots` — Standalone Super-Agent / Bot OS Workspace
 *
 * Pure Standalone Architecture (Zero Workspace Session-List or Chat-Box Pollution):
 *   - Registers ONLY `sidebar.panellist` (`Bots`, order 15) + `main` (`'qoder-bots-studio'`).
 *   - NEVER creates items in the regular `工作区` / `默认工作区` session list.
 *   - NEVER injects a toggle switch into the regular `新会话` composer (`conversation.hero.options`).
 *   - NEVER mounts a tab onto regular workspace conversations (`sidebarRightTabs`).
 *
 * Design Philosophy:
 *   - **DeepSeek Super Agent**: Solves the human attention bottleneck via a persistent
 *     Chief-of-Staff Router + Multi-Worker sub-agent delegation (`Coordinator` + `Threads`),
 *     asynchronous background execution, and Proactive Attention Triage (`Needs Approval` + Inbox).
 *   - **Always-On Cloud Computer**: Each Bot lives in its own persistent Cloud Computer
 *     powered by **Qoder Cloud Agents** (`/api/v1/cloud`), with a live Cloud Chrome viewport,
 *     1-click `🕹️ 人工接管`, persistent `Memory Store` + CoW `Dream`, and `7×24 Routines`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-qoder-bots',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'qoderBots'
    const PANEL_ID = 'qoder-bots-studio'
    const API_BASE = '/api/qoder-bots'

    const zh = { navLabel: 'Bots' }
    const en = { navLabel: 'Bots' }

    async function apiGet(path, params) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      const res = await fetch(API_BASE + path + qs, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response (' + res.status + ')' }))
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || ('HTTP ' + res.status))
      }
      return data
    }

    async function apiAction(action, payload) {
      const res = await fetch(API_BASE + '/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      })
      const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response (' + res.status + ')' }))
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || ('HTTP ' + res.status))
      }
      return data
    }

    function fileUrl(fileId, filename, inline) {
      const q = new URLSearchParams({ id: fileId })
      if (filename) q.set('name', filename)
      if (inline) q.set('inline', '1')
      return API_BASE + '/file?' + q.toString()
    }

    function isImgName(name, mime) {
      if (mime && mime.indexOf('image/') === 0) return true
      if (!name) return false
      return /\.(png|jpe?g|webp|gif|svg)$/i.test(name)
    }

    function formatTimeAgo(iso) {
      if (!iso) return ''
      const ms = Date.now() - Date.parse(iso)
      if (!Number.isFinite(ms)) return ''
      const sec = Math.max(0, Math.floor(ms / 1000))
      if (sec < 60) return sec <= 5 ? '刚刚' : (sec + ' 秒前')
      const min = Math.floor(sec / 60)
      if (min < 60) return min + ' 分钟前'
      const hr = Math.floor(min / 60)
      if (hr < 24) return hr + ' 小时前'
      return Math.floor(hr / 24) + ' 天前'
    }

    // Normalize internal file reference tokens for clean UI display
    function cleanDisplayText(str) {
      if (!str || typeof str !== 'string') return ''
      return str.replace(/file_[0-9a-zA-Z._-]+/g, '已就绪')
    }

    // Clean Robot Icon for Left Primary Navigation (`sidebar.panellist` -> `Bots`)
    function BotsNavIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 3, y: 6, width: 18, height: 13, rx: 3.5 }),
      h('path', { d: 'M12 2v4' }),
      h('circle', { cx: 12, cy: 2, r: 1, fill: 'currentColor' }),
      h('circle', { cx: 9, cy: 12.2, r: 1.3, fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: 15, cy: 12.2, r: 1.3, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M9.5 15.8h5' }))
    }

    const S = {
      card: {
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.20))',
        background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.78)))',
        padding: 16,
        boxShadow: '0 2px 10px rgba(15, 23, 42, 0.03)',
      },
      pill: (tone) => {
        const palettes = {
          blue: { bg: 'rgba(65, 118, 230, 0.12)', fg: '#2b63d9', bd: 'rgba(65, 118, 230, 0.25)' },
          green: { bg: 'rgba(16, 185, 129, 0.12)', fg: '#059669', bd: 'rgba(16, 185, 129, 0.28)' },
          amber: { bg: 'rgba(245, 158, 11, 0.14)', fg: '#d97706', bd: 'rgba(245, 158, 11, 0.34)' },
          purple: { bg: 'rgba(139, 92, 246, 0.12)', fg: '#7c3aed', bd: 'rgba(139, 92, 246, 0.28)' },
          teal: { bg: 'rgba(13, 148, 136, 0.12)', fg: '#0f766e', bd: 'rgba(13, 148, 136, 0.26)' },
          neutral: { bg: 'rgba(148, 163, 184, 0.13)', fg: 'var(--dsw-alias-label-secondary, #64748b)', bd: 'rgba(148, 163, 184, 0.22)' },
        }
        const p = palettes[tone] || palettes.neutral
        return {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 500,
          lineHeight: '16px',
          background: p.bg,
          color: p.fg,
          border: '1px solid ' + p.bd,
          whiteSpace: 'nowrap',
        }
      },
      btnPrimary: (disabled) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '7px 13px',
        borderRadius: 9,
        border: 'none',
        background: disabled ? 'rgba(65,118,230,0.42)' : 'linear-gradient(135deg, #4176E6 0%, #315FD2 100%)',
        color: '#ffffff',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: disabled ? 'none' : '0 2px 8px rgba(65, 118, 230, 0.22)',
      }),
      btnSecondary: (active, disabled) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        padding: '6px 11px',
        borderRadius: 9,
        border: '1px solid ' + (active ? 'rgba(65,118,230,0.45)' : 'var(--dsw-alias-line-primary, rgba(128,138,158,0.24))'),
        background: active ? 'rgba(65,118,230,0.10)' : 'transparent',
        color: active ? '#2b63d9' : 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }),
      btnDanger: (disabled) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        padding: '6px 11px',
        borderRadius: 9,
        border: '1px solid rgba(239, 68, 68, 0.32)',
        background: 'rgba(239, 68, 68, 0.08)',
        color: '#dc2626',
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }),
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 11px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.28))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
        outline: 'none',
      },
    }

    // --- Human-in-the-Loop Approval Gate Card (`Needs Approval`) ---
    function ApprovalCard({ item, onDecide, compact }) {
      const [busy, setBusy] = React.useState(false)
      const [denyReason, setDenyReason] = React.useState('')
      const [showDenyInput, setShowDenyInput] = React.useState(false)

      const decide = async (decision) => {
        setBusy(true)
        try {
          await onDecide(item, decision, denyReason)
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        'data-testid': 'qoder-approval-card',
        style: {
          borderRadius: 12,
          border: '1.5px solid rgba(245, 158, 11, 0.58)',
          background: 'linear-gradient(180deg, rgba(245, 158, 11, 0.12) 0%, rgba(245, 158, 11, 0.04) 100%)',
          padding: compact ? 12 : 15,
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: compact ? 12.5 : 13.5, color: '#b45309' } },
          h('span', null, '🛡️ Needs Approval · 人类决策门禁'),
          h('span', { style: S.pill('amber') }, item.toolName),
        ),
        h('span', { style: { fontSize: 11, opacity: 0.7 } }, formatTimeAgo(item.createdAt)),
      ),
      h('div', { style: { fontSize: 12, opacity: 0.88 } },
        'Bot ',
        h('strong', null, item.botName),
        ' 在专属云电脑请求执行敏感操作：',
      ),
      h('pre', {
        style: {
          margin: 0,
          padding: '8px 10px',
          borderRadius: 8,
          background: 'rgba(15, 23, 42, 0.06)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight: 100,
          overflowY: 'auto',
        },
      }, cleanDisplayText(item.inputSummary || JSON.stringify(item.rawInput, null, 2))),
      showDenyInput && h('input', {
        type: 'text',
        value: denyReason,
        onChange: e => setDenyReason(e.target.value),
        placeholder: '输入拒绝原因或替代指令（将直接反馈给 Bot）…',
        style: S.input,
      }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('button', {
          type: 'button',
          'data-testid': 'qoder-approve-allow-btn',
          disabled: busy,
          onClick: () => decide('allow'),
          style: {
            padding: '6px 14px',
            borderRadius: 8,
            border: 'none',
            background: '#059669',
            color: '#fff',
            fontWeight: 600,
            fontSize: 12,
            cursor: busy ? 'wait' : 'pointer',
          },
        }, busy ? '处理中…' : '✓ 批准并继续执行'),
        !showDenyInput
          ? h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => setShowDenyInput(true),
              style: S.btnDanger(busy),
            }, '✕ 拒绝操作…')
          : h('button', {
              type: 'button',
              'data-testid': 'qoder-approve-deny-btn',
              disabled: busy,
              onClick: () => decide('deny'),
              style: S.btnDanger(busy),
            }, '确认拒绝并反馈'),
      ))
    }

    // --- Step Pill inside Bot Message Stream (Tool / Browser / Sub-Worker Thread / Artifact) ---
    function StepChain({ steps }) {
      const [expanded, setExpanded] = React.useState(true)
      if (!steps || steps.length === 0) return null
      const iconOf = (k) => {
        if (k === 'browser') return '🌐'
        if (k === 'bash') return '💻'
        if (k === 'file') return '📄'
        if (k === 'thread') return '🧵'
        if (k === 'artifact') return '📸'
        if (k === 'approval') return '🛡️'
        if (k === 'thinking') return '💭'
        return '🔧'
      }
      return h('div', {
        'data-testid': 'bot-message-steps',
        style: {
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.18))',
          background: 'rgba(148, 163, 184, 0.05)',
          padding: '7px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        },
      },
      h('div', {
        onClick: () => setExpanded(!expanded),
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-secondary, #64748b)',
        },
      },
      h('span', null, '⚡ 自主执行轨迹 · ' + steps.length + ' 步操作'),
      h('span', { style: { fontSize: 11, opacity: 0.75 } }, expanded ? '收起 ▴' : '展开 ▾')),
      expanded && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } },
        steps.slice(-10).map(st => h('div', {
          key: st.id,
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            fontSize: 11.5,
            lineHeight: '17px',
            color: st.kind === 'thread'
              ? '#6d28d9'
              : st.kind === 'approval'
                ? '#b45309'
                : 'var(--dsw-alias-label-primary, inherit)',
          },
        },
        h('span', { style: { flexShrink: 0 } }, iconOf(st.kind)),
        h('span', { style: { fontWeight: 600, flexShrink: 0 } }, cleanDisplayText(st.title)),
        st.detail && h('span', {
          style: {
            fontSize: 11,
            opacity: 0.72,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          },
        }, cleanDisplayText(st.detail)))),
      ))
    }

    // =========================================================================
    // STANDALONE 3-PANE SUPER-AGENT / BOT OS WORKSPACE (`BotsStudioApp`)
    // =========================================================================
    function BotsStudioApp() {
      const [dash, setDash] = React.useState(null)
      const [loadingDash, setLoadingDash] = React.useState(true)
      const [selectedBotId, setSelectedBotId] = React.useState('')
      const [adoptedSessionId, setAdoptedSessionId] = React.useState(null)
      const [centerTab, setCenterTab] = React.useState('workspace') // 'workspace' | 'inbox' | 'memory' | 'routines'
      const [rightTab, setRightTab] = React.useState('desktop') // 'desktop' | 'workers' | 'artifacts'
      const [compState, setCompState] = React.useState(null)
      const [composerText, setComposerText] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [banner, setBanner] = React.useState(null)

      // Modals
      const [createModalOpen, setCreateModalOpen] = React.useState(false)
      const [teamModalOpen, setTeamModalOpen] = React.useState(false)
      const [editingBot, setEditingBot] = React.useState(null)

      // Create Bot Form
      const [tplId, setTplId] = React.useState('web-operator')
      const [newBotName, setNewBotName] = React.useState('')
      const [newBotDesc, setNewBotDesc] = React.useState('')
      const [newApproval, setNewApproval] = React.useState('auto')
      const [newBrowser, setNewBrowser] = React.useState(true)
      const [newSkillIds, setNewSkillIds] = React.useState([])
      const [newVaultIds, setNewVaultIds] = React.useState([])
      const [creating, setCreating] = React.useState(false)

      // Create Super-Agent Team Form
      const [teamName, setTeamName] = React.useState('')
      const [teamDesc, setTeamDesc] = React.useState('')
      const [teamMembers, setTeamMembers] = React.useState(['code-reviewer', 'deep-researcher'])
      const [creatingTeam, setCreatingTeam] = React.useState(false)

      // Proactive Inbox State
      const [expandedRunId, setExpandedRunId] = React.useState(null)
      const [runReports, setRunReports] = React.useState({})
      const [loadingRunId, setLoadingRunId] = React.useState(null)

      // Memory & Dream State
      const [memList, setMemList] = React.useState([])
      const [memStore, setMemStore] = React.useState(null)
      const [selectedMemPath, setSelectedMemPath] = React.useState('')
      const [memContent, setMemContent] = React.useState('')
      const [memBusy, setMemBusy] = React.useState(false)
      const [newFileMode, setNewFileMode] = React.useState(false)
      const [newFilePath, setNewFilePath] = React.useState('')

      // Routine State
      const [rtName, setRtName] = React.useState('')
      const [rtPreset, setRtPreset] = React.useState('0 9 * * 1-5')
      const [rtCustomCron, setRtCustomCron] = React.useState('0 9 * * 1-5')
      const [rtPrompt, setRtPrompt] = React.useState('')
      const [rtBusy, setRtBusy] = React.useState(false)

      const streamEndRef = React.useRef(null)

      const notify = (type, text) => {
        setBanner({ type, text })
        if (type === 'ok') {
          setTimeout(() => {
            setBanner(prev => (prev && prev.text === text ? null : prev))
          }, 5000)
        }
      }

      const loadDashboard = React.useCallback(async (silent) => {
        if (!silent) setLoadingDash(true)
        try {
          const d = await apiGet('/dashboard')
          setDash(d)
          if (d.bots && d.bots.length > 0) {
            setSelectedBotId((prev) => {
              if (prev && d.bots.some(b => b.id === prev)) return prev
              const active = d.activeSelection && d.activeSelection.botId
              if (active && d.bots.some(b => b.id === active)) return active
              // Prefer web-scout or team if present, else first bot
              const preferred = d.bots.find(b => b.browserEnabled && !b.isTeam) || d.bots[0]
              return preferred.id
            })
          }
        } catch (err) {
          if (!silent) notify('err', String(err.message || err))
        } finally {
          if (!silent) setLoadingDash(false)
        }
      }, [])

      const pollWorkspace = React.useCallback(async () => {
        if (!selectedBotId) return
        try {
          const params = { botId: selectedBotId }
          if (adoptedSessionId) params.remoteSessionId = adoptedSessionId
          const data = await apiGet('/computer', params)
          setCompState(data)
        } catch {
          // Ignore transient poll errors
        }
      }, [selectedBotId, adoptedSessionId])

      React.useEffect(() => {
        void loadDashboard(false)
        const t = setInterval(() => { void loadDashboard(true) }, 5000)
        return () => clearInterval(t)
      }, [loadDashboard])

      React.useEffect(() => {
        if (!selectedBotId) return
        void pollWorkspace()
        const t = setInterval(() => { void pollWorkspace() }, 1800)
        return () => clearInterval(t)
      }, [pollWorkspace, selectedBotId])

      const loadMemoriesForBot = React.useCallback(async (targetBotId) => {
        if (!targetBotId) return
        setMemBusy(true)
        try {
          const res = await apiAction('inspectMemories', { botId: targetBotId })
          const entries = res.entries || []
          setMemList(entries)
          setMemStore(res.store || null)
          if (entries.length > 0) {
            const pick = entries.find(e => e.path === selectedMemPath) || entries[0]
            setSelectedMemPath(pick.path)
            if (pick.content !== undefined) {
              setMemContent(pick.content)
            } else if (res.store && res.store.id) {
              const full = await apiAction('readMemory', { memoryStoreId: res.store.id, memoryId: pick.id })
              setMemContent((full.entry && full.entry.content) || '')
            }
          } else {
            setSelectedMemPath('')
            setMemContent('')
          }
        } catch (err) {
          notify('err', '读取记忆失败：' + String(err.message || err))
        } finally {
          setMemBusy(false)
        }
      }, [selectedMemPath])

      React.useEffect(() => {
        if (centerTab === 'memory' && selectedBotId) {
          void loadMemoriesForBot(selectedBotId)
        }
      }, [centerTab, selectedBotId])

      const bots = (dash && dash.bots) || []
      const templates = (dash && dash.templates) || []
      const environments = (dash && dash.environments) || []
      const routines = (dash && dash.routines) || []
      const inboxRuns = (dash && dash.inboxRuns) || []
      const allPendingApprovals = (dash && dash.pendingApprovals) || []
      const liveComputers = (dash && dash.liveComputers) || []
      const skills = (dash && dash.skills) || []
      const vaults = (dash && dash.vaults) || []
      const activeEnvId = dash && dash.activeSelection ? dash.activeSelection.environmentId : undefined

      const activeBot = bots.find(b => b.id === selectedBotId) || (compState && compState.bot) || null
      const comp = compState && compState.computer
      const remoteSessionId = (compState && compState.remoteSessionId) || (activeBot && activeBot.primarySessionId) || null
      const takeoverUrl = compState && compState.takeoverUrl
      const messages = (compState && compState.messages) || []
      const threads = (compState && compState.threads) || []
      const botApprovals = (compState && compState.pendingApprovals) || []
      const artifacts = (comp && comp.artifacts) || []
      const activities = (comp && comp.activities) || []
      const latestFrame = comp && comp.latestBrowserFrame
      const status = (comp && comp.status) || (compState && compState.remoteSession && compState.remoteSession.status) || 'idle'
      const isBotBusy = status === 'running' || sending

      const selectBot = async (bot) => {
        setSelectedBotId(bot.id)
        setAdoptedSessionId(null)
        setCenterTab('workspace')
        apiAction('selectBot', { botId: bot.id }).catch(() => {})
      }

      const handleSendObjective = async (rawOverride) => {
        if (!activeBot) return
        const text = (typeof rawOverride === 'string' ? rawOverride : composerText).trim()
        if (!text || sending) return
        if (typeof rawOverride !== 'string') setComposerText('')
        setSending(true)
        try {
          await apiAction('sendBotMessage', {
            botId: activeBot.id,
            text,
            remoteSessionId: adoptedSessionId || undefined,
          })
          await pollWorkspace()
          setTimeout(() => {
            if (streamEndRef.current && streamEndRef.current.scrollIntoView) {
              streamEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
            }
          }, 80)
        } catch (err) {
          notify('err', '发送指令失败：' + String(err.message || err))
        } finally {
          setSending(false)
        }
      }

      const handleInterrupt = async () => {
        if (!remoteSessionId) return
        try {
          await apiAction('interruptBotTurn', { remoteSessionId })
          notify('ok', '已暂停当前执行轮次，常驻云电脑保持在线。')
          await pollWorkspace()
        } catch (err) {
          notify('err', String(err.message || err))
        }
      }

      const handleDecideApproval = async (item, decision, denyMessage) => {
        try {
          await apiAction('decideApproval', {
            toolUseId: item.toolUseId,
            remoteSessionId: item.remoteSessionId,
            decision,
            denyMessage,
          })
          notify('ok', decision === 'allow' ? '✓ 已批准操作，Bot 继续在云电脑自主推进。' : '✕ 已拒绝该操作并向 Bot 反馈原因。')
          await Promise.all([loadDashboard(true), pollWorkspace()])
        } catch (err) {
          notify('err', String(err.message || err))
        }
      }

      const handleCreateBot = async (e) => {
        e.preventDefault()
        setCreating(true)
        try {
          const res = await apiAction('createBot', {
            templateId: tplId,
            name: newBotName.trim() || undefined,
            description: newBotDesc.trim() || undefined,
            defaultRuntime: 'cloud',
            approvalMode: newApproval,
            browserEnabled: newBrowser,
            skillIds: newSkillIds,
            vaultIds: newVaultIds,
          })
          setCreateModalOpen(false)
          setNewBotName('')
          setNewBotDesc('')
          setSelectedBotId(res.bot.id)
          setAdoptedSessionId(null)
          setCenterTab('workspace')
          notify('ok', '已创建专属 Bot ' + res.bot.avatar + ' ' + res.bot.name + '（已挂载 Qoder Cloud 常驻云电脑与持久记忆库）！')
          await loadDashboard(true)
        } catch (err) {
          notify('err', '创建失败：' + String(err.message || err))
        } finally {
          setCreating(false)
        }
      }

      const handleCreateTeam = async (e) => {
        e.preventDefault()
        if (!teamName.trim() || teamMembers.length === 0) return
        setCreatingTeam(true)
        try {
          const res = await apiAction('createTeam', {
            name: teamName.trim(),
            description: teamDesc.trim() || undefined,
            members: teamMembers,
          })
          setTeamModalOpen(false)
          setTeamName('')
          setTeamDesc('')
          setSelectedBotId(res.team.id)
          setAdoptedSessionId(null)
          setCenterTab('workspace')
          notify('ok', '已组建 Super Agent 协同组 👥 ' + res.team.name + '（Router 主控 + ' + res.members.length + ' 个专业子 Bot）！')
          await loadDashboard(true)
        } catch (err) {
          notify('err', '组建失败：' + String(err.message || err))
        } finally {
          setCreatingTeam(false)
        }
      }

      const attentionCount = allPendingApprovals.length + inboxRuns.length

      // Starter quick-delegation prompts tailored to active Bot role
      const starterPrompts = activeBot && activeBot.isTeam
        ? [
            '作为主控 Router 并行调度子 Bot：审查认证模块并发安全，同时整理最新云沙箱架构简报',
            '向各专业 Worker 分发代码健康度巡检任务，汇总高优先级风险并写入长期记忆',
          ]
        : activeBot && activeBot.browserEnabled
          ? [
              '打开 https://example.com 巡检页面标题与核心正文，截图同步到右侧云电脑屏幕并一句话汇报',
              '访问目标站点验证可访问性，把关键观察记录写入长期记忆库 README.md',
            ]
          : [
              '检查当前云电脑工具链环境与挂载的长期记忆文件，并用一句话汇报就绪状态',
              '为我创建一个工作日每天 09:00 自动执行的云端巡检定时任务',
            ]

      return h('div', {
        'data-testid': 'qoder-bots-studio-page',
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base, #f8fafc)',
          color: 'var(--dsw-alias-label-primary, #0f172a)',
          boxSizing: 'border-box',
        },
      },

      // =======================================================================
      // PANE 1 (LEFT RAIL): Super-Agent Bot Roster & Proactive Attention Triage
      // =======================================================================
      h('aside', {
        'data-testid': 'qoder-bots-left-roster',
        style: {
          width: 286,
          flexShrink: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.18))',
          background: 'var(--dsw-alias-bg-layer-1, rgba(248, 250, 252, 0.75))',
          boxSizing: 'border-box',
        },
      },
      // Left Header
      h('div', {
        style: {
          padding: '16px 14px 12px',
          borderBottom: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.14))',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', {
            style: {
              width: 28,
              height: 28,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #4176E6 0%, #0D9488 100%)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              boxShadow: '0 3px 10px rgba(65,118,230,0.24)',
            },
          }, '🤖'),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em' } }, 'Bots'),
            h('div', { style: { fontSize: 10, opacity: 0.65, whiteSpace: 'nowrap' } }, 'Super Agent · Qoder'),
          ),
        ),
        h('div', { style: { display: 'flex', gap: 5, flexShrink: 0 } },
          h('button', {
            type: 'button',
            'data-testid': 'qoder-open-team-modal-btn',
            title: '组建 Router + Workers 多智能体协同组',
            onClick: () => setTeamModalOpen(true),
            style: Object.assign({}, S.btnSecondary(false, false), { padding: '5px 8px', fontSize: 11.5, whiteSpace: 'nowrap' }),
          }, '👥 Team'),
          h('button', {
            type: 'button',
            'data-testid': 'qoder-open-create-modal-btn',
            title: '新建常驻云电脑 Bot',
            onClick: () => setCreateModalOpen(true),
            style: Object.assign({}, S.btnPrimary(false), { padding: '5px 10px', fontSize: 11.5, whiteSpace: 'nowrap' }),
          }, '+ 新建'),
        ),
      ),

      // Attention Triage Shortcut (DeepSeek Super Agent's Attention Bottleneck Solver!)
      h('button', {
        type: 'button',
        'data-testid': 'qoder-triage-inbox-btn',
        onClick: () => setCenterTab(centerTab === 'inbox' ? 'workspace' : 'inbox'),
        style: {
          width: '100%',
          padding: '8px 10px',
          borderRadius: 10,
          border: allPendingApprovals.length > 0
            ? '1.5px solid rgba(245, 158, 11, 0.55)'
            : (centerTab === 'inbox' ? '1px solid rgba(65,118,230,0.45)' : '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.20))'),
          background: allPendingApprovals.length > 0
            ? 'rgba(245, 158, 11, 0.10)'
            : (centerTab === 'inbox' ? 'rgba(65,118,230,0.10)' : 'var(--dsw-alias-bg-elevated, #ffffff)'),
          color: 'inherit',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          fontWeight: 600,
        },
      },
      h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', null, allPendingApprovals.length > 0 ? '🛡️' : '📬'),
        h('span', null, allPendingApprovals.length > 0 ? '待你决策审批' : '主动汇报收件箱'),
      ),
      attentionCount > 0
        ? h('span', { style: S.pill(allPendingApprovals.length > 0 ? 'amber' : 'blue') }, String(attentionCount))
        : h('span', { style: { fontSize: 11, opacity: 0.5, fontWeight: 400 } }, '清零'))),

      // Bot Roster List
      h('div', {
        style: {
          flex: 1,
          overflowY: 'auto',
          padding: '10px 10px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        },
      },
      h('div', { style: { fontSize: 11, fontWeight: 600, opacity: 0.55, padding: '2px 6px 4px', display: 'flex', justifyContent: 'space-between' } },
        h('span', null, '常驻云电脑 BOTS (' + bots.length + ')'),
        h('span', null, '独立运行'),
      ),
      bots.length === 0 && !loadingDash && h('div', {
        style: { padding: '24px 12px', textAlign: 'center', fontSize: 12, opacity: 0.68 },
      }, '点击右上角「+ 新建」创建你的第一个常驻云电脑 Bot'),
      bots.map((bot) => {
        const selected = bot.id === (activeBot && activeBot.id) && centerTab !== 'inbox'
        const live = liveComputers.find(c => c.botId === bot.id || (bot.primarySessionId && c.remoteSessionId === bot.primarySessionId))
        const st = live ? live.status : (bot.primarySessionId ? 'online' : 'standby')
        return h('div', {
          key: bot.id,
          'data-testid': 'qoder-bot-card-' + bot.name,
          onClick: () => selectBot(bot),
          style: {
            padding: '10px 11px',
            borderRadius: 11,
            cursor: 'pointer',
            border: selected
              ? '1.5px solid rgba(65, 118, 230, 0.55)'
              : (st === 'needs_approval' ? '1.5px solid rgba(245, 158, 11, 0.55)' : '1px solid transparent'),
            background: selected
              ? 'rgba(65, 118, 230, 0.10)'
              : 'var(--dsw-alias-bg-elevated, rgba(255,255,255,0.65))',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            transition: 'all 0.14s ease',
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('span', {
              style: {
                width: 30,
                height: 30,
                borderRadius: 9,
                background: bot.isTeam ? 'rgba(139,92,246,0.14)' : 'rgba(65,118,230,0.11)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                flexShrink: 0,
              },
            }, bot.avatar || '🤖'),
            h('div', { style: { minWidth: 0 } },
              h('div', {
                style: {
                  fontWeight: selected ? 700 : 600,
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              }, bot.name),
              h('div', { style: { fontSize: 10.5, opacity: 0.62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                bot.isTeam
                  ? ('Router + ' + ((bot.teamMemberIds && bot.teamMemberIds.length) || 2) + ' Workers')
                  : (bot.browserEnabled ? '云电脑 · 实时 Chrome' : '云电脑 · 持久记忆'),
              ),
            ),
          ),
          st === 'needs_approval'
            ? h('span', { style: S.pill('amber') }, '待审批')
            : st === 'running'
              ? h('span', { style: S.pill('green') }, '⚡ 运行')
              : h('span', {
                  style: {
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: st === 'online' ? '#10b981' : '#94a3b8',
                    flexShrink: 0,
                  },
                  title: st === 'online' ? '常驻云电脑在线' : '按需唤醒',
                }),
        ))
      })),

      // Environment / Cloud Computer Footer inside Left Rail
      environments.length > 0 && h('div', {
        style: {
          padding: '10px 12px',
          borderTop: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.14))',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
        h('div', { style: { fontSize: 10.5, opacity: 0.65, fontWeight: 600 } }, '🖥️ QODER 云电脑底座'),
        h('button', {
          type: 'button',
          'data-testid': 'qoder-provision-cloud-computer-btn',
          title: '开通一台新的 Qoder Cloud 持久化云电脑 (runtime_mode=shared)',
          onClick: async () => {
            try {
              const res = await apiAction('provisionCloudComputer', {
                name: 'dsh-cloud-computer-' + Math.random().toString(36).slice(2, 6),
                idleTimeoutSeconds: 3600,
              })
              notify('ok', '🖥️ 已开通持久化云电脑 ' + res.environment.name + ' (' + res.environment.id + ') · runtime_mode=shared！')
              await Promise.all([loadDashboard(true), pollWorkspace()])
            } catch (err) {
              notify('err', '开通云电脑失败：' + String(err.message || err))
            }
          },
          style: {
            border: '1px solid rgba(65,118,230,0.32)',
            background: 'rgba(65,118,230,0.08)',
            color: '#2b63d9',
            borderRadius: 6,
            padding: '2px 7px',
            fontSize: 10.5,
            fontWeight: 600,
            cursor: 'pointer',
          },
        }, '+ 云电脑'),
      ),
      h('select', {
        value: activeEnvId || (environments[0] && environments[0].id) || '',
        onChange: async (e) => {
          await apiAction('selectEnv', { environmentId: e.target.value }).catch(err => notify('err', err.message))
          await Promise.all([loadDashboard(true), pollWorkspace()])
        },
        style: Object.assign({}, S.input, { padding: '5px 8px', fontSize: 11.5 }),
      }, environments.map(env => {
        const isShared = env && env.config && env.config.runtime_mode === 'shared'
        return h('option', { key: env.id, value: env.id }, (isShared ? '🖥️ ' : '☁️ ') + env.name + (isShared ? ' · 持久云电脑' : ' · 会话沙箱'))
      })))),

      // =======================================================================
      // PANE 2 (CENTER): Standalone Bot Objective Stream / Inbox / Memory / Cron
      // =======================================================================
      h('main', {
        'data-testid': 'qoder-bots-center-stream',
        style: {
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
        },
      },
      // Center Top Header Bar
      h('header', {
        style: {
          padding: '12px 20px',
          borderBottom: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.16))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        },
      },
      activeBot
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
            h('span', { style: { fontSize: 22 } }, activeBot.avatar || '🤖'),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: 700, fontSize: 15.5 } }, activeBot.name),
                activeBot.isTeam
                  ? h('span', { style: S.pill('purple') }, '👥 Super Agent Router + Workers')
                  : h('span', { style: S.pill('blue') }, '🖥️ 独立常驻云电脑'),
                activeBot.approvalMode === 'gated' && h('span', { style: S.pill('amber') }, '🛡️ 关键操作审批'),
                adoptedSessionId && h('span', { style: S.pill('teal') }, '📬 巡检会话接续中'),
              ),
              h('div', { style: { fontSize: 11.5, opacity: 0.66, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                cleanDisplayText(activeBot.description) || '独立于普通聊天列表运行 · 后台自主推进任务、持久记忆沉淀并在关键节点请求人类决策',
              ),
            ),
          )
        : h('div', { style: { fontWeight: 600, fontSize: 15 } }, 'Bots · Super Agent 独立工作台'),

      // Center Mode Sub-Tabs + Settings
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        [
          { id: 'workspace', label: '💬 目标委派 & 执行流' },
          { id: 'inbox', label: '📬 主动汇报' + (attentionCount > 0 ? ' (' + attentionCount + ')' : '') },
          { id: 'memory', label: '🧠 持久记忆 & Dream' },
          { id: 'routines', label: '⏰ 7×24 巡检' + (routines.length > 0 ? ' (' + routines.length + ')' : '') },
        ].map(tabItem => h('button', {
          key: tabItem.id,
          type: 'button',
          'data-testid': 'qoder-studio-tab-' + tabItem.id,
          onClick: () => setCenterTab(tabItem.id),
          style: S.btnSecondary(centerTab === tabItem.id, false),
        }, tabItem.label)),
        activeBot && h('button', {
          type: 'button',
          'data-testid': 'qoder-config-bot-btn-' + activeBot.name,
          title: '配置 Bot 权限门禁 / 重置云电脑实例',
          onClick: () => setEditingBot(activeBot),
          style: S.btnSecondary(false, false),
        }, '⚙️')),
      ),

      // Optional Status / Error Banner
      dash && dash.configured === false && h('div', {
        style: {
          margin: '12px 20px 0',
          padding: '12px 16px',
          borderRadius: 10,
          border: '1px solid rgba(245, 158, 11, 0.4)',
          background: 'rgba(245, 158, 11, 0.08)',
          fontSize: 12.5,
        },
      }, '⚠️ 未配置 Qoder Cloud 凭证：请在 ~/.dsh/.env 中设置 QODER_PAT 以启用云端常驻算力。'),

      banner && h('div', {
        style: {
          margin: '10px 20px 0',
          padding: '9px 14px',
          borderRadius: 10,
          border: '1px solid ' + (banner.type === 'err' ? 'rgba(239,68,68,0.35)' : 'rgba(16,185,129,0.35)'),
          background: banner.type === 'err' ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
          color: banner.type === 'err' ? '#dc2626' : '#059669',
          fontSize: 12.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
      },
      h('span', null, (banner.type === 'err' ? '⚠️ ' : '✓ ') + banner.text),
      h('button', {
        type: 'button',
        onClick: () => setBanner(null),
        style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 14 },
      }, '×')),

      // =====================================================================
      // CENTER VIEW A: Direct Standalone Bot Stream (`workspace`)
      // =====================================================================
      centerTab === 'workspace' && h('div', {
        style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      },
      h('div', {
        'data-testid': 'qoder-bot-message-list',
        style: {
          flex: 1,
          overflowY: 'auto',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        },
      },
      // Inline Approval Banner if current Bot is paused waiting for human sign-off
      botApprovals.map(item => h(ApprovalCard, {
        key: item.toolUseId,
        item,
        onDecide: handleDecideApproval,
        compact: false,
      })),

      messages.length === 0
        ? h('div', {
            style: {
              margin: 'auto 0',
              padding: '28px 20px',
              borderRadius: 16,
              border: '1px dashed var(--dsw-alias-line-primary, rgba(128,138,158,0.26))',
              background: 'rgba(65, 118, 230, 0.03)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 12,
            },
          },
          h('div', {
            style: {
              width: 52,
              height: 52,
              borderRadius: 16,
              background: 'linear-gradient(135deg, rgba(65,118,230,0.16), rgba(13,148,136,0.16))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
            },
          }, (activeBot && activeBot.avatar) || '🤖'),
          h('div', { style: { fontWeight: 700, fontSize: 16 } },
            activeBot ? (activeBot.name + ' · 专属云电脑已待命') : '选择一个 Bot 开始委派目标',
          ),
          h('div', { style: { fontSize: 12.5, opacity: 0.72, maxWidth: 500, lineHeight: '19px' } },
            '这是独立于普通对话列表的常驻 Bot 空间：下达高层目标后，Bot 会在专属 Qoder Cloud 云电脑中自主操作浏览器、终端与子智能体线程，仅在关键审批或交付成果时打扰你。',
          ),
          activeBot && h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 540, marginTop: 6 },
          },
          starterPrompts.map((p, idx) => h('button', {
            key: idx,
            type: 'button',
            'data-testid': 'qoder-starter-prompt-' + idx,
            onClick: () => handleSendObjective(p),
            style: {
              textAlign: 'left',
              padding: '10px 14px',
              borderRadius: 11,
              border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.22))',
              background: 'var(--dsw-alias-bg-elevated, #ffffff)',
              color: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            },
          },
          h('span', { style: { lineHeight: '18px' } }, p),
          h('span', { style: { color: '#4176E6', fontWeight: 600, flexShrink: 0 } }, '委派 →')))))
        : messages.map((msg) => {
            if (msg.role === 'user') {
              return h('div', {
                key: msg.id,
                'data-testid': 'qoder-msg-user',
                style: { display: 'flex', justifyContent: 'flex-end' },
              },
              h('div', {
                style: {
                  maxWidth: '82%',
                  padding: '10px 15px',
                  borderRadius: '16px 16px 4px 16px',
                  background: 'linear-gradient(135deg, #4176E6 0%, #315FD2 100%)',
                  color: '#ffffff',
                  fontSize: 13.5,
                  lineHeight: '20px',
                  whiteSpace: 'pre-wrap',
                  boxShadow: '0 3px 10px rgba(65, 118, 230, 0.18)',
                },
              }, cleanDisplayText(msg.text)))
            }

            return h('div', {
              key: msg.id,
              'data-testid': 'qoder-msg-assistant',
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
              },
            },
            h('span', {
              style: {
                width: 30,
                height: 30,
                borderRadius: 9,
                background: 'rgba(65, 118, 230, 0.12)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                flexShrink: 0,
                marginTop: 2,
              },
            }, (activeBot && activeBot.avatar) || '🤖'),
            h('div', {
              style: {
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              },
            },
            msg.steps && msg.steps.length > 0 && h(StepChain, { steps: msg.steps }),
            msg.text && h('div', {
              style: {
                padding: '12px 15px',
                borderRadius: '4px 14px 14px 14px',
                border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.18))',
                background: 'var(--dsw-alias-bg-elevated, #f8fafc)',
                fontSize: 13.5,
                lineHeight: '21px',
                whiteSpace: 'pre-wrap',
              },
            }, cleanDisplayText(msg.text)),
            msg.streaming && !msg.text && h('div', {
              style: { fontSize: 12.5, color: '#2b63d9', fontWeight: 500, padding: '4px 2px' },
            }, '⚡ Bot 正在专属云电脑中自主执行…'),
            msg.error && h('div', {
              style: {
                padding: '8px 12px',
                borderRadius: 9,
                background: 'rgba(239,68,68,0.08)',
                color: '#dc2626',
                fontSize: 12,
              },
            }, '⚠️ ' + cleanDisplayText(msg.error)),
            msg.artifacts && msg.artifacts.length > 0 && h('div', {
              style: { display: 'flex', flexWrap: 'wrap', gap: 8 },
            },
            msg.artifacts.map(art => h('a', {
              key: art.fileId,
              href: art.inlineUrl || art.downloadUrl,
              target: '_blank',
              rel: 'noreferrer',
              style: Object.assign({}, S.btnSecondary(false, false), { textDecoration: 'none', fontSize: 11.5 }),
            }, (art.isImage ? '📸 已同步画面: ' : '📦 交付产物: ') + art.filename)))))
          }),
      h('div', { ref: streamEndRef })),

      // Bottom Standalone Objective Composer (Never touches DSH session list!)
      h('form', {
        'data-testid': 'qoder-bot-composer-form',
        onSubmit: (e) => {
          e.preventDefault()
          void handleSendObjective()
        },
        style: {
          padding: '12px 20px 16px',
          borderTop: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.16))',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        },
      },
      adoptedSessionId && h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          borderRadius: 8,
          background: 'rgba(13, 148, 136, 0.09)',
          color: '#0f766e',
          fontSize: 11.5,
        },
      },
      h('span', null, '📬 当前正在接续后台巡检运行沙箱，追问共享完整上下文'),
      h('button', {
        type: 'button',
        onClick: () => setAdoptedSessionId(null),
        style: { border: 'none', background: 'transparent', color: '#0f766e', cursor: 'pointer', fontWeight: 600, fontSize: 11.5 },
      }, '切回主云电脑 ×')),
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          padding: '8px 10px 8px 14px',
          borderRadius: 14,
          border: '1.5px solid var(--dsw-alias-line-primary, rgba(65,118,230,0.28))',
          background: 'var(--dsw-alias-bg-elevated, #f8fafc)',
        },
      },
      h('textarea', {
        'data-testid': 'qoder-bot-composer-input',
        value: composerText,
        onChange: e => setComposerText(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void handleSendObjective()
          }
        },
        rows: 2,
        placeholder: activeBot
          ? ('向 ' + activeBot.name + ' 下达目标（在独立云电脑后台自主执行，不占用会话列表）…')
          : '请先在左侧选择或创建一个 Bot…',
        style: {
          flex: 1,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          fontSize: 13.5,
          lineHeight: '20px',
          resize: 'none',
          outline: 'none',
          fontFamily: 'inherit',
        },
      }),
      isBotBusy
        ? h('button', {
            type: 'button',
            'data-testid': 'qoder-bot-stop-btn',
            onClick: handleInterrupt,
            style: S.btnDanger(false),
          }, '⏹ 停止')
        : h('button', {
            type: 'submit',
            'data-testid': 'qoder-bot-send-btn',
            disabled: !activeBot || !composerText.trim(),
            style: S.btnPrimary(!activeBot || !composerText.trim()),
          }, '发送指令 ↑')))),

      // =====================================================================
      // CENTER VIEW B: Proactive Attention Inbox (`inbox`)
      // =====================================================================
      centerTab === 'inbox' && h('div', {
        style: { flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', null,
          h('div', { style: { fontWeight: 700, fontSize: 16 } }, '📬 主动汇报 & 人类决策门禁 (Attention Triage)'),
          h('div', { style: { fontSize: 12, opacity: 0.68, marginTop: 2 } },
            '对齐 DeepSeek Super Agent 理念：释放人类注意力瓶颈，仅当 Bot 触发敏感审批或完成 7×24 巡检报告时向你汇总。',
          ),
        ),
      ),
      allPendingApprovals.map(item => h(ApprovalCard, {
        key: item.toolUseId,
        item,
        onDecide: handleDecideApproval,
        compact: false,
      })),
      inboxRuns.length === 0 && allPendingApprovals.length === 0
        ? h('div', { style: Object.assign({}, S.card, { textAlign: 'center', padding: '42px 20px' }) },
            h('div', { style: { fontSize: 30, marginBottom: 8 } }, '✨'),
            h('div', { style: { fontWeight: 600, fontSize: 15 } }, '当前注意力收件箱已清零'),
            h('div', { style: { fontSize: 12.5, opacity: 0.7, marginTop: 4 } },
              '所有常驻云电脑 Bot 均在平稳运行；7×24 巡检报告或 Needs Approval 请求会自动投递至此。',
            ),
          )
        : inboxRuns.map((run) => {
            const isExpanded = expandedRunId === run.id
            const report = runReports[run.id]
            const hasErr = Boolean(run.error)
            return h('div', {
              key: run.id,
              'data-testid': 'qoder-inbox-run-card',
              style: Object.assign({}, S.card, { display: 'flex', flexDirection: 'column', gap: 10 }),
            },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h('span', { style: { fontSize: 21 } }, run.botAvatar || '🤖'),
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 } },
                    h('span', null, run.routineName),
                    hasErr ? h('span', { style: S.pill('amber') }, '异常') : h('span', { style: S.pill('green') }, '已投递报告'),
                  ),
                  h('div', { style: { fontSize: 12, opacity: 0.68, marginTop: 2 } },
                    '执行 Bot: ' + run.botName + ' · ' + formatTimeAgo(run.created_at),
                  ),
                ),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('button', {
                  type: 'button',
                  style: S.btnSecondary(isExpanded, loadingRunId === run.id),
                  onClick: async () => {
                    if (isExpanded) {
                      setExpandedRunId(null)
                      return
                    }
                    setExpandedRunId(run.id)
                    if (!runReports[run.id]) {
                      setLoadingRunId(run.id)
                      try {
                        const res = await apiAction('inspectRunReport', { runId: run.id })
                        setRunReports(prev => Object.assign({}, prev, { [run.id]: res.report }))
                      } catch (err) {
                        notify('err', String(err.message || err))
                      } finally {
                        setLoadingRunId(null)
                      }
                    }
                  },
                }, loadingRunId === run.id ? '加载中…' : (isExpanded ? '收起详情' : '📖 查看报告')),
                run.session_id && h('button', {
                  type: 'button',
                  'data-testid': 'qoder-inbox-resume-btn',
                  style: S.btnPrimary(false),
                  onClick: () => {
                    if (run.agent && run.agent.id) setSelectedBotId(run.agent.id)
                    setAdoptedSessionId(run.session_id)
                    setCenterTab('workspace')
                  },
                }, '💬 在 Bot 空间接续追问'),
              ),
            ),
            isExpanded && report && h('div', {
              style: {
                padding: 12,
                borderRadius: 10,
                background: 'rgba(15, 23, 42, 0.04)',
                fontSize: 12.5,
                lineHeight: '19px',
                whiteSpace: 'pre-wrap',
              },
            }, cleanDisplayText(report.finalMessage || '（巡检已完成）')))
          })),

      // =====================================================================
      // CENTER VIEW C: Persistent Memory Store & CoW Dream (`memory`)
      // =====================================================================
      centerTab === 'memory' && h('div', {
        style: { flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 },
      },
      h('div', {
        style: Object.assign({}, S.card, {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '12px 16px',
        }),
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('span', { style: { fontWeight: 700, fontSize: 14 } },
          activeBot ? (activeBot.avatar + ' ' + activeBot.name + ' · 长期记忆库') : '长期记忆库',
        ),
        memStore && h('span', { style: S.pill('blue') }, '共 ' + memList.length + ' 份记忆文档'),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('button', {
          type: 'button',
          'data-testid': 'qoder-start-dream-btn',
          disabled: memBusy || !selectedBotId,
          style: S.btnPrimary(memBusy || !selectedBotId),
          onClick: async () => {
            setMemBusy(true)
            try {
              const res = await apiAction('startDream', { botId: selectedBotId })
              const st = res.outcome && res.outcome.dream ? res.outcome.dream.status : 'running'
              notify('ok', st === 'completed'
                ? '✨ Dream 写时复制（CoW）记忆蒸馏已完成，已原子切换至新记忆快照！'
                : '✨ Dream 后台记忆蒸馏已启动。')
              await loadDashboard(true)
              await loadMemoriesForBot(selectedBotId)
            } catch (err) {
              notify('err', 'Dream 启动失败：' + String(err.message || err))
            } finally {
              setMemBusy(false)
            }
          },
        }, '✨ Dream 蒸馏记忆'),
        h('button', {
          type: 'button',
          disabled: memBusy || !selectedBotId,
          style: S.btnSecondary(false, memBusy || !selectedBotId),
          onClick: async () => {
            setMemBusy(true)
            try {
              await apiAction('rollbackDream', { botId: selectedBotId })
              notify('ok', '↩ 已无损回滚至上一版 CoW 记忆快照！')
              await loadDashboard(true)
              await loadMemoriesForBot(selectedBotId)
            } catch (err) {
              notify('err', String(err.message || err))
            } finally {
              setMemBusy(false)
            }
          },
        }, '↩ 快照回滚'),
      )),

      h('div', { style: { display: 'grid', gridTemplateColumns: '210px 1fr', gap: 14, flex: 1, minHeight: 340 } },
        h('div', { style: Object.assign({}, S.card, { padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }) },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            h('span', { style: { fontWeight: 600, fontSize: 12, opacity: 0.78 } }, '📁 记忆文件'),
            h('button', {
              type: 'button',
              style: Object.assign({}, S.btnSecondary(false, false), { padding: '2px 7px', fontSize: 11 }),
              onClick: () => {
                setNewFileMode(true)
                setNewFilePath('preferences.md')
                setMemContent('# Preferences & Guardrails\n\n- ')
              },
            }, '+ 新建'),
          ),
          newFileMode && h('input', {
            type: 'text',
            value: newFilePath,
            onChange: e => setNewFilePath(e.target.value),
            placeholder: '文件名.md',
            style: Object.assign({}, S.input, { padding: '5px 8px', fontSize: 12 }),
          }),
          memList.map(entry => h('button', {
            key: entry.id,
            type: 'button',
            onClick: async () => {
              setNewFileMode(false)
              setSelectedMemPath(entry.path)
              if (entry.content !== undefined) {
                setMemContent(entry.content)
              } else if (memStore && memStore.id) {
                const full = await apiAction('readMemory', { memoryStoreId: memStore.id, memoryId: entry.id })
                setMemContent((full.entry && full.entry.content) || '')
              }
            },
            style: {
              textAlign: 'left',
              padding: '7px 9px',
              borderRadius: 8,
              border: 'none',
              background: (!newFileMode && selectedMemPath === entry.path) ? 'rgba(65,118,230,0.12)' : 'transparent',
              color: (!newFileMode && selectedMemPath === entry.path) ? '#2b63d9' : 'inherit',
              fontWeight: (!newFileMode && selectedMemPath === entry.path) ? 600 : 400,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
            },
          },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '📄 ' + entry.path),
          entry.version && h('span', { style: { fontSize: 10.5, opacity: 0.55 } }, 'v' + entry.version))),
        ),
        h('div', { style: Object.assign({}, S.card, { padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }) },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, newFileMode ? ('新建: ' + newFilePath) : (selectedMemPath || '选择记忆文件')),
            (newFileMode || selectedMemPath) && h('button', {
              type: 'button',
              'data-testid': 'qoder-save-memory-btn',
              disabled: memBusy,
              style: S.btnPrimary(memBusy),
              onClick: async () => {
                const targetPath = (newFileMode ? newFilePath : selectedMemPath).trim()
                if (!targetPath) return
                setMemBusy(true)
                try {
                  await apiAction('writeMemory', {
                    botId: selectedBotId,
                    path: targetPath,
                    content: memContent,
                  })
                  setNewFileMode(false)
                  setSelectedMemPath(targetPath)
                  notify('ok', '已写入长期记忆 ' + targetPath + '，云电脑与定时巡检将自动挂载读取！')
                  await loadMemoriesForBot(selectedBotId)
                } catch (err) {
                  notify('err', String(err.message || err))
                } finally {
                  setMemBusy(false)
                }
              },
            }, memBusy ? '保存中…' : '💾 保存记忆'),
          ),
          h('textarea', {
            'data-testid': 'qoder-memory-editor-textarea',
            value: memContent,
            onChange: e => setMemContent(e.target.value),
            style: Object.assign({}, S.input, {
              flex: 1,
              minHeight: 260,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12.5,
              lineHeight: '19px',
              resize: 'vertical',
            }),
          }),
        ))),

      // =====================================================================
      // CENTER VIEW D: 7×24 Autonomous Cloud Routines (`routines`)
      // =====================================================================
      centerTab === 'routines' && h('div', {
        style: { flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 },
      },
      h('form', {
        onSubmit: async (e) => {
          e.preventDefault()
          if (!rtName.trim() || !rtPrompt.trim()) return
          setRtBusy(true)
          try {
            const cronExpr = rtPreset === 'manual' ? undefined : (rtPreset === 'custom' ? rtCustomCron : rtPreset)
            const res = await apiAction('createRoutine', {
              botId: selectedBotId || undefined,
              name: rtName.trim(),
              cronExpression: cronExpr,
              timezone: 'Asia/Shanghai',
              taskPrompt: rtPrompt.trim(),
            })
            setRtName('')
            setRtPrompt('')
            notify('ok', '已部署 7×24 后台巡检「' + res.deployment.name + '」，即使关闭客户端也会在 Qoder Cloud 准时唤醒！')
            await loadDashboard(true)
          } catch (err) {
            notify('err', '创建失败：' + String(err.message || err))
          } finally {
            setRtBusy(false)
          }
        },
        style: Object.assign({}, S.card, { display: 'flex', flexDirection: 'column', gap: 10 }),
      },
      h('div', { style: { fontWeight: 700, fontSize: 14.5 } },
        '⏰ 为 ' + ((activeBot && activeBot.name) || 'Bot') + ' 添加 7×24 自动巡检 (Cloud Routine)',
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
        h('input', {
          type: 'text',
          value: rtName,
          onChange: e => setRtName(e.target.value),
          placeholder: '巡检名称，例如：每日早间线上健康度与 PR 摘要',
          style: S.input,
        }),
        h('select', {
          value: rtPreset,
          onChange: e => setRtPreset(e.target.value),
          style: S.input,
        },
        h('option', { value: '0 9 * * 1-5' }, '工作日每天 09:00 (0 9 * * 1-5)'),
        h('option', { value: '0 9 * * *' }, '每天 09:00 (0 9 * * *)'),
        h('option', { value: '0 */4 * * *' }, '每 4 小时巡检一次 (0 */4 * * *)'),
        h('option', { value: 'manual' }, '按需手动唤醒'),
        h('option', { value: 'custom' }, '自定义 Cron…')),
      ),
      rtPreset === 'custom' && h('input', {
        type: 'text',
        value: rtCustomCron,
        onChange: e => setRtCustomCron(e.target.value),
        placeholder: '0 9 * * 1-5',
        style: S.input,
      }),
      h('textarea', {
        value: rtPrompt,
        onChange: e => setRtPrompt(e.target.value),
        placeholder: '输入无人值守巡检目标（产出报告将自动投递至「主动汇报收件箱」）…',
        style: Object.assign({}, S.input, { minHeight: 68, resize: 'vertical' }),
      }),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
        h('button', { type: 'submit', disabled: rtBusy, style: S.btnPrimary(rtBusy) }, rtBusy ? '部署中…' : '+ 部署 7×24 云端巡检'),
      )),

      routines.map(dep => h('div', {
        key: dep.id,
        style: Object.assign({}, S.card, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }),
      },
      h('div', null,
        h('div', { style: { fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', null, dep.name),
          dep.status === 'active'
            ? h('span', { style: S.pill('green') }, '🟢 7×24 活跃')
            : h('span', { style: S.pill('neutral') }, '⏸ 已暂停'),
          h('span', { style: S.pill('blue') }, dep.schedule ? ('Cron: ' + dep.schedule.expression) : '按需唤醒'),
        ),
        h('div', { style: { fontSize: 11.5, opacity: 0.68, marginTop: 3 } },
          '负责 Bot: ' + ((dep.metadata && dep.metadata.dsh_bot_name) || '云端 Bot'),
        ),
      ),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', {
          type: 'button',
          style: S.btnPrimary(false),
          onClick: async () => {
            try {
              await apiAction('controlRoutine', { deploymentId: dep.id, op: 'run' })
              notify('ok', '▶ 已唤醒云端巡检实例，完成后将投递至「主动汇报」！')
              await loadDashboard(true)
            } catch (err) {
              notify('err', String(err.message || err))
            }
          },
        }, '▶ 立即唤醒'),
        h('button', {
          type: 'button',
          style: S.btnSecondary(false, false),
          onClick: async () => {
            const op = dep.status === 'active' ? 'pause' : 'unpause'
            await apiAction('controlRoutine', { deploymentId: dep.id, op }).catch(err => notify('err', err.message))
            await loadDashboard(true)
          },
        }, dep.status === 'active' ? '⏸ 暂停' : '▶ 恢复'),
      ))))),

      // =======================================================================
      // PANE 3 (RIGHT DESKTOP): Live Cloud Computer, Chrome Viewport & Workers
      // =======================================================================
      h('aside', {
        'data-testid': 'qoder-live-computer-panel',
        style: {
          width: 410,
          flexShrink: 0,
          height: '100%',
          borderLeft: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.18))',
          background: 'var(--dsw-alias-bg-layer-1, rgba(248, 250, 252, 0.72))',
          padding: '14px 16px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflowY: 'auto',
        },
      },
      // Right Desktop Header
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { style: { fontSize: 17 } }, '🖥️'),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              activeBot ? (activeBot.name + ' 的云电脑桌面') : 'Bot 专属云电脑桌面',
            ),
            h('div', { style: { fontSize: 11, opacity: 0.68, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              compState && compState.environment && compState.environment.config && compState.environment.config.runtime_mode === 'shared'
                ? ('Qoder Cloud Desktop (' + ((compState.environment.runtime && compState.environment.runtime.status) || 'ready') + ')' + (compState.slotId ? ' · slot ' + compState.slotId : ''))
                : 'Qoder Cloud Agents · 实时沙箱视口',
            ),
          ),
        ),
        status === 'needs_approval'
          ? h('span', { style: S.pill('amber') }, '🛡️ 待审批')
          : isBotBusy
            ? h('span', { style: S.pill('green') }, '⚡ 执行中')
            : h('span', { style: S.pill('green') }, '🟢 在线待命'),
      ),

      // Live Cloud Chrome Browser Window
      h('div', {
        style: {
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid rgba(15, 23, 42, 0.18)',
          background: '#0f172a',
          color: '#e2e8f0',
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.13)',
          flexShrink: 0,
        },
      },
      h('div', {
        style: {
          padding: '8px 10px',
          background: '#1e293b',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        },
      },
      h('div', { style: { display: 'flex', gap: 5, flexShrink: 0 } },
        h('span', { style: { width: 9, height: 9, borderRadius: '50%', background: '#ef4444' } }),
        h('span', { style: { width: 9, height: 9, borderRadius: '50%', background: '#f59e0b' } }),
        h('span', { style: { width: 9, height: 9, borderRadius: '50%', background: '#10b981' } }),
      ),
      h('div', {
        style: {
          flex: 1,
          minWidth: 0,
          padding: '3px 8px',
          borderRadius: 6,
          background: 'rgba(15, 23, 42, 0.78)',
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#94a3b8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, (comp && comp.currentBrowserUrl) || '🌐 cloud://qoder-chromium-desktop'),
      takeoverUrl && h('a', {
        href: takeoverUrl,
        target: '_blank',
        rel: 'noreferrer',
        'data-testid': 'qoder-take-control-btn',
        title: '一键接管该 Bot 的远程 Chrome 浏览器完成登录或人工验证',
        style: {
          padding: '4px 9px',
          borderRadius: 6,
          background: 'linear-gradient(135deg, #4176E6 0%, #6366F1 100%)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 600,
          textDecoration: 'none',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        },
      }, '🕹️ 人工接管')),

      latestFrame
        ? h('div', { style: { background: '#020617' } },
            h('img', {
              'data-testid': 'qoder-live-browser-frame',
              src: fileUrl(latestFrame.fileId, latestFrame.filename, true),
              alt: latestFrame.filename,
              style: { width: '100%', display: 'block', maxHeight: 235, objectFit: 'contain' },
            }),
            h('div', {
              style: {
                padding: '5px 10px',
                fontSize: 10.5,
                color: '#94a3b8',
                display: 'flex',
                justifyContent: 'space-between',
                background: 'rgba(15, 23, 42, 0.92)',
              },
            },
            h('span', null, '📸 ' + latestFrame.filename),
            h('span', null, formatTimeAgo(latestFrame.timestamp))),
          )
        : h('div', {
            style: {
              padding: '30px 16px',
              textAlign: 'center',
              color: '#94a3b8',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 7,
            },
          },
          h('div', { style: { fontSize: 24 } }, isBotBusy ? '⚡' : '🌐'),
          h('div', { style: { fontSize: 12, fontWeight: 600, color: '#cbd5e1' } },
            isBotBusy ? '云端沙箱正在执行任务…' : 'Cloud Chrome 远程桌面已就绪',
          ),
          h('div', { style: { fontSize: 11, opacity: 0.78, maxWidth: 270, lineHeight: '16px' } },
            'Bot 操作网页时会自动将实时画面同步至此处；遇到登录态可随时点击右上角「🕹️ 人工接管」。',
          ))),

      // Right Pane Sub-Tabs: Live Feed / Multi-Worker Topology / Artifacts
      h('div', { style: { display: 'flex', gap: 6 } },
        h('button', {
          type: 'button',
          style: S.btnSecondary(rightTab === 'desktop', false),
          onClick: () => setRightTab('desktop'),
        }, '⚡ 实时事件 (' + activities.length + ')'),
        h('button', {
          type: 'button',
          style: S.btnSecondary(rightTab === 'workers', false),
          onClick: () => setRightTab('workers'),
        }, '🧵 子线程 (' + threads.length + ')'),
        h('button', {
          type: 'button',
          style: S.btnSecondary(rightTab === 'artifacts', false),
          onClick: () => setRightTab('artifacts'),
        }, '📦 产物 (' + artifacts.length + ')'),
      ),

      rightTab === 'desktop' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1 } },
        activities.length === 0
          ? h('div', { style: { fontSize: 11.5, opacity: 0.6, padding: '14px 4px', textAlign: 'center' } }, '下达目标后，云电脑实时工具与浏览器事件流将在此滚动展示。')
          : activities.slice(0, 18).map(act => h('div', {
              key: act.id,
              style: {
                padding: '7px 9px',
                borderRadius: 9,
                border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.16))',
                background: 'var(--dsw-alias-bg-elevated, #ffffff)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              },
            },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, fontWeight: 600, fontSize: 11.5 } },
              h('span', null,
                (act.kind === 'browser' ? '🌐 ' : act.kind === 'bash' ? '💻 ' : act.kind === 'artifact' ? '📸 ' : act.kind === 'approval' ? '🛡️ ' : act.kind === 'thread' ? '🧵 ' : '🔧 ')
                + cleanDisplayText(act.title)),
              h('span', { style: { fontSize: 10.5, opacity: 0.55, fontWeight: 400, flexShrink: 0 } }, formatTimeAgo(act.timestamp)),
            ),
            act.detail && h('div', {
              style: {
                fontSize: 11,
                opacity: 0.72,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, cleanDisplayText(act.detail)))),
      ),

      rightTab === 'workers' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { fontSize: 11.5, opacity: 0.72, lineHeight: '17px' } },
          'Single-Router + Multi-Worker 架构：主控 Bot 将子目标分发给独立上下文的专业子 Bot 并行执行，仅回收高信噪比结论。',
        ),
        threads.length === 0
          ? h('div', { style: Object.assign({}, S.card, { padding: 16, textAlign: 'center', fontSize: 12, opacity: 0.68 }) },
              activeBot && activeBot.isTeam
                ? '向当前 Team 下达复杂目标后，子智能体并行线程将在此实时展开。'
                : '切换到「👥 Team」协同组或组建新 Team，即可开启多子智能体并行调度。',
            )
          : threads.map(th => h('div', {
              key: th.id,
              style: Object.assign({}, S.card, { padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }),
            },
            h('div', null,
              h('div', { style: { fontWeight: 600, fontSize: 12.5 } }, '🧵 ' + ((th.agent && th.agent.name) || 'Worker 子智能体')),
              h('div', { style: { fontSize: 11, opacity: 0.6 } }, '独立上下文子线程'),
            ),
            h('span', { style: S.pill(th.status === 'running' ? 'green' : 'neutral') }, th.status || 'completed')))),

      rightTab === 'artifacts' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        artifacts.length === 0
          ? h('div', { style: { padding: 18, textAlign: 'center', fontSize: 12, opacity: 0.65 } }, '云电脑交付的截图、研报与图表将在此归档。')
          : artifacts.map(art => h('div', {
              key: art.fileId,
              style: Object.assign({}, S.card, { padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }),
            },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
              h('span', { style: { fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                '📄 ' + art.filename,
              ),
              h('a', {
                href: fileUrl(art.fileId, art.filename, false),
                target: '_blank',
                rel: 'noreferrer',
                style: Object.assign({}, S.btnPrimary(false), { padding: '3px 9px', fontSize: 11, textDecoration: 'none' }),
              }, '下载'),
            ),
            isImgName(art.filename, art.contentType) && h('img', {
              src: fileUrl(art.fileId, art.filename, true),
              alt: art.filename,
              style: { width: '100%', borderRadius: 8, maxHeight: 160, objectFit: 'contain', background: '#0f172a' },
            }))))),

      // =======================================================================
      // MODAL 1: Create Standalone Cloud Bot
      // =======================================================================
      createModalOpen && h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'rgba(15, 23, 42, 0.48)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        },
        onClick: (e) => { if (e.target === e.currentTarget) setCreateModalOpen(false) },
      },
      h('form', {
        'data-testid': 'qoder-create-bot-modal',
        onSubmit: handleCreateBot,
        style: Object.assign({}, S.card, {
          width: '100%',
          maxWidth: 660,
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
        }),
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('h2', { style: { margin: 0, fontSize: 17.5, fontWeight: 700 } }, '+ 新建常驻云电脑 Bot (Powered by Qoder Cloud Agents)'),
        h('button', { type: 'button', onClick: () => setCreateModalOpen(false), style: S.btnSecondary(false, false) }, '关闭'),
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 9 } },
        templates.map(tpl => h('button', {
          key: tpl.id,
          type: 'button',
          'data-testid': 'qoder-tpl-' + tpl.id,
          onClick: () => setTplId(tpl.id),
          style: {
            textAlign: 'left',
            padding: 11,
            borderRadius: 11,
            border: tplId === tpl.id ? '2px solid #4176E6' : '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.22))',
            background: tplId === tpl.id ? 'rgba(65,118,230,0.08)' : 'transparent',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: 'inherit',
          },
        },
        h('div', { style: { fontWeight: 600, fontSize: 12.5 } }, tpl.avatar + ' ' + tpl.id),
        h('div', { style: { fontSize: 11, opacity: 0.72, lineHeight: '15px' } }, tpl.description))),
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
        h('input', {
          type: 'text',
          'data-testid': 'qoder-create-name-input',
          value: newBotName,
          onChange: e => setNewBotName(e.target.value),
          placeholder: 'Bot 名称（留空默认 dsh-bot-' + tplId + '）',
          style: S.input,
        }),
        h('input', {
          type: 'text',
          value: newBotDesc,
          onChange: e => setNewBotDesc(e.target.value),
          placeholder: '职责描述（可选）…',
          style: S.input,
        }),
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
        h('label', {
          style: {
            padding: 11,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.22))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
          },
        },
        h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '🌐 启用 Cloud Chrome 浏览器 & 人工接管'),
        h('input', { type: 'checkbox', checked: newBrowser, onChange: e => setNewBrowser(e.target.checked) })),
        h('label', {
          'data-testid': 'qoder-create-gated-toggle',
          style: {
            padding: 11,
            borderRadius: 10,
            border: newApproval === 'gated' ? '1.5px solid rgba(245,158,11,0.55)' : '1px solid var(--dsw-alias-line-primary, rgba(128,138,158,0.22))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
          },
        },
        h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '🛡️ 敏感操作需人类审批 (Needs Approval)'),
        h('input', { type: 'checkbox', checked: newApproval === 'gated', onChange: e => setNewApproval(e.target.checked ? 'gated' : 'auto') })),
      ),
      skills.length > 0 && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        skills.map(sk => {
          const checked = newSkillIds.includes(sk.id)
          return h('button', {
            key: sk.id,
            type: 'button',
            onClick: () => setNewSkillIds(prev => checked ? prev.filter(x => x !== sk.id) : prev.concat([sk.id])),
            style: S.btnSecondary(checked, false),
          }, (checked ? '✓ ⚡ ' : '+ ⚡ ') + (sk.display_title || sk.id))
        }),
      ),
      vaults.length > 0 && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        vaults.map(v => {
          const checked = newVaultIds.includes(v.id)
          return h('button', {
            key: v.id,
            type: 'button',
            onClick: () => setNewVaultIds(prev => checked ? prev.filter(x => x !== v.id) : prev.concat([v.id])),
            style: S.btnSecondary(checked, false),
          }, (checked ? '✓ 🔐 ' : '+ 🔐 ') + (v.display_name || v.id))
        }),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10 } },
        h('button', { type: 'button', onClick: () => setCreateModalOpen(false), style: S.btnSecondary(false, false) }, '取消'),
        h('button', { type: 'submit', 'data-testid': 'qoder-submit-create-bot', disabled: creating, style: S.btnPrimary(creating) }, creating ? '分配云电脑中…' : '创建 Bot'),
      ))),

      // =======================================================================
      // MODAL 2: Assemble Super-Agent Router + Workers Team
      // =======================================================================
      teamModalOpen && h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'rgba(15, 23, 42, 0.48)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        },
        onClick: (e) => { if (e.target === e.currentTarget) setTeamModalOpen(false) },
      },
      h('form', {
        onSubmit: handleCreateTeam,
        style: Object.assign({}, S.card, {
          width: '100%',
          maxWidth: 560,
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
        }),
      },
      h('h2', { style: { margin: 0, fontSize: 17.5, fontWeight: 700 } }, '👥 组建 Super Agent 协同组 (Router + Multi-Worker)'),
      h('div', { style: { fontSize: 12.5, opacity: 0.75, lineHeight: '18px' } },
        '由单一主控 Router 承接目标，在 Qoder Cloud 沙箱内并行派生多个隔离上下文的专业子 Bot 线程并汇总成果。',
      ),
      h('input', {
        type: 'text',
        value: teamName,
        onChange: e => setTeamName(e.target.value),
        placeholder: '协同组名称，例如 dsh-super-squad',
        style: S.input,
      }),
      h('input', {
        type: 'text',
        value: teamDesc,
        onChange: e => setTeamDesc(e.target.value),
        placeholder: '职责说明（可选）…',
        style: S.input,
      }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        bots.filter(b => !b.isTeam).map(b => {
          const on = teamMembers.includes(b.id)
          return h('button', {
            key: b.id,
            type: 'button',
            onClick: () => setTeamMembers(prev => on ? prev.filter(x => x !== b.id) : prev.concat([b.id])),
            style: S.btnSecondary(on, false),
          }, (on ? '✓ ' : '+ ') + b.avatar + ' ' + b.name)
        }),
        templates.map(tpl => {
          const on = teamMembers.includes(tpl.id)
          return h('button', {
            key: 'tpl_' + tpl.id,
            type: 'button',
            onClick: () => setTeamMembers(prev => on ? prev.filter(x => x !== tpl.id) : prev.concat([tpl.id])),
            style: S.btnSecondary(on, false),
          }, (on ? '✓ ' : '+ ') + tpl.avatar + ' ' + tpl.id)
        }),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10 } },
        h('button', { type: 'button', onClick: () => setTeamModalOpen(false), style: S.btnSecondary(false, false) }, '取消'),
        h('button', { type: 'submit', disabled: creatingTeam, style: S.btnPrimary(creatingTeam) }, creatingTeam ? '组建中…' : '组建协同组'),
      ))),

      // =======================================================================
      // MODAL 3: Bot Settings & Reset Cloud Computer
      // =======================================================================
      editingBot && h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'rgba(15, 23, 42, 0.48)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        },
        onClick: (e) => { if (e.target === e.currentTarget) setEditingBot(null) },
      },
      h('div', {
        style: Object.assign({}, S.card, {
          width: '100%',
          maxWidth: 480,
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
        }),
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, '⚙️ ' + editingBot.avatar + ' ' + editingBot.name + ' · 云电脑设置'),
        h('button', { type: 'button', onClick: () => setEditingBot(null), style: S.btnSecondary(false, false) }, '关闭'),
      ),
      !editingBot.isTeam && h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('button', {
          type: 'button',
          style: S.btnSecondary(editingBot.approvalMode === 'gated', false),
          onClick: async () => {
            const nextMode = editingBot.approvalMode === 'gated' ? 'auto' : 'gated'
            const res = await apiAction('updateBot', { botId: editingBot.id, approvalMode: nextMode })
            setEditingBot(res.bot)
            notify('ok', '已切换人类审批门禁：' + (nextMode === 'gated' ? '🛡️ 敏感操作需审批' : '⚡ 全自主执行'))
            await loadDashboard(true)
          },
        }, editingBot.approvalMode === 'gated' ? '🛡️ 审批门禁：开启' : '⚡ 审批门禁：全自主'),
        h('button', {
          type: 'button',
          style: S.btnSecondary(editingBot.browserEnabled, false),
          onClick: async () => {
            const res = await apiAction('updateBot', { botId: editingBot.id, browserEnabled: !editingBot.browserEnabled })
            setEditingBot(res.bot)
            notify('ok', '已更新 Cloud Chrome 开关')
            await loadDashboard(true)
          },
        }, editingBot.browserEnabled ? '🌐 Cloud Chrome：已开启' : '🌐 Cloud Chrome：已关闭'),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10, paddingTop: 10, borderTop: '1px solid rgba(128,138,158,0.18)' } },
        h('button', {
          type: 'button',
          style: S.btnSecondary(false, false),
          onClick: async () => {
            try {
              const res = await apiAction('openBotComputer', { botId: editingBot.id, reset: true })
              setEditingBot(res.bot)
              notify('ok', '🔄 已重置为全新云电脑沙箱实例，长期记忆库完整保留！')
              await Promise.all([loadDashboard(true), pollWorkspace()])
            } catch (err) {
              notify('err', String(err.message || err))
            }
          },
        }, '🔄 重置云电脑（保留记忆）'),
        h('button', {
          type: 'button',
          style: S.btnDanger(false),
          onClick: async () => {
            await apiAction('archiveBot', { botId: editingBot.id })
            setEditingBot(null)
            notify('ok', '已归档 Bot ' + editingBot.name)
            await loadDashboard(true)
          },
        }, '归档 Bot'),
      ))))
    }

    // =========================================================================
    // PLUGIN ENTRY: ONLY `sidebar.panellist` (`Bots`) + `main` (`BotsStudioApp`)
    // ZERO touch on `conversation.hero.options`, `sidebarRightTabs`, or `uiWorkspace`!
    // =========================================================================
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }))
        const tBound = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, BotsStudioApp))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          locale: NS,
          label: () => tBound('navLabel'),
        }, BotsNavIcon))
      },
    }
  },
})
