export type SkillSourceInput = {
  kind: 'local' | 'git'
  name: string
  location: string
  branch?: string
}

export type CatalogSkill = {
  sourceId: string
  path: string
  name: string
  description: string
  version?: string
  missing: string[]
  markdown: string
  files: string[]
  readAt: string
  commit?: string
  stale?: boolean
  digest?: string
}

export type SkillTarget = { kind: 'project' | 'agent'; id: string; name: string }
export const dshSkillTarget = { kind: 'agent', id: '.dsh', name: '.dsh Agent' } as const satisfies SkillTarget
export type SkillInstallation = {
  id: string
  target: SkillTarget
  sourceId: string
  sourceName: string
  path: string
  name: string
  commit?: string
  readAt: string
  broken?: boolean
}

export type SkillSource = SkillSourceInput & {
  id: string
  skills: CatalogSkill[]
  readAt: string
  actualBranch?: string
  commit?: string
  error?: string
  problems: { path: string; error: string }[]
  removed: string[]
}
