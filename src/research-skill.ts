import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const source = readFileSync(new URL('../skills/yunxiao-dsh-research/SKILL.md', import.meta.url), 'utf8').trim()
const sections = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]+)$/.exec(source)
if (!sections) throw new Error('调研技能缺少元数据')
const { name, description } = parse(sections[1])

export const researchSkill = {
  name: String(name), description: String(description), source: 'runtime',
  invocation: { userInvocable: true, modelInvocable: false },
  content: sections[2].trim(),
}
