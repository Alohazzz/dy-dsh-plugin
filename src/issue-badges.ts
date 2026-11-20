export type BadgeTone = 'grey' | 'blue' | 'green' | 'orange' | 'red' | 'purple'

export const issueCategories: Record<string, { label: string; tone: BadgeTone }> = {
  Req: { label: '需求', tone: 'blue' },
  Bug: { label: '缺陷', tone: 'red' },
  Task: { label: '任务', tone: 'purple' },
}

export function issueCategory(category: string) {
  return Object.hasOwn(issueCategories, category) ? issueCategories[category] : undefined
}

const issueStatusTones: Record<string, BadgeTone> = {
  待处理: 'orange', 待确认: 'orange', 待开发: 'orange', 待测试: 'orange', 待发布: 'orange', 触发重置: 'orange',
  已确认: 'blue', 开发中: 'blue', 测试中: 'blue', 发布中: 'blue',
  开发完成: 'green', 测试完成: 'green', 验收完成: 'green', 发布完成: 'green', 已完成: 'green', 已解决: 'green',
  测试打回: 'red', 已退回: 'red',
}

export function issueStatusTone(name: string): BadgeTone {
  return Object.hasOwn(issueStatusTones, name) ? issueStatusTones[name] : 'grey'
}
