import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const directory = new URL('../skills/tech-doc-style-chinese/', import.meta.url)
const path = fileURLToPath(new URL('SKILL.md', directory))
const document = readFileSync(path, 'utf8').trim()
const parts = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]+)$/.exec(document)
if (!parts) throw new Error('中文技术写作技能缺少元数据')

const { name, description } = parse(parts[1])
const resourceBase = { kind: /** @type {const} */ ('directory'), path: fileURLToPath(directory) }
export const writingSkill = {
  name: String(name), description: String(description), source: 'runtime', path, resourceBase,
  invocation: { userInvocable: true, modelInvocable: false },
  content: parts[2].trim(),
}

export const writingInstructions = [
  '按 ' + writingSkill.name + ' 撰写。用简明、直接的中文，术语遵循目标项目约定。合并重复表述，保留事实、限制、例外、决定及理由。缺少证据时注明待核实事项。',
  '保留规定的章节、草稿标识、JSON 字段和输出格式。区分预期结果、实测结果和待验证项。',
].join('\n')

const sourceEvidence = [
  '引用源码证据时，使用行内代码格式 `src/module.ts:42`，路径相对于所引用文件所在的 Git 仓库根目录，使用 / 分隔。引用多行可写成 `src/module.ts:42-46`。',
  '使用实际查到的行号。仓库中尚不存在的文件或尚未定位的代码，只写相对路径并说明状态。即使工具返回了绝对路径，稿件也只保留仓库相对路径和行号，不使用本机绝对路径、file:// 链接或 Markdown 文件链接。',
]

export const planWritingInstructions = [
  writingInstructions,
  '需要详细写作规则时，读取 `' + path + '`。',
  ...sourceEvidence,
].join('\n')

// Older pending executions stored the prompt prefix. Rebuild the suffix for the original request ID.
export function legacyPlanWritingInstructions() {
  const sections = writingSkill.content.split(/^## /m)
  const rules = ['规则优先级', '事实保真', '先判断任务模式', '核心写作规则', '编辑流程', '最终检查'].map(title => {
    const section = sections.find(text => text.split(/\r?\n/, 1)[0] === title)
    if (!section) throw new Error('中文技术写作技能缺少章节：' + title)
    return section.trim()
  })
  return [
    '使用插件自带的 ' + writingSkill.name + ' 编写和修订交付文档。保留指定章节、草稿标识、JSON 和输出格式。以下规则随请求提供。需要查阅配套资料时，使用技能目录 ' + resourceBase.path,
    ...rules,
    ...sourceEvidence,
  ].join('\n\n')
}
