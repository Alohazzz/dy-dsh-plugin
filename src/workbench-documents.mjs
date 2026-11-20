import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lexer } from 'marked'
import { parse } from 'yaml'
import { legacyPlanWritingInstructions, planWritingInstructions } from './writing-skill.mjs'

const directory = new URL('../skills/dy-workbench-docs/', import.meta.url)

/** @param {string} name */
function resource(name) {
  try {
    return readFileSync(new URL(name, directory), 'utf8').trim()
  } catch (error) {
    throw new Error(`缺少研发工作台资源 skills/dy-workbench-docs/${name}，请重新安装完整插件包`, { cause: error })
  }
}

const skillSource = resource('SKILL.md')
const parts = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]+)$/.exec(skillSource)
if (!parts) throw new Error('研发工作台文档 Skill 缺少元数据，请重新安装完整插件包')
const { name, description } = parse(parts[1])
export const workbenchWritingSkill = {
  name: String(name), description: String(description), source: 'runtime',
  path: fileURLToPath(new URL('SKILL.md', directory)),
  resourceBase: { kind: /** @type {const} */ ('directory'), path: fileURLToPath(directory) },
  invocation: { userInvocable: true, modelInvocable: false },
  content: parts[2],
}

/** @typedef {{title: string, format: string, requiredFields: string[], sections?: string[], testSections?: string[], legacyTestSections?: string[]}} Template */
/** @typedef {'research' | 'proposal' | 'execution' | 'change' | 'publication' | 'completion'} DocumentType */
const types = ['research', 'proposal', 'execution', 'change', 'publication', 'completion']
export const templateVersion = 1
/** @type {Map<number, Record<DocumentType, Template>>} */
const templates = new Map()
// Load the current version first so a partial install names the missing resource.
resource(`references/templates-v${templateVersion}.json`)
const installedVersions = [templateVersion, ...readdirSync(new URL('references/', directory))
  .map(file => Number(/^templates-v([1-9]\d*)\.json$/.exec(file)?.[1]))
  .filter(version => Number.isSafeInteger(version) && version < templateVersion)]
for (const version of installedVersions) {
  const path = `references/templates-v${version}.json`
  const data = JSON.parse(resource(path))
  if (data.version !== version || types.some(type => !Array.isArray(data.documents?.[type]?.requiredFields))) {
    throw new Error(`研发工作台模板 ${path} 的版本或必填字段定义无效，请重新安装完整插件包`)
  }
  templates.set(version, data.documents)
}
export const archiveReadme = resource('references/archive-readme.md')
export const archiveManifest = JSON.parse(resource('references/archive-manifest.json'))

/** @param {DocumentType} type @param {number} [version] */
export function templateFor(type, version = templateVersion) {
  const template = templates.get(version)?.[type]
  if (!template) throw new Error(`文档模板 ${type} v${version} 无法读取，请安装支持该版本的插件`)
  return template
}

export function researchDocumentInstructions() {
  const guidance = workbenchWritingSkill.content.split(/(?=^## )/m)
    .filter(section => /^## (调研与执行方案|交付前核对)\r?\n/.test(section))
    .map(section => section.trim())
  return [
    ...guidance,
    planWritingInstructions,
    '按以下顺序写二级标题。',
    '调研报告：' + templateFor('research').sections?.join('、') + '。',
    '执行方案：' + templateFor('proposal').sections?.join('、') + '。',
  ].join('\n\n')
}

export function legacyExecutionDocumentInstructions() {
  return [workbenchWritingSkill.content, legacyPlanWritingInstructions(), JSON.stringify({
    execution: templateFor('execution', 1), publication: templateFor('publication', 1),
  })].join('\n\n')
}

/** @param {string} file @param {string} markdown @param {string[]} expected */
export function validateSections(file, markdown, expected) {
  const headings = []
  let section
  for (const token of lexer(markdown)) {
    if (token.type === 'heading' && token.depth === 2) {
      section = { name: token.text.trim(), hasBody: false }
      headings.push(section)
    } else if (section && token.type !== 'space' && token.raw.trim()) {
      section.hasBody = true
    }
  }
  const names = headings.map(heading => heading.name)
  const repeated = names.find((name, index) => names.indexOf(name) !== index)
  if (repeated) throw new Error(`${file} 的章节「${repeated}」重复，请合并为一节`)
  const missing = expected.find(name => !names.includes(name))
  if (missing) throw new Error(`${file} 缺少「${missing}」，请补齐该章及其正文`)
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`${file} 章节不符，请按模板排列：${expected.join('、')}`)
  }
  const empty = headings.find(heading => !heading.hasBody)
  if (empty) throw new Error(`${file} 的「${empty.name}」正文为空，请填写内容`)
}

/** @param {string} markdown @param {string} title */
export function sectionBody(markdown, title) {
  const output = []
  let active = false
  for (const token of lexer(markdown)) {
    if (token.type === 'heading' && token.depth === 2) active = token.text.trim() === title
    else if (active) output.push(token.raw)
  }
  return output.join('').trim()
}

export const behaviorHeading = '可观察行为差异'

/** @param {string} testSection @param {string} differences */
export function includeBehaviorDifferences(testSection, differences) {
  if (!differences) return testSection
  let replacing = false
  const kept = []
  let found = false
  for (const token of lexer(testSection)) {
    if (token.type === 'heading' && token.depth <= 3) replacing = token.depth === 3 && token.text.trim() === behaviorHeading
    if (replacing) found = true
    if (!replacing) kept.push(token.raw)
  }
  return (found ? kept.join('') : testSection).trimEnd() + '\n\n### ' + behaviorHeading + '\n\n' + differences
}

/** @param {DocumentType} type @param {string} file @param {Record<string, unknown>} fields @param {string} [markdown] @param {number} [version] */
export function validatedDocument(type, file, fields, markdown, version = templateVersion) {
  const template = templateFor(type, version)
  const missing = template.requiredFields.find(key => fields[key] == null ||
    (typeof fields[key] === 'string' && !String(fields[key]).trim()))
  if (missing) throw new Error(`${file} 缺少字段 ${missing}，请补齐来源后重试`)
  const metadata = { ...fields, documentType: type, templateVersion: version }
  if (template.format === 'json') return metadata
  validateSections(file, markdown ?? '', template.sections ?? [])
  return { ...metadata, markdown: markdown?.trim() }
}
