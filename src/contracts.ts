export type Option = { id: string; name: string }
export type IssueKey = { project: string; id: string }
export type Issue = IssueKey & {
  reference: string; title: string; category: string; state: Option; owner: string
  product: string; priority: string; created: string; deadline: string; url: string; plan?: string; sessionId?: string
}
export type Details = Issue & {
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
export type Plan = { id: string; name: string; branch: string; end: string; members: string[] }
export type Preview = { code: string; sections: string[]; receipts: ({ id: string; time: string } | null)[]; error?: string }
export type PlanResult = { id: string; result: string; error?: string; retryable?: boolean }

export type ConnectionSettings = { hasToken: boolean; source: 'saved' | 'env' | 'none'; organization: string; project: string }
