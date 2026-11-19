export type Option = { id: string; name: string }
export type IssueKey = { project: string; id: string }
export type Issue = IssueKey & {
  reference: string; title: string; category: string; state: Option; owner: string
  product: string; priority: string; created: string; deadline: string; url: string; plan?: string; planId?: string; sessionId?: string
}
export type Details = Issue & {
  body: ({ text: string } | { file: number })[]
  text: string; materialsError?: string; files: { name: string; url: string; image: boolean }[]
  pendingTarget?: string; preparedSessionId?: string
}
export type Search = {
  project: string; category: string; query: string; mine: boolean; status: string[]
  version: string[]; from: string; to: string; page: number; workspaceId: string
}
export type Meta = {
  organization?: string; defaultProject?: string; user?: string; setupError?: string
  projects: Option[]; workspaces: Option[]; presets: Option[]; permissions: Option[]
}
export type MrRef = { repositoryId: number; localId: number }
export type PlanDelivery = { key: string; repositoryId: number; path: string; target: string; mr?: MrRef }
export type PlanKind = 'feature' | 'fix' | 'patch' | 'project' | 'hotfix'
export type Plan = {
  id: string; name: string; branch: string; end: string; members: string[]; repositoryKey?: string; delivery?: PlanDelivery
  kind?: PlanKind; version?: string; baseBranch?: string; targetBranch?: string; worktree?: string
}
export type PlanCreate = Pick<Plan, 'name' | 'branch' | 'end'> & {
  kind: PlanKind; version: string; baseBranch: string; targetBranch: string; useExistingRemote: boolean; worktreeDir?: string
}
export type PlanBranchCheck = { localExists: boolean; remoteExists: boolean }
export type PlanKey = { project: string; workspaceId: string; planId: string }
export type PlanRow = PlanKey & { plan: Plan; projectName: string; workspaceName: string; mrStatus?: string }
export type PlanIssue = Pick<Issue, 'id' | 'reference' | 'title' | 'owner' | 'state' | 'url'> & { error?: string }
export type MrCandidate = { localId: number; title: string; target: string; url: string }
export type PlanDetails = { plan: Plan; issues: PlanIssue[]; mrStatus?: string; candidates: MrCandidate[]; mrError?: string }
export type Preview = { code: string; sections: string[]; receipts: ({ id: string; time: string } | null)[]; error?: string }
export type PlanResult = { id: string; result: string; error?: string; retryable?: boolean }

export type ConnectionSettings = { hasToken: boolean; source: 'saved' | 'env' | 'none'; organization: string; project: string }
