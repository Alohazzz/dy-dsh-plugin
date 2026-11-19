// Throwaway prototype. Compare three split layouts in the DSH workbench with the same sample catalog.
import type * as ReactType from 'react'

const skills = [
  ['answer-me-with-html', '把复杂说明整理成可交互的单页 HTML。', '当静态文字难以说明流程、比较选项或解释因果关系时，用一个网页把内容展开。先写 Markdown 草稿，再生成可直接在浏览器打开的 HTML。', ['SKILL.md', 'scripts/render.mjs', 'templates/default.html']],
  ['ant-design-ui-workflow', '为现有 Blazor 页面设计原型。', '根据现有页面、业务行为与项目主题安排导航、列表和详情。复用已有组件，对照 WinForms 保留完整操作，再通过原型确认布局。', ['SKILL.md', 'references/layout-rules.md']],
  ['archify', '根据代码库生成架构图与流程图。', '先确认图的受众与边界，阅读相关代码和架构记录，然后生成可以独立打开的交互式架构图。', ['SKILL.md', 'scripts/render.mjs']],
  ['batch-grill-me', '分轮确认设计决策。', '汇总本轮可以回答的设计问题，为每个问题给出推荐答案，确认之后再进入下一轮。', ['SKILL.md']],
  ['blazor-ui', '按任务选择 Blazor UI 设计或实施流程。', '先识别任务是已有页面优化、原型还是实施，再按照相应流程读取基线和验证界面。', ['SKILL.md']],
  ['blazor-ui-implementation', '在真实入口落地并验证已确认设计。', '沿用宿主的组件、主题和状态样式，核对受影响的动作与返回路径。', ['SKILL.md', 'references/verification.md']],
  ['blazor-ui-update', '检查并更新 Blazor UI 技能组。', '对照 SkillHub 的版本记录，核对文件完整性与各技能之间的引用。', ['SKILL.md']],
] as const
const sources = ['公司 SkillHub', '本地开发']
const targets = ['项目 · HIS', '项目 · 研发工作台', '.dsh Agent']
const variants = [
  ['catalog', '目录在左 · 详情在右'],
  ['sources', '来源在左 · 目录在右'],
  ['reading', '正文在左 · 索引在右'],
] as const

export function createSkillPanel(React: typeof ReactType) {
  return function SkillPanelPrototype() {
    const { useEffect, useState } = React
    const [variant, setVariant] = useState(() => {
      const key = new URLSearchParams(location.search).get('variant')
      return Math.max(0, variants.findIndex(([id]) => id === key))
    })
    const [source, setSource] = useState(0)
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState<string>(skills[0][0])
    const [detailTab, setDetailTab] = useState<'read' | 'files'>('read')
    const [openDetails, setOpenDetails] = useState(false)
    const [installed, setInstalled] = useState<Record<string, string[]>>({ '0:archify': [targets[0]] })
    const [operation, setOperation] = useState<{ kind: 'install' | 'remove'; key: string; name: string }>()
    const [target, setTarget] = useState('')
    const matches = (source === 0 ? skills : skills.slice(2, 5)).filter(([name, desc]) =>
      (name + ' ' + desc + ' ' + name + '/SKILL.md').toLowerCase().includes(query.trim().toLowerCase()))
    const skill = matches.find(item => item[0] === selected) ?? matches[0]

    function cycle(step: number) {
      setVariant(current => {
        const next = (current + step + variants.length) % variants.length
        const url = new URL(location.href)
        url.searchParams.set('variant', variants[next][0])
        history.replaceState(history.state, '', url)
        return next
      })
    }
    useEffect(() => {
      const arrows = (event: KeyboardEvent) => {
        if (event.target instanceof Element && event.target.closest('input, select, textarea, dialog, [contenteditable]')) return
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        cycle(event.key === 'ArrowRight' ? 1 : -1)
      }
      window.addEventListener('keydown', arrows)
      return () => window.removeEventListener('keydown', arrows)
    }, [])

    function pick(name: string) {
      setSelected(name)
      setDetailTab('read')
      setOpenDetails(true)
    }
    function changeSource(index: number) {
      setSource(index)
      setQuery('')
      setOpenDetails(false)
    }
    function confirmOperation(event: ReactType.FormEvent) {
      event.preventDefault()
      if (!operation || !target) return
      const { key, kind } = operation
      setInstalled(previous => {
        const current = previous[key] ?? []
        return { ...previous, [key]: kind === 'install' ? [...new Set([...current, target])] : current.filter(item => item !== target) }
      })
      setOperation(undefined)
    }
    const search = <input type="search" aria-label="搜索技能" placeholder="搜索技能名称、简介或路径"
      value={query} onChange={event => setQuery(event.target.value)} />
    const sourceSelect = <select aria-label="技能源" value={source} onChange={event => changeSource(Number(event.target.value))}>
      {sources.map((name, index) => <option key={name} value={index}>{name}</option>)}
    </select>
    const count = <small>{matches.length} 个技能</small>
    const metadata = <details className="sp-meta">
      <summary>来源信息</summary>
      <p>{source ? '本地目录 · D:/skills' : 'Git · master · 7a3d91c · 跟随默认分支'}</p>
      <p>上次读取 今天 10:43</p>
    </details>
    const empty = <p className="sp-empty">没有匹配的技能。</p>
    const list = (description: boolean) => matches.length ? <ul className="sp-list">
      {matches.map(([name, desc]) => <li key={name}>
        <button aria-current={name === skill?.[0] ? 'true' : undefined} onClick={() => pick(name)}>
          <strong>{name}</strong>{description && <small>{desc}</small>}
        </button>
      </li>)}
    </ul> : empty
    const files = (item: typeof skills[number]) => <ul className="sp-files">
      {item[3].map(file => <li key={file}><code>{file}</code></li>)}
    </ul>
    const article = (item: typeof skills[number]) => {
      const key = source + ':' + item[0]
      const current = installed[key] ?? []
      return <div className="sp-article">
      <div className="sp-detail-heading">
        <h2>{item[0]}</h2>
        <button className="dy-yx-primary" disabled={current.length === targets.length} onClick={() => {
          setTarget('')
          setOperation({ kind: 'install', key, name: item[0] })
        }}>安装到…</button>
      </div>
      <code className="sp-path">{item[0]}/SKILL.md</code>
      <p className="sp-intro">{item[1]}</p>
      <section className="sp-installations" aria-label="安装状态">
        <strong>{current.length ? '已安装到 ' + current.length + ' 个目标' : '未安装'}</strong>
        {!!current.length && <ul>{current.map(destination => <li key={destination}>
          <span>{destination}</span>
          <button aria-label={'从' + destination + '卸载'} onClick={() => {
            setTarget(destination)
            setOperation({ kind: 'remove', key, name: item[0] })
          }}>卸载</button>
        </li>)}</ul>}
      </section>
      <div className="sp-tabs" aria-label="技能详情">
        <button aria-pressed={detailTab === 'read'} onClick={() => setDetailTab('read')}>技能说明</button>
        <button aria-pressed={detailTab === 'files'} onClick={() => setDetailTab('files')}>配套文件（{item[3].length}）</button>
      </div>
      {detailTab === 'read' ? <p className="sp-body">{item[2]}</p> : files(item)}
      </div>
    }

    return <main className="dy-yx sp">
      <div className="sp-heading"><h2>技能管理</h2>{variant !== 1 && <div className="sp-actions">{sourceSelect}{metadata}</div>}</div>
      {variant === 0 && <div className={'sp-split sp-catalog' + (openDetails ? ' sp-picked' : '')}>
        <section className="sp-column sp-index" aria-label="技能目录">
          <div className="sp-index-heading">{search}{count}</div>
          <div className="sp-scroll">{list(true)}</div>
        </section>
        <section className="sp-scroll sp-reader" aria-label="技能详情" key={skill?.[0]}>
          <button className="sp-back" onClick={() => setOpenDetails(false)}>← 返回目录</button>
          {skill ? article(skill) : empty}
        </section>
      </div>}
      {variant === 1 && <div className="sp-split sp-sources">
        <section className="sp-column sp-index" aria-label="技能源">
          <div className="sp-index-heading"><strong>技能源</strong></div>
          <ul className="sp-list">{sources.map((name, index) => <li key={name}>
            <button aria-current={source === index ? 'true' : undefined} onClick={() => changeSource(index)}>
              <strong>{name}</strong><small>{index ? '本地目录' : 'Git · master'}</small>
            </button>
          </li>)}</ul>
          <div className="sp-index-heading">{metadata}</div>
        </section>
        <section className="sp-column sp-table" aria-label="技能目录">
          <div className="sp-index-heading">{search}{count}</div>
          <div className="sp-scroll">
            {matches.length ? matches.map(item => <div className="sp-table-row" key={item[0]}>
              <button aria-expanded={openDetails && skill?.[0] === item[0]} onClick={() => {
                if (openDetails && skill?.[0] === item[0]) setOpenDetails(false)
                else pick(item[0])
              }}><strong>{item[0]}</strong><small>{item[1]}</small><span aria-hidden="true">⌄</span></button>
              {openDetails && skill?.[0] === item[0] && <div className="sp-inline">{article(item)}</div>}
            </div>) : empty}
          </div>
        </section>
      </div>}
      {variant === 2 && <div className={'sp-split sp-reading' + (openDetails ? ' sp-picked' : '')}>
        <section className="sp-scroll sp-reader" aria-label="技能详情" key={skill?.[0]}>
          <button className="sp-back" onClick={() => setOpenDetails(false)}>← 返回索引</button>
          {skill ? article(skill) : empty}
        </section>
        <section className="sp-column sp-index" aria-label="技能索引">
          <div className="sp-index-heading">{search}{count}</div>
          <div className="sp-scroll">{list(false)}</div>
        </section>
      </div>}
      <div className="sp-switcher" aria-label="原型方案切换">
        <button aria-label="上一个布局" onClick={() => cycle(-1)}>←</button>
        <span aria-live="polite">原型 · {variants[variant][1]}</span>
        <button aria-label="下一个布局" onClick={() => cycle(1)}>→</button>
      </div>
      {operation && <dialog className="dy-yx dy-yx-dialog sp-operation" ref={element => {
        if (element && !element.open) element.showModal()
      }} aria-label={operation.kind === 'install' ? '安装技能' : '卸载技能'}
        onCancel={event => { event.preventDefault(); setOperation(undefined) }}>
        <form onSubmit={confirmOperation}>
          <h2>{operation.kind === 'install' ? '安装技能' : '卸载技能'}</h2>
          <p><strong>{operation.name}</strong></p>
          {operation.kind === 'install' ? <label>安装目标<select required value={target} onChange={event => setTarget(event.target.value)}>
            <option value="">选择项目或 Agent</option>
            {targets.map(destination => <option key={destination} disabled={installed[operation.key]?.includes(destination)}>
              {destination}
            </option>)}
          </select></label> : <p>从「{target}」卸载此技能？</p>}
          <div className="dy-yx-actions">
            <button type="button" onClick={() => setOperation(undefined)}>取消</button>
            <button disabled={!target} className={operation.kind === 'install' ? 'dy-yx-primary' : undefined}>
              {operation.kind === 'install' ? '确认安装' : '确认卸载'}
            </button>
          </div>
        </form>
      </dialog>}
    </main>
  }
}
