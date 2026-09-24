#!/usr/bin/env node
/**
 * CHANGELOG / 版本一致性工具（CD 门禁 + Release body 提取）。
 *
 * 用法：
 *   node scripts/changelog.mjs check [--tag vX.Y.Z]   # 一致性门禁：package.json == CHANGELOG == tag
 *   node scripts/changelog.mjs notes [--out FILE]     # 提取当前版本的小节正文（GitHub Release body）
 *
 * 退出码：0 通过；1 不一致（输出写明哪一处不符）。
 * 说明：Release body 必须来自 CHANGELOG 该版本小节，禁止用 git log 拼。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")

/** 解析成 Map<版本号, {date, body}>（按文件中出现顺序）。 */
function parseSections(text) {
  const sections = new Map()
  let current = null
  let buffer = []
  const flush = () => {
    if (current) sections.set(current.version, { date: current.date, body: buffer.join("\n").trim() })
  }
  for (const line of text.split(/\r?\n/)) {
    // 允许 `## [0.0.5] - 2014-12-13 [YANKED]` 这类尾部标记
    const m = /^##\s+\[([^\]]+)\]\s*(?:-\s*(\d{4}-\d{2}-\d{2}))?/.exec(line)
    if (m) {
      flush()
      current = { version: m[1].trim(), date: m[2] ?? null }
      buffer = []
      continue
    }
    if (current) buffer.push(line)
  }
  flush()
  return sections
}

const sections = parseSections(changelog)
const version = pkg.version
const args = process.argv.slice(2)
const command = args[0] ?? "check"
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (command === "check") {
  const tag = flag("--tag")
  const problems = []
  if (!version) problems.push("package.json 缺少 version")
  if (tag) {
    const tagVersion = tag.replace(/^v/, "")
    if (tagVersion !== version) problems.push(`tag ${tag} 的版本 ${tagVersion} ≠ package.json 的 ${version}`)
  }
  const section = sections.get(version)
  if (!section) {
    problems.push(`CHANGELOG.md 缺少 \`## [${version}]\` 小节`)
  } else {
    if (!section.date) problems.push(`CHANGELOG.md 的 [${version}] 小节缺少发布日期（YYYY-MM-DD）`)
    if (!section.body) problems.push(`CHANGELOG.md 的 [${version}] 小节为空`)
  }
  if (problems.length) fail(`版本一致性校验失败：\n  - ${problems.join("\n  - ")}`)
  console.log(`✓ 版本一致：${pkg.name}@${version}${tag ? ` == tag ${tag}` : ""} == CHANGELOG [${version}] - ${section.date}`)
  process.exit(0)
}

if (command === "notes") {
  const section = sections.get(version)
  if (!section || !section.body) fail(`CHANGELOG.md 里没有 [${version}] 小节正文，无法生成 Release body`)
  const out = flag("--out")
  if (out) {
    writeFileSync(out, `${section.body}\n`, "utf8")
    console.log(`✓ 已写出 ${out}（来自 CHANGELOG [${version}]，${section.body.length} 字符）`)
  } else {
    process.stdout.write(`${section.body}\n`)
  }
  process.exit(0)
}

fail(`未知子命令：${command}（可用：check / notes）`)
