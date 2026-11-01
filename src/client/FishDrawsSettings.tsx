import { useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input, SegmentedTabs, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigValues, DiagnosticModelRouteConfig, ModelProfileConfig } from '../config.js'
import type { ModelCandidates, SettingsOverview } from '../settings-remote/types.js'
import { cloneConfig, type Drafts, type SettingsTab, useConfigSnapshot } from './state.js'
import { validateComfyDraft, validateProfiles } from './validation.js'
const styles = { root: 'fd-root', tabs: 'fd-tabs', panel: 'fd-panel', grid: 'fd-grid', field: 'fd-field', fieldWide: 'fd-field-wide', actions: 'fd-actions', status: 'fd-status' } as const
const STYLE = `.fd-root{display:grid;gap:16px;max-width:920px;padding:4px 2px 28px}.fd-tabs{max-width:680px}.fd-panel{display:grid;gap:14px}.fd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fd-field{display:grid;gap:6px;font-size:13px}.fd-field-wide{grid-column:1/-1}.fd-actions{display:flex;flex-wrap:wrap;gap:8px}.fd-status{padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle);border-radius:10px;white-space:pre-wrap}@media(max-width:760px){.fd-grid{grid-template-columns:1fr}}`
const openStreams = new Set<{ dispose(): void }>()
export function disposeClientStreams(): void { for (const stream of openStreams) stream.dispose(); openStreams.clear() }

export interface FishDrawsSettingsProps { ctx: Context; form: ConfigForm<ConfigValues>; close: () => void }

export function FishDrawsSettings({ ctx, form }: FishDrawsSettingsProps) {
  const snapshot = useConfigSnapshot(form); const [tab, setTab] = useState<SettingsTab>('comfy'); const [drafts, setDrafts] = useState<Drafts>({})
  const [message, setMessage] = useState(''); const [overview, setOverview] = useState<SettingsOverview>(); const [candidates, setCandidates] = useState<ModelCandidates>()
  const base = snapshot.value
  useEffect(() => { void ctx.remote.fishDrawsSettings.overview().then(result => { if (result.ok) setOverview(result.value) }) }, [ctx])
  const draft = drafts[tab] ?? cloneConfig(base)
  const text = (ctx.locale.getSnapshot().active.toLowerCase().startsWith('zh')) ? { comfy: 'ComfyUI', models: '生图模型', strata: 'DSH 与 Strata', diagnostics: '诊断', save: '保存', reset: '恢复默认值' } : { comfy: 'ComfyUI', models: 'Image model', strata: 'DSH & Strata', diagnostics: 'Diagnostics', save: 'Save', reset: 'Restore defaults' }
  const items = useMemo(() => ([
    { value: 'comfy' as const, label: text.comfy, id: 'fd-comfy-tab', panelId: 'fd-comfy-panel' },
    { value: 'models' as const, label: text.models, id: 'fd-models-tab', panelId: 'fd-models-panel' },
    { value: 'strata' as const, label: text.strata, id: 'fd-strata-tab', panelId: 'fd-strata-panel' },
    { value: 'diagnostics' as const, label: text.diagnostics, id: 'fd-diagnostics-tab', panelId: 'fd-diagnostics-panel' },
  ] as const), [text.comfy, text.diagnostics, text.models, text.strata])
  if (snapshot.status !== 'ready' || draft === undefined) return <div className={styles.root}>Loading fish-draws settings…</div>
  const readyDraft = draft

  function update(next: ConfigValues): void { setDrafts(current => ({ ...current, [tab]: next })) }
  async function save(keys: string[]): Promise<void> {
    const issues = tab === 'comfy' ? validateComfyDraft(readyDraft) : tab === 'models' ? validateProfiles(readyDraft.modelProfiles ?? [], readyDraft.currentModelProfileId ?? '') : []
    if (issues.length > 0) { setMessage(issues.map(value => `${value.field}: ${value.message}`).join('\n')); return }
    let valueToSave = readyDraft; let keysToSave = keys
    if (tab === 'models') {
      const legacyMirrorHash = await sha256(JSON.stringify({ models: readyDraft.models ?? {}, safety: readyDraft.safety ?? {} }))
      valueToSave = { ...readyDraft, migration: { ...(readyDraft.migration ?? {}), legacyMirrorHash } }
      keysToSave = [...keys, 'migration']; setDrafts(current => ({ ...current, models: valueToSave }))
    }
    const ops = keysToSave.map(key => ({ op: 'set' as const, path: [key], value: (valueToSave as Record<string, any>)[key] }))
    try { const ok = await form.mutate(ops as any, snapshot.revision); setMessage(ok ? 'Saved. New values apply to the next preflight or diagnostic.' : 'Settings changed elsewhere. The latest values were loaded; review this draft before saving again.') } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  function reset(): void { setDrafts(current => ({ ...current, [tab]: cloneConfig(base) })) }

  return <div className={styles.root}><style>{STYLE}</style>
    <SegmentedTabs items={items} value={tab} onChange={setTab} label="fish-draws settings" className={styles.tabs} />
    {tab === 'comfy' && <ComfyPanel ctx={ctx} draft={draft} update={update} setMessage={setMessage} />}
    {tab === 'models' && <ModelsPanel ctx={ctx} draft={draft} update={update} {...(candidates === undefined ? {} : { candidates })} setCandidates={setCandidates} setMessage={setMessage} />}
    {tab === 'strata' && <StrataPanel ctx={ctx} draft={draft} update={update} setMessage={setMessage} />}
    {tab === 'diagnostics' && <DiagnosticsPanel ctx={ctx} form={form} draft={draft} update={update} {...(overview === undefined ? {} : { overview })} setMessage={setMessage} />}
    <div className={styles.actions}><Button variant="primary" onClick={() => void save(tab === 'comfy' ? ['comfy', 'storage'] : tab === 'models' ? ['modelProfiles', 'currentModelProfileId', 'models', 'safety'] : tab === 'strata' ? ['strata', 'runtime'] : ['diagnostics'])} disabled={!snapshot.writable}>{text.save}</Button><Button variant="outline" onClick={reset}>{text.reset}</Button></div>
    {message !== '' && <div className={styles.status} role="status">{message}</div>}
  </div>
}

function ComfyPanel({ ctx, draft, update, setMessage }: PanelProps) {
  const comfy = draft.comfy ?? {}; const storage = draft.storage ?? {}
  const t = localized(ctx)
  const set = (patch: Partial<typeof comfy>) => update({ ...draft, comfy: { ...comfy, ...patch } })
  return <section className={styles.panel} id="fd-comfy-panel"><div className={styles.grid}>
    <Field label={t('ComfyUI root', 'ComfyUI 根目录')} wide><Input value={comfy.root ?? ''} onChange={event => set({ root: event.target.value })} /></Field>
    <Field label={t('Python path (blank = auto)', 'Python 路径（留空自动发现）')} wide><Input value={comfy.pythonPath ?? ''} onChange={event => set({ pythonPath: event.target.value })} /></Field>
    <Field label="API URL"><Input value={comfy.apiUrl ?? ''} onChange={event => set({ apiUrl: event.target.value })} /></Field>
    <Field label={t('Auto start', '自动启动')}><Switch checked={comfy.autoStart ?? true} onChange={value => set({ autoStart: value })} label={t('Auto start ComfyUI', '自动启动 ComfyUI')} /></Field>
    <Field label={t('Idle shutdown (ms)', '空闲关闭时间（毫秒）')}><Input type="number" value={comfy.idleShutdownMs ?? 600000} onChange={event => set({ idleShutdownMs: Number(event.target.value) })} /></Field>
    <Field label={t('Startup timeout (ms)', '启动超时（毫秒）')}><Input type="number" value={comfy.startupTimeoutMs ?? 180000} onChange={event => set({ startupTimeoutMs: Number(event.target.value) })} /></Field>
    <Field label={t('Output root', '输出根目录')} wide><Input value={storage.outputRoot ?? ''} onChange={event => update({ ...draft, storage: { ...storage, outputRoot: event.target.value } })} /></Field>
  </div><div className={styles.actions}><Button onClick={() => void call(ctx.remote.fishDrawsSettings.probeComfy(), setMessage)}>{t('Check connection', '检查连接')}</Button><Button onClick={() => void call(ctx.remote.fishDrawsSettings.startComfyForTest(), setMessage)}>{t('Test start', '测试启动')}</Button><Button variant="outline" onClick={() => void prepareStop(ctx, setMessage)}>{t('Stop plugin-owned ComfyUI', '停止插件启动的 ComfyUI')}</Button></div></section>
}

function ModelsPanel({ ctx, draft, update, candidates, setCandidates, setMessage }: PanelProps & { candidates?: ModelCandidates; setCandidates: (value: ModelCandidates) => void }) {
  const profiles = draft.modelProfiles ?? []; const currentId = draft.currentModelProfileId ?? ''
  const t = localized(ctx)
  const [selectedId, setSelectedId] = useState(currentId); const selected = profiles.find(value => value.id === selectedId) ?? profiles[0]
  function replace(profile: ModelProfileConfig): void {
    const next: ConfigValues = { ...draft, modelProfiles: profiles.map(value => value.id === profile.id ? profile : value) }
    if (profile.id === currentId) Object.assign(next, { models: { ...profile.files }, safety: { t2iBalanced: profile.safety.t2iBalanced, editSingleBalanced: profile.safety.editSingleBalanced, editMultiBalanced: profile.safety.editMultiBalanced, fastBatch: profile.safety.fastBatch } })
    update(next)
  }
  function add(copy = false): void {
    const source = copy && selected !== undefined ? selected : conservativeProfile(); const id = `profile-${crypto.randomUUID().slice(0, 8)}`
    const { validation: _validation, ...withoutValidation } = structuredClone(source)
    const next: ModelProfileConfig = { ...withoutValidation, id, name: copy ? `${source.name} copy` : 'New model profile' }
    update({ ...draft, modelProfiles: [...profiles, next] }); setSelectedId(id)
  }
  function makeCurrent(): void { if (selected === undefined) return; update({ ...draft, currentModelProfileId: selected.id, models: { ...selected.files }, safety: { t2iBalanced: selected.safety.t2iBalanced, editSingleBalanced: selected.safety.editSingleBalanced, editMultiBalanced: selected.safety.editMultiBalanced, fastBatch: selected.safety.fastBatch } }) }
  function removeSelected(): void { if (selected === undefined || selected.id === currentId) { setMessage('Switch to another current profile before deleting this profile.'); return }; const next = profiles.filter(value => value.id !== selected.id); update({ ...draft, modelProfiles: next }); setSelectedId(currentId) }
  return <section className={styles.panel} id="fd-models-panel"><div className={styles.actions}><select value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.id === currentId ? t(' (current)', '（当前）') : ''}</option>)}</select><Button onClick={makeCurrent} disabled={selected === undefined || selected.id === currentId}>{t('Set current', '设为当前')}</Button><Button onClick={() => add(false)}>{t('New', '新建')}</Button><Button onClick={() => add(true)} disabled={selected === undefined}>{t('Copy', '复制')}</Button><Button onClick={removeSelected} disabled={selected === undefined || selected.id === currentId || profiles.length < 2}>{t('Delete', '删除')}</Button></div>
  {selected !== undefined && <><div className={styles.grid}><Field label={t('Name', '名称')} wide><Input value={selected.name} onChange={event => replace({ ...selected, name: event.target.value })} /></Field><Field label="UNet"><Input list="fd-unets" value={selected.files.unetName} onChange={event => replace(withoutProfileValidation(selected, { files: { ...selected.files, unetName: event.target.value } }))} /></Field><Field label="CLIP"><Input list="fd-clips" value={selected.files.clipName} onChange={event => replace(withoutProfileValidation(selected, { files: { ...selected.files, clipName: event.target.value } }))} /></Field><Field label="VAE"><Input list="fd-vaes" value={selected.files.vaeName} onChange={event => replace(withoutProfileValidation(selected, { files: { ...selected.files, vaeName: event.target.value } }))} /></Field><Field label={t('Workflow version', '工作流版本')}><Input value={selected.workflowCompatibility.workflowVersion} onChange={event => replace(withoutProfileValidation(selected, { workflowCompatibility: { ...selected.workflowCompatibility, workflowVersion: event.target.value } }))} /></Field><Field label={t('Workflow SHA-256 (optional)', '工作流 SHA-256（可选）')}><Input value={selected.workflowCompatibility.workflowSha256 ?? ''} onChange={event => replace(withoutProfileValidation(selected, { workflowCompatibility: { workflowVersion: selected.workflowCompatibility.workflowVersion, ...(event.target.value === '' ? {} : { workflowSha256: event.target.value }) } }))} /></Field><Field label={t('Notes', '备注')} wide><Input value={selected.notes ?? ''} onChange={event => replace({ ...selected, notes: event.target.value })} /></Field></div><SafetyEditors profile={selected} replace={replace} chinese={isChinese(ctx)} /><div className={styles.status}>{t('Validation', '验证状态')}: {selected.validation?.status ?? 'unverified'}{selected.validation?.checkedAtUtc === undefined ? '' : ` · ${selected.validation.checkedAtUtc}`}</div></>}
  <datalist id="fd-unets">{candidates?.unet.map(value => <option key={value} value={value} />)}</datalist><datalist id="fd-clips">{candidates?.clip.map(value => <option key={value} value={value} />)}</datalist><datalist id="fd-vaes">{candidates?.vae.map(value => <option key={value} value={value} />)}</datalist>
  <div className={styles.actions}><Button onClick={() => void ctx.remote.fishDrawsSettings.discoverModelCandidates().then(result => { if (result.ok) { setCandidates(result.value); setMessage(t('Model candidates loaded from the fixed workflow loaders.', '已从固定工作流加载器读取模型候选。')) } else setMessage(result.error.message) })}>{t('Discover candidates', '发现模型候选')}</Button>{selected !== undefined && <Button onClick={() => void call(ctx.remote.fishDrawsSettings.probeModelProfile({ profileId: selected.id }), setMessage)}>{t('Probe profile', '检查档案')}</Button>}</div></section>
}

function SafetyEditors({ profile, replace, chinese }: { profile: ModelProfileConfig; replace: (value: ModelProfileConfig) => void; chinese: boolean }) {
  const t = (english: string, translated: string) => chinese ? translated : english
  const rows: Array<[keyof ModelProfileConfig['safety'], string]> = [['t2iBalanced', 'T2I Balanced'], ['editSingleBalanced', t('Single edit Balanced', '单图编辑 Balanced')], ['editMultiBalanced', t('Multi edit Balanced', '多图编辑 Balanced')], ['fastBatch', t('Fast batch', 'Fast 批量')]]
  return <div className={styles.panel}>{rows.map(([key, label]) => {
    const value = profile.safety[key]
    const patch = (next: Partial<typeof value>) => replace(withoutProfileValidation(profile, { safety: { ...profile.safety, [key]: { ...value, ...next, approvalSource: 'user_override' } } }))
    return <fieldset key={key}><legend>{label}</legend><div className={styles.grid}><Field label={t('Max width', '最大宽度')}><Input type="number" value={value.maxSampleWidth ?? 2048} onChange={event => patch({ maxSampleWidth: Number(event.target.value) })} /></Field><Field label={t('Max height', '最大高度')}><Input type="number" value={value.maxSampleHeight ?? 2048} onChange={event => patch({ maxSampleHeight: Number(event.target.value) })} /></Field><Field label={t('Max sample pixels', '最大采样像素数')}><Input type="number" value={value.maxSamplePixels ?? 2400000} onChange={event => patch({ maxSamplePixels: Number(event.target.value) })} /></Field><Field label={t('Reserve MiB', '释放显存 MiB')}><Input type="number" value={value.reserveMiB ?? 21504} onChange={event => patch({ reserveMiB: Number(event.target.value) })} /></Field></div></fieldset>
  })}</div>
}

function StrataPanel({ ctx, draft, update, setMessage }: PanelProps) {
  const strata = draft.strata ?? {}; const [credentialStatus, setCredentialStatus] = useState('Not checked')
  const t = localized(ctx)
  const set = (patch: Partial<typeof strata>) => update({ ...draft, strata: { ...strata, ...patch } })
  async function inspectCredential(): Promise<void> {
    const ref = strata.credentialRef?.trim() ?? ''
    if (ref === '') { setCredentialStatus('No credential reference configured.'); return }
    const result = await ctx.remote.credentials.describe([ref])
    if (!result.ok) { setCredentialStatus(result.error.message); return }
    const info = result.value[ref]; setCredentialStatus(info === undefined ? 'Unavailable' : `configured=${info.configured}; source=${info.source ?? 'none'}; writable=${info.writable}`)
  }
  return <section className={styles.panel} id="fd-strata-panel"><div className={styles.grid}><Field label={t('VRAM handoff', '显存交接')}><Switch checked={strata.handoffEnabled ?? true} onChange={value => set({ handoffEnabled: value })} label={t('Enable Strata VRAM handoff', '启用 Strata 显存交接')} /></Field><Field label={t('Authentication', '认证方式')}><select value={strata.authMode ?? 'bearer'} onChange={event => set({ authMode: event.target.value as 'none' | 'bearer' })}><option value="none">{t('None (loopback only)', '无（仅限本机回环）')}</option><option value="bearer">Bearer credential</option></select></Field><Field label={t('Strata endpoint', 'Strata 接口')} wide><Input value={strata.vramEndpoint ?? ''} onChange={event => set({ vramEndpoint: event.target.value })} /></Field><Field label={t('Credential reference', '凭据引用')} wide><Input value={strata.credentialRef ?? ''} onChange={event => set({ credentialRef: event.target.value })} /></Field></div><div className={styles.status}>{credentialStatus}</div><div className={styles.actions}><Button onClick={() => void call(ctx.remote.fishDrawsSettings.probeStrata(), setMessage)}>{t('Test Strata', '测试 Strata')}</Button><Button onClick={() => void inspectCredential()}>{t('Check credential status', '检查凭据状态')}</Button><Button onClick={() => void setCredential(ctx, strata.credentialRef ?? '', setMessage)}>{t('Set credential', '设置凭据')}</Button><Button variant="outline" onClick={() => void unsetCredential(ctx, strata.credentialRef ?? '', setMessage)}>{t('Delete credential', '删除凭据')}</Button></div><p>{t('Secrets are written one-way through DSH credentials and are never displayed. The deprecated prompt-expansion endpoint is intentionally hidden.', '密钥仅单向写入 DSH credentials，永不回显。已废弃的提示词扩写接口已隐藏。')}</p></section>
}

function DiagnosticsPanel({ ctx, form, draft, update, overview, setMessage }: { ctx: Context; form: ConfigForm<ConfigValues>; draft: ConfigValues; update: (value: ConfigValues) => void; overview?: SettingsOverview; setMessage: (value: string) => void }) {
  const routes = draft.diagnostics?.localModelRoutes ?? []; const profiles = draft.modelProfiles ?? []
  const eligibleRoutes = routes.filter(route => route.status !== 'unavailable')
  const [catalogRoutes, setCatalogRoutes] = useState<Array<{ provider: string; model: string; name: string; reasoningEffort?: string }>>([])
  const [catalogChoice, setCatalogChoice] = useState(''); const [routeChoice, setRouteChoice] = useState(''); const [profileChoice, setProfileChoice] = useState(draft.currentModelProfileId ?? '')
  const [activeRun, setActiveRun] = useState<{ runId: string; sessionId: string }>()
  const reopenedRuns = useRef(new Set<string>()); const t = localized(ctx)
  useEffect(() => {
    const runId = overview?.activeDiagnosticRunId
    if (runId === undefined || activeRun !== undefined) return
    void ctx.remote.fishDrawsSettings.diagnosticStatus({ runId }).then(result => {
      if (!result.ok || !['prepared', 'running', 'cancelling'].includes(result.value.status)) return
      const value = { runId, sessionId: result.value.sessionId }; setActiveRun(value)
      void followDiagnostic(ctx, runId, value.sessionId, setMessage, terminal => { setActiveRun(undefined); if (terminal !== undefined) void persistDiagnosticVerification(ctx, form, terminal, setMessage) })
    })
  }, [activeRun, ctx, overview?.activeDiagnosticRunId, setMessage])
  useEffect(() => {
    const runId = overview?.lastDiagnosticRunId
    if (runId === undefined || overview?.activeDiagnosticRunId === runId || reopenedRuns.current.has(runId)) return
    reopenedRuns.current.add(runId)
    void ctx.remote.fishDrawsSettings.diagnosticStatus({ runId }).then(result => {
      if (!result.ok || !['completed', 'warning'].includes(result.value.status)) return
      setMessage(JSON.stringify(result.value, null, 2)); void persistDiagnosticVerification(ctx, form, result.value, setMessage)
    })
  }, [ctx, form, overview?.activeDiagnosticRunId, overview?.lastDiagnosticRunId, setMessage])
  const setRoutes = (next: DiagnosticModelRouteConfig[]) => update({ ...draft, diagnostics: { ...(draft.diagnostics ?? {}), localModelRoutes: next } })
  async function loadCatalog(): Promise<void> {
    const result = await ctx.remote.session.modelCatalog()
    if (!result.ok) { setMessage(result.error.message); return }
    const values = result.value.groups.flatMap(group => group.models.flatMap(model => {
      const efforts = model.reasoning?.efforts ?? []
      return efforts.length === 0 ? [{ provider: group.id, model: model.id, name: `${group.name} / ${model.name}` }] : efforts.map(effort => ({ provider: group.id, model: model.id, name: `${group.name} / ${model.name} / ${effort.name}`, reasoningEffort: effort.id }))
    }))
    setCatalogRoutes(values); if (values[0] !== undefined) setCatalogChoice(routeKey(values[0]))
    const available = new Set(values.map(routeKey)); setRoutes(routes.map(route => available.has(routeKey(route)) ? (route.status === 'unavailable' ? { ...route, status: 'unverified' } : route) : { ...route, status: 'unavailable' }))
    setMessage(`Loaded ${values.length} routable model route(s). Catalog metadata does not prove that a route is local.`)
  }
  function addLocalRoute(): void {
    const selected = catalogRoutes.find(value => routeKey(value) === catalogChoice)
    if (selected === undefined) { setMessage('Choose a catalog route first.'); return }
    if (!window.confirm(`I confirm that ${selected.provider}/${selected.model} only accesses a model service on this computer.`)) return
    const next: DiagnosticModelRouteConfig = { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }), userConfirmedLocal: true, status: 'unverified' }
    if (routes.some(value => routeKey(value) === routeKey(next))) { setMessage('That exact route is already in the local diagnostic allowlist.'); return }
    setRoutes([...routes, next]); setRouteChoice(routeKey(next)); setMessage('Local declaration added to the draft. Save the Diagnostics page before running it.')
  }
  async function runDiagnostic(): Promise<void> {
    const route = eligibleRoutes.find(value => routeKey(value) === routeChoice) ?? eligibleRoutes[0]
    const profile = profiles.find(value => value.id === profileChoice) ?? profiles[0]
    if (route === undefined || profile === undefined) { setMessage('Save at least one confirmed local route and one model profile first.'); return }
    const created = await ctx.remote.session.create({})
    if (!created.ok) { setMessage(created.error.message); return }
    const selected = await ctx.remote.session.selectModel({ sessionId: created.value.sessionId, provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) })
    if (!selected.ok) { setMessage(selected.error.message); return }
    const runId = `diag-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
    const prepared = await ctx.remote.fishDrawsSettings.diagnosticPrepare({ runId, sessionId: created.value.sessionId, provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }), profileId: profile.id })
    if (!prepared.ok) { setMessage(prepared.error.message); return }
    setActiveRun({ runId, sessionId: created.value.sessionId })
    const prompted = await ctx.remote.session.prompt({ requestId: crypto.randomUUID() as any, sessionId: created.value.sessionId, mode: 'queue', content: [{ type: 'text', text: DIAGNOSTIC_PROMPT }] })
    if (!prompted.ok) { await ctx.remote.fishDrawsSettings.diagnosticCancel({ runId }); setMessage(prompted.error.message); return }
    setMessage(`Diagnostic ${runId} is running in isolated session ${created.value.sessionId}. Closing this page will not cancel it.`)
    void followDiagnostic(ctx, runId, created.value.sessionId, setMessage, terminal => { setActiveRun(undefined); if (terminal !== undefined) void persistDiagnosticVerification(ctx, form, terminal, setMessage) })
  }
  async function cancelDiagnostic(): Promise<void> {
    if (activeRun === undefined) return
    await ctx.remote.session.cancel({ sessionId: activeRun.sessionId as any }); const result = await ctx.remote.fishDrawsSettings.diagnosticCancel({ runId: activeRun.runId })
    setMessage(result.ok ? `Diagnostic ${activeRun.runId} is cancelling; resource cleanup continues before it settles.` : result.error.message)
  }
  return <section className={styles.panel} id="fd-diagnostics-panel"><div className={styles.status}>Plugin {overview?.pluginVersion ?? '…'} · ComfyUI {overview?.comfyOnline ? t('online', '在线') : t('offline', '离线')} · {overview?.comfyOwnership ?? '…'}{overview?.activeTaskId === undefined ? '' : ` · ${t('active task', '活动任务')} ${overview.activeTaskId}`}</div><p>{t('Only routes explicitly recorded as local are eligible. The diagnostic always uses fixed 1024×1024 Balanced, Count 1, 20 steps and never changes the normal current profile.', '只有经用户明确确认为本地的路由可用于诊断。诊断固定使用 1024×1024、Balanced、1 张、20 步，且不会改变正常任务的当前档案。')}</p>
    <div className={styles.grid}><Field label={t('Routable DSH model', '可路由的 DSH 模型')} wide><select value={catalogChoice} onChange={event => setCatalogChoice(event.target.value)}>{catalogRoutes.map(value => <option key={routeKey(value)} value={routeKey(value)}>{value.name}</option>)}</select></Field><Field label={t('Confirmed local route', '已确认的本地路由')}><select value={routeChoice} onChange={event => setRouteChoice(event.target.value)}>{eligibleRoutes.map(value => <option key={routeKey(value)} value={routeKey(value)}>{value.provider} / {value.model}{value.reasoningEffort === undefined ? '' : ` / ${value.reasoningEffort}`}</option>)}</select></Field><Field label={t('Image model profile', '生图模型档案')}><select value={profileChoice} onChange={event => setProfileChoice(event.target.value)}>{profiles.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field></div>
    <div className={styles.actions}><Button onClick={() => void loadCatalog()}>{t('Refresh model catalog', '刷新模型目录')}</Button><Button onClick={addLocalRoute} disabled={catalogRoutes.length === 0}>{t('Confirm selected route is local', '确认所选路由为本地')}</Button><Button variant="outline" onClick={() => { const selected = routes.find(value => routeKey(value) === routeChoice); if (selected !== undefined) setRoutes(routes.filter(value => routeKey(value) !== routeKey(selected))) }} disabled={routes.length === 0}>{t('Remove local route', '移除本地路由')}</Button></div>
    <div className={styles.actions}><Button onClick={() => void call(ctx.remote.fishDrawsSettings.diagnose(), setMessage)}>{t('Run read-only diagnosis', '运行只读诊断')}</Button><Button variant="primary" onClick={() => void runDiagnostic()} disabled={activeRun !== undefined || eligibleRoutes.length === 0 || profiles.length === 0}>{t('Run one fixed T2I diagnostic', '运行一次固定文生图诊断')}</Button><Button variant="outline" onClick={() => void cancelDiagnostic()} disabled={activeRun === undefined}>{t('Cancel diagnostic', '取消诊断')}</Button>{overview?.lastDiagnosticRunId !== undefined && <Button variant="outline" onClick={() => void call(ctx.remote.fishDrawsSettings.diagnosticDelete({ runId: overview.lastDiagnosticRunId! }), setMessage)}>{t('Delete latest diagnostic', '删除最近一次诊断')}</Button>}</div>
  </section>
}

interface PanelProps { ctx: Context; draft: ConfigValues; update: (value: ConfigValues) => void; setMessage: (value: string) => void }
function isChinese(ctx: Context): boolean { return ctx.locale.getSnapshot().active.toLowerCase().startsWith('zh') }
function localized(ctx: Context): (english: string, chinese: string) => string { return (english, chinese) => isChinese(ctx) ? chinese : english }
function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={`${styles.field} ${wide ? styles.fieldWide : ''}`}><span>{label}</span>{children}</label> }
async function call(promise: Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>, setMessage: (value: string) => void): Promise<void> { try { const result = await promise; setMessage(result.ok ? JSON.stringify(result.value, null, 2) : result.error?.message ?? 'Operation failed.') } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } }
async function prepareStop(ctx: Context, setMessage: (value: string) => void): Promise<void> { const prepared = await ctx.remote.fishDrawsSettings.prepareComfyStop(); if (!prepared.ok) { setMessage(prepared.error.message); return } if (!prepared.value.allowed || prepared.value.nonce === undefined) { setMessage(prepared.value.blockers.join('\n')); return } if (!window.confirm('Stop this plugin-owned ComfyUI instance? Models will be unloaded first.')) return; await call(ctx.remote.fishDrawsSettings.stopComfy({ nonce: prepared.value.nonce }), setMessage) }
async function setCredential(ctx: Context, ref: string, setMessage: (value: string) => void): Promise<void> { if (ref.trim() === '') { setMessage('Enter a credential reference first.'); return } const secret = window.prompt('Enter the Strata bearer secret. It will not be shown again.'); if (secret === null || secret === '') return; const result = await ctx.remote.credentials.set(ref, secret); setMessage(result.ok ? 'Credential stored.' : result.error.message) }
async function unsetCredential(ctx: Context, ref: string, setMessage: (value: string) => void): Promise<void> { if (ref.trim() === '' || !window.confirm(`Delete credential ${ref}?`)) return; const result = await ctx.remote.credentials.unset(ref); setMessage(result.ok ? 'Credential deleted.' : result.error.message) }
function conservativeProfile(): ModelProfileConfig { const safety = () => ({ maxSampleWidth: 2048, maxSampleHeight: 2048, maxSamplePixels: 2400000, reserveMiB: 21504, approvalSource: 'bundled' as const }); return { schemaVersion: 1, id: 'new', name: 'New model profile', files: { unetName: '', clipName: '', vaeName: '' }, workflowCompatibility: { workflowVersion: 'qwen-image-2.1-unified-v3' }, safety: { t2iBalanced: safety(), editSingleBalanced: safety(), editMultiBalanced: safety(), fastBatch: safety() } } }
function withoutProfileValidation(profile: ModelProfileConfig, patch: Partial<Omit<ModelProfileConfig, 'validation'>>): ModelProfileConfig { const { validation: _validation, ...base } = profile; return { ...base, ...patch } }

const DIAGNOSTIC_PROMPT = `Use the bundled fish-draws skill to run the settings diagnostic. Generate exactly one 1024×1024 T2I image with Balanced acceleration and exactly 20 steps. The image must show a blue circle and an orange square side by side on a simple light background, with crisp edges and no text. Do not perform quality rework. Use fish_draws_preflight, fish_draws_generate, the standard job wait flow, and fish_draws_result. Report the expanded prompt and final result.`

function routeKey(value: { provider: string; model: string; reasoningEffort?: string }): string { return `${value.provider}\u0000${value.model}\u0000${value.reasoningEffort ?? ''}` }

async function followDiagnostic(ctx: Context, runId: string, sessionId: string, setMessage: (value: string) => void, finished: (value?: import('../settings-remote/types.js').DiagnosticRunView) => void): Promise<void> {
  const stream = ctx.remote.session.follow({ address: { kind: 'session', sessionId: sessionId as any }, assistantStream: true, maxMessages: 20 })
  openStreams.add(stream)
  let terminal: import('../settings-remote/types.js').DiagnosticRunView | undefined
  try {
    for await (const _frame of stream) {
      const status = await ctx.remote.fishDrawsSettings.diagnosticStatus({ runId })
      if (!status.ok) { setMessage(status.error.message); break }
      if (['completed', 'warning', 'failed', 'cancelled'].includes(status.value.status)) {
        terminal = status.value; setMessage(JSON.stringify(status.value, null, 2)); break
      }
    }
  } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  finally { openStreams.delete(stream); stream.dispose(); finished(terminal) }
}

async function persistDiagnosticVerification(ctx: Context, form: ConfigForm<ConfigValues>, run: import('../settings-remote/types.js').DiagnosticRunView, setMessage: (value: string) => void): Promise<void> {
  if (!['completed', 'warning'].includes(run.status)) return
  const probe = await ctx.remote.fishDrawsSettings.probeModelProfile({ profileId: run.profileId })
  if (!probe.ok) { setMessage(`${JSON.stringify(run, null, 2)}\nProfile verification could not be saved: ${probe.error.message}`); return }
  if (probe.value.profileHash !== run.profileHash || !probe.value.workflowCompatible || probe.value.missingFiles.length > 0) { setMessage(`${JSON.stringify(run, null, 2)}\nThe saved model profile changed or is no longer compatible, so this diagnostic was not attached as its verification.`); return }
  const snapshot = form.getSnapshot(); if (snapshot.status !== 'ready' || snapshot.value === undefined) return
  const now = new Date().toISOString()
  const profiles = (snapshot.value.modelProfiles ?? []).map(profile => profile.id === run.profileId ? { ...profile, validation: { status: 'verified' as const, profileHash: probe.value.profileHash, workflowHash: probe.value.workflowHash, checkedAtUtc: now, diagnosticRunId: run.runId } } : profile)
  const routes = (snapshot.value.diagnostics?.localModelRoutes ?? []).map(route => routeKey(route) === routeKey(run.route) ? { ...route, status: 'verified' as const, lastVerifiedAtUtc: now } : route)
  const result = await form.mutate([
    { op: 'set', path: ['modelProfiles'], value: profiles },
    { op: 'set', path: ['diagnostics'], value: { ...(snapshot.value.diagnostics ?? {}), localModelRoutes: routes, lastRunId: run.runId } },
  ] as any, snapshot.revision)
  if (!result) setMessage(`${JSON.stringify(run, null, 2)}\nDiagnostic succeeded, but settings changed concurrently. Reopen the page before saving the verification badge.`)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
