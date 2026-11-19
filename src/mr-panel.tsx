import type * as ReactType from 'react'
import type { mrPreview, mrRepos, submitMr } from './merge-request.ts'
import type { MrRef, PlanDelivery, PlanKey } from './contracts.ts'

type Row = Awaited<ReturnType<typeof mrRepos>>[number]
type Preview = Awaited<ReturnType<typeof mrPreview>>
type Receipt = Awaited<ReturnType<typeof submitMr>>
type Draft = { title: string; description: string; target: string }
export type Rpc = <T>(method: string, input: object, signal?: AbortSignal) => Promise<T>
type PlanContext = PlanKey & { name: string; branch: string; delivery: PlanDelivery }
const message = (e: unknown) => e instanceof Error ? e.message : String(e)

function tracking(row: Row) {
  if (row.error) return row.error
  if (!row.sha) return '尚无提交'
  if (!row.branch) return '游离 HEAD'
  if (!row.upstream) return '未设置上游'
  if (row.upstreamGone) return '上游引用已失效'
  return [row.ahead && '领先 ' + row.ahead, row.behind && '落后 ' + row.behind].filter(Boolean).join(' · ') || '与上游同步'
}

export function createMrPanel(React: typeof ReactType, rpc: Rpc) {
  const { useEffect, useState } = React
  return function MrPanel({ workspaceId, close, plan, onLinked, onBusy }: {
    workspaceId: string; close(): void; plan?: PlanContext; onLinked?(ref: MrRef): void; onBusy?(value: boolean): void
  }) {
    const [rows, setRows] = useState<Row[]>()
    const [key, select] = useState(plan?.delivery.key || '')
    const [preview, setPreview] = useState<Preview>()
    const [drafts, setDrafts] = useState<Record<string, Draft>>({})
    const [receipt, setReceipt] = useState<Receipt>()
    const [error, setError] = useState('')
    const [revision, refresh] = useState(0)
    const [busy, setBusy] = useState(false)
    useEffect(() => {
      if (plan) return
      const abort = new AbortController()
      rpc<Row[]>('mrRepos', { workspaceId }, abort.signal).then(list => {
        if (abort.signal.aborted) return
        setRows(list)
        select(old => list.some(r => r.key === old) ? old : list[0]?.key || '')
      }).catch(e => { if (!abort.signal.aborted) setError(message(e)) })
      return () => abort.abort()
    }, [workspaceId, revision])
    useEffect(() => {
      if (!key) return
      const abort = new AbortController()
      rpc<Preview>('mrPreview', { workspaceId, key }, abort.signal).then(value => {
        if (abort.signal.aborted) return
        setPreview(value)
        setDrafts(old => {
          const prior = Object.hasOwn(old, key) ? old[key] : undefined
          return { ...old, [key]: {
            title: prior?.title ?? plan?.name ?? value.branch, description: prior?.description ?? '',
            target: plan?.delivery.target ?? (prior && value.targets.includes(prior.target) ? prior.target :
              value.targets.includes(value.repository.defaultBranch) ? value.repository.defaultBranch : ''),
          } }
        })
      }).catch(e => { if (!abort.signal.aborted) setError(message(e)) })
      return () => abort.abort()
    }, [workspaceId, key, revision])
    function reload() {
      setError(''); setReceipt(undefined); setPreview(undefined); refresh(n => n + 1)
    }
    function changeRepo(next: string) {
      if (next === key) return
      setPreview(undefined); setError(''); setReceipt(undefined); select(next)
    }
    const row = rows?.find(r => r.key === key)
    const draft = drafts[key]
    const existing = preview?.openMrs.find(mr => mr.target === draft?.target)
    const planMismatch = plan && preview && (preview.repository.id !== plan.delivery.repositoryId
      ? '仓库 origin 已变化，请返回计划重新配置。'
      : preview.branch !== plan.branch ? '请在所选仓库检出计划源分支「' + plan.branch + '」。'
        : !preview.targets.includes(plan.delivery.target) ? '目标分支已不存在，请返回计划重新配置。' : '')
    function edit(change: Partial<Draft>) {
      setDrafts(old => ({ ...old, [key]: { ...old[key], ...change } }))
    }
    async function submit(event: ReactType.FormEvent) {
      event.preventDefault()
      if (!preview || !draft || busy || planMismatch || existing) return
      setBusy(true); onBusy?.(true); setError('')
      try {
        const input = { workspaceId, key, ...draft, branch: preview.branch, sha: preview.sha,
          remoteSha: preview.remoteSha, repositoryId: preview.repository.id, needPush: preview.needPush }
        if (plan) {
          const ref = await rpc<MrRef>('submitPlanMr', { ...input, project: plan.project, planId: plan.planId })
          onLinked?.(ref)
        } else {
          setReceipt(await rpc<Receipt>('submitMr', input))
        }
      } catch (e) {
        setError(message(e)); setPreview(undefined); refresh(n => n + 1)
      } finally { setBusy(false); onBusy?.(false) }
    }
    return <section className="dy-yx-mr" aria-label="发起合并请求">
      <header><h2>发起合并请求</h2><div className="dy-yx-actions"><button disabled={busy} onClick={reload}>刷新仓库</button>
        <button disabled={busy} onClick={close}>{plan ? '返回计划' : '返回合并请求'}</button></div></header>
      <div className={plan ? undefined : 'dy-yx-mr-cols'}>{!plan && <section className="dy-yx-mr-nav" aria-label="工作区仓库">
        <h3>工作区仓库 <small>{rows?.length}</small></h3>
        <div className="dy-yx-mr-list">{rows?.map(r => <button type="button" className="dy-yx-mr-row" key={r.key}
          aria-pressed={key === r.key} disabled={busy} title={r.key + ' · ' + r.branch + ' · ' + tracking(r)}
          onClick={() => changeRepo(r.key)}>
          <span><strong>{r.name}</strong> <small>{r.key === '.' ? '主仓库' : '子仓库'}</small></span>
          <span className="dy-yx-mr-row-meta"><code>{r.branch || (r.sha ? '游离 HEAD' : '—')}</code>
            <small title="上次读取本地上游引用时的状态">{tracking(r)}</small></span>
          {r.key.includes('/') && <small className="dy-yx-mr-path">{r.key}</small>}
        </button>)}</div>
        {!rows && !error && '正在读取仓库…'}{rows?.length === 0 && '工作区没有已检出的 Git 仓库。'}
      </section>}<section className="dy-yx-mr-detail" aria-label="所选仓库">
        <h3>{plan?.name || row?.name || '仓库详情'}</h3>
        {plan && <p className="dy-yx-meta">{plan.delivery.path} · <code>{plan.branch}</code> → <code>{plan.delivery.target}</code></p>}
        {preview && <small className="dy-yx-mr-path">Codeup · {preview.repository.path}</small>}
        {error && <p role="alert" className="dy-yx-error">{error}</p>}
        {receipt ? <div role="status"><p>{receipt.existing ? '已有开放 MR' : '合并请求已创建'} · !{receipt.localId}</p>
          <p>{preview?.repository.path} · {preview?.branch} → {draft.target}</p>
          {receipt.url && <a href={receipt.url} target="_blank" rel="noreferrer">查看 MR !{receipt.localId}</a>}</div> :
          preview && draft ? <form onSubmit={submit}>
            {!plan && <div className="dy-yx-mr-route">
              <div><small>当前分支</small><code className="dy-yx-mr-source">{preview.branch || '游离 HEAD'}</code></div>
              <span aria-hidden="true" className="dy-yx-mr-arrow">→</span>
              <label>目标分支<select disabled={busy} value={draft.target} onChange={e => edit({ target: e.target.value })}>
                <option value="">{preview.targets.length ? '请选择目标分支' : '无可用目标分支'}</option>
                {preview.targets.map(t => <option key={t}>{t}</option>)}</select></label>
            </div>}
            {planMismatch && <p className="dy-yx-error" role="alert">{planMismatch}</p>}
            <div className="dy-yx-mr-checks">
              <span className="dy-yx-status" data-tone={preview.blocked || preview.needPush ? 'orange' : 'green'}>
                {preview.blocked || (!preview.remoteSha ? '首次推送' : preview.ahead ? '领先 ' + preview.ahead + ' 个提交' : '已同步')}</span>
              <small>{preview.dirty ? preview.dirty + ' 项未提交改动（仅推送 Git 提交）' : '工作目录干净'}</small>
              <details><summary>Git 详情</summary><div>上游分支　<code>{preview.upstream || '未设置'}</code></div>
                <div>当前提交　<code>{preview.sha || '无提交'}</code></div></details>
            </div>
            {preview.commits.length > 0 && <details className="dy-yx-mr-commits"><summary>{preview.remoteSha ? '待推送提交' : '源分支提交（相对远端默认分支）'} · 显示 {preview.commits.length} 条</summary>
              {preview.commits.map(c => <div key={c}><code>{c}</code></div>)}</details>}
            <label>合并请求标题<input disabled={busy} required maxLength={256} value={draft.title} onChange={e => edit({ title: e.target.value })}/></label>
            <label>描述（选填）<textarea disabled={busy} maxLength={10000} value={draft.description} onChange={e => edit({ description: e.target.value })}/></label>
            <div className="dy-yx-mr-footer">
              {!plan && <small>{preview.blocked || (!draft.target ? '请选择目标分支' : '本次仓库 · ' + row?.name)}</small>}
              {existing ? <span>{plan ? '已发现开放 MR，请返回计划关联。' : <>已有开放 MR · {existing.url ? <a href={existing.url} target="_blank" rel="noreferrer">查看 !{existing.localId}</a> : '!' + existing.localId}</>}</span>
                : <button className="dy-yx-primary" disabled={busy || !!preview.blocked || !!planMismatch || !draft.target || !draft.title.trim()}>
                  {busy ? '提交中…' : preview.needPush ? '推送并创建合并请求' : '创建合并请求'}</button>}</div>
          </form> : (plan || row) && !error && <p role="status">正在核对远端分支…</p>}
      </section></div></section>
  }
}
