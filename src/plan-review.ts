import { sectionName } from './markdown-format.mjs'
import { lexer } from 'marked'
import type { ResearchRow } from './research-prototype.ts'

// Split on actual Markdown headings so headings inside code examples remain in the body.
export function documentSections(markdown: string, depth: number) {
  const sections = new Map<string, string>()
  let heading: string | undefined
  for (const token of lexer(markdown)) {
    if (token.type === 'heading' && token.depth <= depth) {
      heading = token.depth === depth ? sectionName(token.text) : undefined
      if (heading) sections.set(heading, '')
    } else if (heading) sections.set(heading, sections.get(heading) + token.raw)
  }
  for (const [name, body] of sections) sections.set(name, body.trim())
  return sections
}

export function reviewVersion(round: number, proposal?: number) {
  return '第 ' + round + ' 轮调研' + (proposal ? ' · 执行方案 v' + proposal : '')
}

export function reviewChanges(row: ResearchRow) {
  const draft = row.drafts.at(-1)!
  const earlier = row.drafts.slice(0, -1)
  const body = (item: typeof draft) => draft.proposal ? item.proposal : draft.report ? item.report : item.markdown
  const previous = earlier.findLast(item => body(item))
  const before = documentSections(previous && body(previous) || '', 2)
  const after = documentSections(body(draft) || '', 2)
  const changes = previous ? [...new Set([...after.keys(), ...before.keys()])]
    .filter(name => before.get(name) !== after.get(name))
    .map(name => ({ name, before: before.get(name), after: after.get(name) })) : []
  const previousDecisions = earlier.at(-1)?.decisions ?? []
  return { previous, changes, decisions: draft.decisions?.filter(text => !previousDecisions.includes(text)) ?? [] }
}

export function sharedAcceptance(rows: ResearchRow[], issueId: string, approvedOnly = false) {
  const target = rows.find(row => row.issueId === issueId)
  const result: { source: string; related: string; version: string; approved: boolean; body: string }[] = []
  if (!target?.reference) return result
  // Prefer the approved source when both issues quote the same scenario.
  const isApproved = (row: ResearchRow) => row.finalizedVersion === row.drafts.length && row.status !== 'running'
  for (const row of rows.toSorted((a, b) => Number(isApproved(b)) - Number(isApproved(a)))) {
    const draft = row.drafts.at(-1)
    const approved = isApproved(row)
    if (!row.reference || !draft?.proposal || (approvedOnly && !approved)) continue
    const acceptance = documentSections(draft.proposal, 2).get('验收与回归')
    if (!acceptance) continue
    for (const [name, body] of documentSections(acceptance, 3)) {
      if (!/^组合验收\s*·\s*/.test(name) || !body) continue
      const related = name.replace(/^组合验收\s*·\s*/, '').trim()
      if (related === row.reference || !rows.some(peer => peer.reference === related)) continue
      if (row.issueId !== issueId && related !== target.reference) continue
      if (result.some(item => item.body === body && [item.source, item.related].includes(related) &&
        [item.source, item.related].includes(row.reference!))) continue
      result.push({ source: row.reference, related, approved, version: reviewVersion(row.drafts.length, draft.proposalVersion), body })
    }
  }
  return result
}
