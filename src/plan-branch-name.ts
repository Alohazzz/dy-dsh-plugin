import type { PlanKind } from './contracts.ts'

export const planKinds = {
  feature: '日常开发', fix: '缺陷修复', patch: '现场响应', project: '上线验收', hotfix: '补丁',
} satisfies Record<PlanKind, string>

function slug(value: string) {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/\.{2,}/g, '.').replace(/^[-_.]+|[-_.]+$/g, '').replace(/\.lock$/, '')
}

export function planBranchName(kind: PlanKind, version: string, target: string, name: string) {
  const versionSegment = slug(version)
  const description = Array.from(slug(name)).slice(0, 48).join('').replace(/[.]$|\.lock$/g, '')
  return [kind, /^v[0-9]/.test(versionSegment) ? versionSegment : '', slug(target), description || 'batch']
    .filter(Boolean).join('/')
}
