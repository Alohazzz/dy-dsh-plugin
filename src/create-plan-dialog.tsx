import type * as ReactType from 'react'
import type { Meta, Option, Plan, PlanBranchCheck, PlanKind, PlanKey } from './contracts.ts'
import type { mrRepos } from './merge-request.ts'
import type { Rpc } from './mr-panel.tsx'
import { planBranchName, planKinds } from './plan-branch-name.ts'

type Scope = Omit<PlanKey, 'planId'>
type Repositories = { repositories: Awaited<ReturnType<typeof mrRepos>>; worktreeDir: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createPlanDialog(React: typeof ReactType, rpc: Rpc) {
  const { useEffect, useId, useRef, useState } = React
  return function CreatePlanDialog({ meta, scope, selectScope, close, saved }: {
    meta?: Meta; scope: Scope; selectScope?: boolean; close(): void; saved(plan: Plan, scope: Scope): void
  }) {
    const [project, setProject] = useState(scope.project || meta?.defaultProject || meta?.projects[0]?.id || '')
    const [workspaceId, setWorkspace] = useState(scope.workspaceId || meta?.workspaces[0]?.id || '')
    const [repositories, setRepositories] = useState<Repositories['repositories']>()
    const [repositoryKey, setRepository] = useState('')
    const [repositoryError, setRepositoryError] = useState('')
    const [revision, retry] = useState(0)
    const [name, setName] = useState('')
    const [kind, setKind] = useState<PlanKind>('feature')
    const [version, setVersion] = useState('')
    const [versions, setVersions] = useState<string[]>([])
    const [versionState, setVersionState] = useState<'loading' | 'ready' | 'failed'>('loading')
    const [baseBranch, setBaseBranch] = useState('')
    const [targetBranch, setTargetBranch] = useState('')
    const [manualBranch, setManualBranch] = useState<string>()
    const [useWorktree, setUseWorktree] = useState(false)
    const [worktreeDir, setWorktreeDir] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [checking, setChecking] = useState(false)
    const [check, setCheck] = useState<PlanBranchCheck>()
    const [useExistingRemote, setUseExistingRemote] = useState(false)
    const request = useRef<AbortController | null>(null)
    const dialog = useRef<HTMLDialogElement>(null)
    const id = useId()
    const branch = manualBranch ?? planBranchName(kind, version, targetBranch, name)
    const selectedRepository = repositories?.find(row => row.key === repositoryKey)

    useEffect(() => {
      const element = dialog.current!
      element.showModal()
      return () => { request.current?.abort(); element.close() }
    }, [])
    useEffect(() => {
      if (!workspaceId) return
      const abort = new AbortController()
      rpc<Repositories>('planRepositories', { workspaceId }, abort.signal).then(result => {
        if (abort.signal.aborted) return
        const first = result.repositories.find(row => !row.error) ?? result.repositories[0]
        setRepositories(result.repositories); setRepository(first?.key ?? '')
        setBaseBranch(first?.branch ?? ''); setWorktreeDir(result.worktreeDir)
      }).catch(failure => { if (!abort.signal.aborted) setRepositoryError(message(failure)) })
      return () => abort.abort()
    }, [workspaceId, revision])
    useEffect(() => {
      if (!project) return
      const abort = new AbortController()
      rpc<Option[]>('planVersions', { project }, abort.signal).then(result => {
        if (abort.signal.aborted) return
        setVersions([...new Set(result.map(row => row.name.trim().replace(/\.0$/, '')).filter(Boolean))])
        setVersionState('ready')
      }).catch(() => { if (!abort.signal.aborted) setVersionState('failed') })
      return () => abort.abort()
    }, [project])

    function resetCheck() {
      request.current?.abort()
      setCheck(undefined); setChecking(false); setUseExistingRemote(false); setError('')
    }
    function editBranch(edit: () => void) {
      resetCheck()
      edit()
    }
    async function checkBranch() {
      resetCheck()
      const abort = new AbortController()
      request.current = abort
      setChecking(true)
      try {
        const result = await rpc<PlanBranchCheck>('checkPlanBranch', { workspaceId, repositoryKey, branch }, abort.signal)
        if (!abort.signal.aborted) setCheck(result)
      } catch (failure) {
        if (!abort.signal.aborted) setError(message(failure))
      } finally {
        if (!abort.signal.aborted) setChecking(false)
      }
    }
    const canSubmit = project && selectedRepository?.sha && !selectedRepository.error && name.trim() &&
      branch.trim() && baseBranch.trim() && (!useWorktree || worktreeDir.trim()) &&
      !check?.localExists && (!check?.remoteExists || useExistingRemote)

    async function submit(event: ReactType.FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (busy || checking || !canSubmit) return
      const end = new FormData(event.currentTarget).get('end')
      setBusy(true); setError('')
      try {
        const plan = await rpc<Plan>('createPlan', {
          project, workspaceId, repositoryKey, name, kind, version, branch, baseBranch, targetBranch, end,
          useExistingRemote, ...(useWorktree ? { worktreeDir } : {}),
        })
        close()
        saved(plan, { project, workspaceId })
      } catch (failure) { setError(message(failure)) }
      finally { setBusy(false) }
    }
    return <dialog ref={dialog} className="dy-yx dy-yx-dialog dy-yx-plan-create" aria-labelledby={id}
      onCancel={event => { event.preventDefault(); if (!busy) close() }}>
      <form onSubmit={submit}>
        <h2 id={id}>创建计划</h2>
        <fieldset disabled={busy}>
          {selectScope ? <>
            <label>云效项目<select value={project} onChange={event => {
              setProject(event.target.value); setVersions([]); setVersionState('loading')
            }}>{meta?.projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            <label>目标工作区<select value={workspaceId} onChange={event => {
              resetCheck(); setWorkspace(event.target.value)
              setRepositories(undefined); setRepository(''); setRepositoryError(''); setBaseBranch('')
            }}>{meta?.workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          </> : <p>目标工作区 · {meta?.workspaces.find(row => row.id === workspaceId)?.name}</p>}
          {Boolean(repositories?.length) && <label>目标仓库<select value={repositoryKey} onChange={event => {
            resetCheck(); setRepository(event.target.value)
            setBaseBranch(repositories?.find(row => row.key === event.target.value)?.branch ?? '')
          }}>{repositories?.map(row => <option key={row.key} value={row.key}>
            {row.name} · {row.key === '.' ? '根仓库' : row.key}
          </option>)}</select></label>}
          {!repositories && !repositoryError && workspaceId && <p role="status">正在读取工作区仓库…</p>}
          {repositories?.length === 0 && <p role="alert">目标工作区没有 Git 仓库。</p>}
          {repositoryError && <p role="alert">{repositoryError} <button type="button" onClick={() => {
            setRepositoryError(''); retry(value => value + 1)
          }}>重试</button></p>}
          {selectedRepository && (selectedRepository.error || !selectedRepository.sha) &&
            <p role="alert">{selectedRepository.error || '目标仓库尚无提交。'}</p>}
          <label>计划名称<input value={name} required maxLength={100} onChange={event => editBranch(() => {
            setName(event.target.value); setManualBranch(undefined)
          })} /></label>
          <fieldset className="dy-yx-plan-kinds"><legend>类型</legend><div>
            {Object.entries(planKinds).map(([key, label]) => <button key={key} type="button" aria-pressed={kind === key}
              onClick={() => editBranch(() => setKind(key as PlanKind))}>{key} · {label}</button>)}
          </div></fieldset>
          <label htmlFor={id + '-version'}>版本（可从云效选择或手输）</label>
          <div className="dy-yx-plan-field">
            <input id={id + '-version'} value={version} placeholder="如 v2.20260901，留空省略版本段"
              onChange={event => editBranch(() => setVersion(event.target.value))} />
            <select aria-label="选择云效版本" value="" disabled={!versions.length} onChange={event => editBranch(() => setVersion(event.target.value))}>
              <option value="">{versions.length ? '选择版本' : versionState === 'loading' ? '读取版本中…' :
                versionState === 'failed' ? '版本读取失败' : '暂无云效版本'}</option>
              {versions.map(value => <option key={value}>{value}</option>)}
            </select>
          </div>
          <label htmlFor={id + '-branch'}>源分支（自动生成，可手改）</label>
          <div className="dy-yx-plan-field">
            <input id={id + '-branch'} value={branch} required spellCheck={false}
              onChange={event => editBranch(() => setManualBranch(event.target.value))} />
            <button type="button" disabled={!selectedRepository?.sha || !branch.trim() || checking} onClick={() => void checkBranch()}>
              {checking ? '检测中…' : '检测'}
            </button>
          </div>
          {check && (check.localExists ? <p role="alert" className="dy-yx-error">本地已存在同名分支，请改名。</p> :
            check.remoteExists && !useExistingRemote ? <div className="dy-yx-plan-conflict">
              <p role="alert">远端已存在同名分支。</p>
              <button type="button" onClick={() => setUseExistingRemote(true)}>继续使用远端分支</button>
              <button type="button" onClick={() => editBranch(() => setManualBranch(branch.trim() + '-new'))}>改名</button>
            </div> : <p role="status">{useExistingRemote ? '将从同名远端分支创建本地跟踪分支。' : '本地和 origin 均无同名分支。'}</p>)}
          <label>基础分支（默认当前分支，可手改）<input value={baseBranch} required spellCheck={false}
            onChange={event => setBaseBranch(event.target.value)} /></label>
          <label>合并回目标分支（可留空）<input value={targetBranch} placeholder="例如 develop" spellCheck={false}
            onChange={event => editBranch(() => setTargetBranch(event.target.value))} /></label>
          <label>计划完成时间（必填，创建后不可改）<input type="date" name="end" required /></label>
          <label className="dy-yx-plan-worktree"><input type="checkbox" checked={useWorktree}
            onChange={event => setUseWorktree(event.target.checked)} />另建 worktree（并行隔离用）</label>
          {useWorktree ? <label>代码目录（在此目录下创建计划检出）<input value={worktreeDir} required spellCheck={false}
            onChange={event => setWorktreeDir(event.target.value)} /></label> : <small>计划分支直接切在主工作区</small>}
        </fieldset>
        {error && <p role="alert" className="dy-yx-error">{error}</p>}
        <div className="dy-yx-actions">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button type="submit" className="dy-yx-primary" disabled={busy || checking || !canSubmit}>
            {busy ? '创建中…' : useWorktree ? '创建计划 + 分支 + worktree' : '创建计划 + 分支'}
          </button>
        </div>
      </form>
    </dialog>
  }
}
