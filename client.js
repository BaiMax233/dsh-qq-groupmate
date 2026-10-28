// QQ 群友 · 设置页（DSH 客户端半）
//
// 纯 JS，由宿主模块加载器直接取用；React 来自浏览器模块表，不重复安装。
window.__ModuleLoader__.load({
  id: '@local/qq-groupmate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const C = {
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    const card = {
      background: C.layer,
      border: '1px solid ' + C.border,
      borderRadius: 12,
      padding: 18,
      marginBottom: 16,
    }
    const label = { display: 'block', fontSize: 12, color: C.muted, marginBottom: 6 }
    const hint = { fontSize: 12, color: C.muted, marginTop: 6 }
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid ' + C.border2,
      background: C.layer2,
      color: C.text,
      font: 'inherit',
      outline: 'none',
    }
    const chip = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 999,
      background: C.layer2, border: '1px solid ' + C.border2, fontSize: 13,
    }
    const button = (primary, disabled) => ({
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid ' + (primary ? 'transparent' : C.border2),
      background: primary ? C.brand : 'transparent',
      color: primary ? '#fff' : C.text,
      font: 'inherit',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    })

    function draftFrom(state) {
      const p = (state && state.persona) || {}
      const b = (state && state.behavior) || {}
      return {
        persona: {
          name: p.name || '',
          bio: p.bio || '',
          interests: Array.isArray(p.interests) ? p.interests.slice() : [],
          speech: p.speech || '',
          flare: p.flare || '',
          flareRate: typeof p.flareRate === 'number' ? p.flareRate : 0.2,
        },
        groups: Array.isArray(state && state.groups) ? state.groups.slice() : [],
        maxPerHour: typeof b.maxPerHour === 'number' ? b.maxPerHour : 8,
        unlimited: b.unlimited === true,
      }
    }

    function clock(at) {
      const d = new Date(at)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    function Dot(props) {
      return h('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: 4,
          background: props.color, marginRight: 6, verticalAlign: 'middle',
        },
      })
    }

    function Page() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(() => draftFrom(null))
      const [dirty, setDirty] = useState(false)
      const [error, setError] = useState('')
      const [status, setStatus] = useState('')
      const [saving, setSaving] = useState(false)
      const [previewing, setPreviewing] = useState(false)
      const [preview, setPreview] = useState(null)
      const [forceFlare, setForceFlare] = useState(false)
      const [showBehavior, setShowBehavior] = useState(false)
      const [interestDraft, setInterestDraft] = useState('')
      const [groupDraft, setGroupDraft] = useState('')
      const dirtyRef = useRef(false)
      const mounted = useRef(true)

      const load = useCallback(async () => {
        try {
          const res = await fetch('/qq/state', { credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          if (!mounted.current) return
          setState(data)
          setError('')
          if (!dirtyRef.current) setDraft(draftFrom(data))
        } catch (e) {
          if (mounted.current) setError(String(e && e.message ? e.message : e))
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        load()
        const timer = setInterval(load, 5000)
        return () => {
          mounted.current = false
          clearInterval(timer)
        }
      }, [load])

      function touch() {
        dirtyRef.current = true
        setDirty(true)
        setStatus('')
      }

      function editPersona(field, value) {
        setDraft(d => ({ ...d, persona: { ...d.persona, [field]: value } }))
        touch()
      }

      function addInterest() {
        const value = interestDraft.trim()
        if (!value) return
        if (!draft.persona.interests.includes(value)) {
          setDraft(d => ({ ...d, persona: { ...d.persona, interests: d.persona.interests.concat([value]).slice(0, 12) } }))
          touch()
        }
        setInterestDraft('')
      }

      function removeInterest(value) {
        setDraft(d => ({ ...d, persona: { ...d.persona, interests: d.persona.interests.filter(x => x !== value) } }))
        touch()
      }

      function addGroup() {
        const value = groupDraft.trim()
        if (!/^\d{5,12}$/.test(value)) {
          setStatus('群号应该是 5–12 位数字')
          return
        }
        if (draft.groups.includes(value)) {
          setGroupDraft('')
          return
        }
        setDraft(d => ({ ...d, groups: d.groups.concat([value]) }))
        setGroupDraft('')
        touch()
      }

      function removeGroup(value) {
        setDraft(d => ({ ...d, groups: d.groups.filter(x => x !== value) }))
        touch()
      }

      async function save() {
        setSaving(true)
        setStatus('')
        try {
          const res = await fetch('/qq/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              persona: draft.persona,
              groups: draft.groups,
              rate: { maxPerHour: draft.maxPerHour, unlimited: draft.unlimited },
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
          dirtyRef.current = false
          setDirty(false)
          setStatus('已保存，插件正在重载')
          setTimeout(load, 1200)
        } catch (e) {
          setStatus('保存失败：' + (e && e.message ? e.message : e))
        } finally {
          setSaving(false)
        }
      }

      async function trySpeak() {
        setPreviewing(true)
        setPreview(null)
        try {
          const res = await fetch('/qq/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ persona: draft.persona, flare: forceFlare }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
          setPreview(Array.isArray(data.messages) ? data.messages : [])
        } catch (e) {
          setPreview([])
          setStatus('试说失败：' + (e && e.message ? e.message : e))
        } finally {
          setPreviewing(false)
        }
      }

      const stats = (state && state.stats) || { received: 0, evaluated: 0, spoken: 0, skipped: 0 }
      const connected = !!(state && state.connected)
      const behavior = (state && state.behavior) || {}
      const decisions = (state && state.decisions) || []
      const reasons = (state && state.reasons) || {}
      const throttle = (state && state.throttle) || {}
      const throttled = Object.keys(throttle)
        .map(groupId => ({ groupId, info: throttle[groupId] }))
        .filter(item => item.info && !item.info.ok)

      return h('div', { style: { maxWidth: 840, margin: '0 auto', padding: '8px 4px 40px', color: C.text, font: 'inherit' } },

        // 状态条
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 18 } },
          h('span', { style: { display: 'flex', alignItems: 'center', fontSize: 13 } },
            h(Dot, { color: connected ? C.ok : C.err }),
            connected ? '已连接 NapCat' : '未连接',
          ),
          h('span', { style: { fontSize: 13, color: C.muted } }, '今日 发言 ' + stats.spoken + ' / 评估 ' + stats.evaluated),
          h('div', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 12, color: C.muted } }, error ? '读取失败：' + error : ''),
        ),

        // 被限流时要说清楚，否则用户只会觉得「它不回我了」
        throttled.length === 0 ? null : h('div', {
          style: {
            marginBottom: 16, padding: '10px 14px', borderRadius: 10,
            background: C.layer2, border: '1px solid ' + C.warn,
            fontSize: 13, lineHeight: 1.7,
          },
        },
          h('div', { style: { color: C.warn, fontWeight: 600, marginBottom: 2 } }, '当前被限流，除了 @ 都不说话'),
          throttled.map(item => h('div', { key: item.groupId, style: { color: C.muted } },
            '群 ' + item.groupId + '：' + (item.info.reason || '限流中')
              + '（本小时已发 ' + item.info.sentLastHour + ' 条）')),
        ),

        // 群聊
        h('div', { style: card },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '群聊'),
          h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 12 } },
            '只在这些群里活动。留空表示哪个群都不参与。每个群有独立的记忆。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
            draft.groups.map(value => h('span', { key: value, style: chip },
              value,
              h('span', {
                style: { cursor: 'pointer', color: C.muted, lineHeight: 1 },
                onClick: () => removeGroup(value),
              }, '×'),
            )),
            h('input', {
              style: { ...input, width: 180, padding: '5px 10px' },
              placeholder: '群号，回车添加',
              value: groupDraft,
              onChange: e => setGroupDraft(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addGroup() } },
            }),
          ),
        ),

        // 人设
        h('div', { style: card },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 14 } }, '人设'),
          h('div', { style: { marginBottom: 14 } },
            h('label', { style: label }, '名字'),
            h('input', {
              style: input, value: draft.persona.name, maxLength: 40,
              onChange: e => editPersona('name', e.target.value),
            }),
          ),
          h('div', { style: { marginBottom: 14 } },
            h('label', { style: label }, '背景'),
            h('textarea', {
              style: { ...input, minHeight: 96, resize: 'vertical', lineHeight: 1.6 },
              value: draft.persona.bio, maxLength: 600,
              onChange: e => editPersona('bio', e.target.value),
            }),
            h('div', { style: { fontSize: 11, color: C.muted, textAlign: 'right', marginTop: 4 } },
              draft.persona.bio.length + '/600'),
          ),
          h('div', { style: { marginBottom: 14 } },
            h('label', { style: label }, '兴趣'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
              draft.persona.interests.map(value => h('span', { key: value, style: chip },
                value,
                h('span', {
                  style: { cursor: 'pointer', color: C.muted, lineHeight: 1 },
                  onClick: () => removeInterest(value),
                }, '×'),
              )),
              h('input', {
                style: { ...input, width: 140, padding: '5px 10px' },
                placeholder: '输入后回车',
                value: interestDraft,
                onChange: e => setInterestDraft(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addInterest() } },
              }),
            ),
          ),
          h('div', {},
            h('label', { style: label }, '语气'),
            h('input', {
              style: input, value: draft.persona.speech, maxLength: 200,
              onChange: e => editPersona('speech', e.target.value),
            }),
          ),
          h('div', { style: { marginTop: 18, paddingTop: 16, borderTop: '1px solid ' + C.border } },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '偶尔发作（可选）'),
            h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.6 } },
              '平时正常说话，偶尔突然换成这一套腔调。发作与否由插件掷骰子决定，模型自己不会掌握节奏。'),
            h('textarea', {
              style: { ...input, minHeight: 110, resize: 'vertical', lineHeight: 1.6 },
              placeholder: '写几句这种腔调的示例，比如：\n放肆！区区萤火之光，也敢与日月争辉？\n哼，本座今日便勉为其难，与你等凡人共膳。',
              value: draft.persona.flare,
              maxLength: 1200,
              onChange: e => editPersona('flare', e.target.value),
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 13, color: C.muted } }, '发作概率'),
              h('input', {
                type: 'number', min: 0, max: 1, step: 0.05,
                style: { ...input, width: 90, padding: '6px 10px' },
                value: draft.persona.flareRate,
                disabled: (draft.persona.flare || '').trim() === '',
                onChange: e => {
                  const next = Number(e.target.value)
                  editPersona('flareRate', Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0.2)
                },
              }),
              h('span', { style: { fontSize: 12, color: C.muted } },
                '0.2 ≈ 五次开口发作一次；留空示例则永不发作'),
            ),
          ),
        ),

        // 试说
        h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 12 } },
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, '试一句'),
            h('div', { style: { flex: 1 } }),
            (draft.persona.flare || '').trim() === ''
              ? null
              : h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginRight: 12, cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: forceFlare,
                    onChange: e => setForceFlare(e.target.checked),
                  }),
                  '强制发作',
                ),
            h('button', { style: button(false, previewing), disabled: previewing, onClick: trySpeak },
              previewing ? '正在想…' : '让它试说一句'),
          ),
          h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 10 } },
            '用当前草稿生成，不发群、不落库。'),
          preview === null
            ? h('div', { style: { fontSize: 13, color: C.muted } }, '点上面的按钮看看它现在会怎么说话。')
            : preview.length === 0
              ? h('div', { style: { fontSize: 13, color: C.muted } }, '它这一轮决定不说。')
              : preview.map((text, index) => h('div', {
                  key: index,
                  style: {
                    display: 'inline-block', maxWidth: '80%', marginRight: 8, marginBottom: 8,
                    padding: '8px 12px', borderRadius: 10,
                    background: C.layer2, border: '1px solid ' + C.border2, fontSize: 13,
                  },
                }, text)),
        ),

        // 发言配额
        h('div', { style: card },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 12 } }, '发言配额'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, color: C.muted } }, '每个群每小时最多'),
            h('input', {
              type: 'number', min: 1, max: 240,
              style: { ...input, width: 90, padding: '6px 10px' },
              value: draft.maxPerHour,
              disabled: draft.unlimited,
              onChange: e => {
                const next = Number(e.target.value)
                setDraft(d => ({ ...d, maxPerHour: Number.isFinite(next) ? next : d.maxPerHour }))
                touch()
              },
            }),
            h('span', { style: { fontSize: 13, color: C.muted } }, '条'),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.unlimited,
                onChange: e => {
                  setDraft(d => ({ ...d, unlimited: e.target.checked }))
                  touch()
                },
              }),
              '不限制',
            ),
          ),
          h('div', { style: hint },
            draft.unlimited
              ? '不限条数，但仍然保留最小间隔，避免刷屏。被 @ 时永远不受限制。'
              : '超过上限后它只会回应 @，不再主动插话。被 @ 时永远不受限制。'),
        ),

        // 行为参数（只读）
        h('div', { style: card },
          h('div', {
            style: { display: 'flex', alignItems: 'center', cursor: 'pointer' },
            onClick: () => setShowBehavior(v => !v),
          },
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, '其它参数'),
            h('div', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 12, color: C.muted } }, showBehavior ? '收起' : '展开'),
          ),
          h('div', { style: { fontSize: 12, color: C.muted, marginTop: 6 } },
            '开口门槛 ' + behavior.threshold + ' · 冷却 ' + Math.round((behavior.minGapMs || 0) / 1000) + 's · 后端 ' + behavior.kind),
          showBehavior ? h('div', { style: { marginTop: 14, fontSize: 13, lineHeight: 2, color: C.muted } },
            h('div', {}, '攒够消息数：' + behavior.minMessages),
            h('div', {}, '静默时段：' + (behavior.quietHours || '无')),
            h('div', {}, '会话目录：' + behavior.cwd),
            h('div', {}, '收到 ' + stats.received + ' 条，评估 ' + stats.evaluated + ' 次，跳过 ' + stats.skipped + ' 次'),
            Object.keys(reasons).length > 0
              ? h('div', {}, '跳过原因：' + Object.keys(reasons).map(k => k + ' × ' + reasons[k]).join('，'))
              : null,
            h('div', { style: { marginTop: 8, fontSize: 12 } },
              '这些值要改，编辑 cordis.patch.yml 里 qq-groupmate 的 config（改完热重载生效）。'),
          ) : null,
        ),

        // 决策记录
        h('div', { style: card },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '最近的判断'),
          h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 12 } },
            '本次进程内的记录；完整历史在 ' + (behavior.cwd || '会话目录') + '\\decisions.jsonl'),
          decisions.length === 0
            ? h('div', { style: { fontSize: 13, color: C.muted } }, '还没有记录。等群里来条消息。')
            : decisions.slice().reverse().map((item, index) => h('div', {
                key: index,
                style: {
                  display: 'flex', gap: 10, alignItems: 'baseline',
                  padding: '8px 0',
                  borderTop: index === 0 ? 'none' : '1px solid ' + C.border,
                },
              },
                h('span', { style: { fontSize: 12, color: C.muted, width: 40, flexShrink: 0 } }, clock(item.at)),
                h('span', {
                  style: {
                    fontSize: 11, padding: '2px 8px', borderRadius: 999, flexShrink: 0,
                    background: item.participate ? C.ok : C.layer2,
                    color: item.participate ? '#fff' : C.muted,
                    border: item.participate ? 'none' : '1px solid ' + C.border2,
                  },
                }, item.participate ? '开口' : '沉默'),
                h('div', { style: { minWidth: 0, flex: 1 } },
                  h('div', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    item.preview || '（无内容）'),
                  h('div', { style: { fontSize: 12, color: C.muted, marginTop: 2 } },
                    item.reason + (item.error ? ' · ' + item.error : '') +
                    (item.texts && item.texts.length ? ' · 「' + item.texts.join('」「') + '」' : '') +
                    (item.latencyMs ? ' · ' + item.latencyMs + 'ms' : '')),
                ),
              )),
        ),

        // 底部动作
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { fontSize: 12, color: dirty ? C.warn : C.muted } },
            status || (dirty ? '有未保存的修改' : '')),
          h('div', { style: { flex: 1 } }),
          h('button', {
            style: button(false, !dirty || saving),
            disabled: !dirty || saving,
            onClick: () => { dirtyRef.current = false; setDirty(false); setDraft(draftFrom(state)) },
          }, '还原'),
          h('button', {
            style: button(true, !dirty || saving),
            disabled: !dirty || saving,
            onClick: save,
          }, saving ? '保存中…' : '保存生效'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qq-groupmate',
          label: 'QQ 群友',
          order: 60,
        }, Page))
      },
    }
  },
})
