// Test-only routes backed by the real DSH services in an isolated profile.
export const name = 'skill-distribution-fixture'
export const inject = ['connection', 'workspaceRegistry', 'sessionController', 'agents', 'skills', 'agentPresets', 'sessionSkillCatalog']

export function apply(ctx) {
  ctx.connection.fetch.register({
    path: '/api/skill-distribution-fixture', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json()
        if (input.setup) {
          const project = await ctx.workspaceRegistry.create(input.setup.project, '验收项目')
          const other = await ctx.workspaceRegistry.create(input.setup.other, '其他项目')
          const sessions = []
          for (const [index, workspaceId] of [project.id, project.id, other.id].entries()) {
            const { sessionId } = await ctx.sessionController.create({ workspaceId, agentPreset: 'standard' })
            await ctx.sessionController.rename({ sessionId, title: '分发验收 Agent ' + (index + 1) })
            sessions.push(sessionId)
          }
          return Response.json({ project: project.id, other: other.id, sessions })
        }
        const { agent } = await ctx.sessionController.resolveAgent(input.session)
        if (!agent) throw new Error('Agent unavailable')
        const registry = ctx.agentPresets.serviceFor(agent, 'skills') ?? ctx.skills
        const options = { cwd: input.cwd, scope: agent }
        const summary = await ctx.sessionSkillCatalog.list({ sessionId: input.session }, AbortSignal.timeout(10_000))
        const loaded = await registry.get(input.name, options)
        return Response.json({ catalog: summary.skills.some(skill => skill.name === input.name),
          content: loaded?.content, directory: loaded?.resourceBase?.path })
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 })
      }
    },
  })
}
