export type Option = { id: string; name: string }
export type IssueKey = { project: string; id: string }
export type Issue = IssueKey & {
  reference: string; title: string; category: string; state: Option; owner: string
  product: string; priority: string; created: string; deadline: string; url: string; plan?: string; planId?: string; sessionId?: string
}
export type Details = Issue & {
  body: ({ text: string } | { file: number })[]
  text: string; materialsError?: string; files: { name: string; url: string; image: boolean }[]
  pendingTarget?: string
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
export type MrAction = 'approve' | 'merge' | 'close'
export type MrMergeType = 'no-fast-forward' | 'squash' | 'rebase' | 'ff-only'
export type MrActionPreview = {
  scope: string; token: string; title: string; source: string; target: string; actor: string
  patch?: { version: number; sha: string }; fastForward: boolean
}
export type MrActionResult = { confirmed: boolean }
export type MrSnapshot = { id: string; source: string; target: string; version: number; directory: string }
export type MrPull = { id: string } & (
  { status: 'running' | 'cancelling' | 'saving' | 'cancelled' } | { status: 'failed'; error: string }
)
export type MrReviewSource = { id: string; label: string }
export type MrReviewComment = { token: string; footer: string; pending?: boolean; id?: string }
export const mrReviewCommentLimit = 65535
export type MrReviewView = {
  sources: MrReviewSource[]
  snapshot?: MrSnapshot
  pull?: MrPull
  review?: { status: 'running' | 'complete' | 'failed'; markdown?: string; error?: string }
  comment?: MrReviewComment
}
export type PlanDelivery = { key: string; repositoryId: number; path: string; target: string; mr?: MrRef }
export type PlanKind = 'feature' | 'fix' | 'patch' | 'project' | 'hotfix'
export type PlanHistory = {
  createdAt?: string; initialMembers?: string[]
  changes: { id: string; issueId: string; kind: 'initial' | 'added' | 'removed' | 'deferred'; at: string; reason: string }[]
}
export type Plan = {
  id: string; name: string; branch: string; end: string; members: string[]; repositoryKey?: string; delivery?: PlanDelivery
  kind?: PlanKind; version?: string; baseBranch?: string; targetBranch?: string; worktree?: string
  goal?: string; history?: PlanHistory; archiveError?: string; revision?: number
}
export type PlanCreate = Pick<Plan, 'name' | 'branch' | 'end' | 'goal'> & {
  kind: PlanKind; version: string; baseBranch: string; targetBranch: string; useExistingRemote: boolean; worktreeDir?: string
}
export type PlanBranchCheck = { localExists: boolean; remoteExists: boolean }
export type PlanKey = { project: string; workspaceId: string; planId: string }
export type PlanRow = PlanKey & { plan: Plan; projectName: string; workspaceName: string; mrStatus?: string }
export type PlanIssue = Pick<Issue, 'id' | 'reference' | 'title' | 'owner' | 'state' | 'url' | 'sessionId'> & {
  error?: string; executionVersion?: number; dispatchedVersion?: number; executionStage?: 'dispatched' | 'ready' | 'confirmed' | 'submitted' }
export type MrCandidate = { localId: number; title: string; target: string; url: string }
export type PlanDetails = { plan: Plan; issues: PlanIssue[]; mrStatus?: string; candidates: MrCandidate[]; mrError?: string;
  archiveError?: string; executionSupported?: boolean }
export type Preview = { code: string; sections: string[]; receipts: ({ id: string; time: string } | null)[];
  confirmed?: boolean; archivePending?: boolean; history?: { body: string; receipt: { id: string; time: string } }[]; error?: string }
export type PlanResult = { id: string; result: string; error?: string; retryable?: boolean }
export type IssueDocumentType = 'research' | 'proposal' | 'execution' | 'change' | 'publication' | 'completion'
export type IssueDocumentKey = { workspaceId: string; planId: string; type: IssueDocumentType; version: number }
export type IssueDocument = IssueDocumentKey & { workspaceName: string; planName: string; title: string; time: string }
export type IssueDocuments = { documents: IssueDocument[]; errors: string[] }
export type IssueDocumentBody = { format: 'markdown' | 'json'; body: string }

export type ConnectionSettings = { hasToken: boolean; source: 'saved' | 'env' | 'none'; organization: string; project: string }
