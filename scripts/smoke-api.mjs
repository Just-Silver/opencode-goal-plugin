#!/usr/bin/env bun
/**
 * 真机冒烟（API 驱动）—— 传一个会话 ID 就能跑，不需要 TUI。
 *
 * 用法：
 *   bun scripts/smoke-api.mjs --session ses_xxxxxxxx        # 跑全部场景
 *   bun scripts/smoke-api.mjs --session ses_xxx --scenario basic,block
 *   bun scripts/smoke-api.mjs --list                        # 列出场景
 *   bun scripts/smoke-api.mjs --session ses_xxx --server http://127.0.0.1:49374 --password XXX
 *
 * 说明：
 *   - **会真的操作**：往目标会话发 /goal 命令、建/删临时会话、reload 插件、消耗模型额度。
 *     请用专门的冒烟会话（`D:\下载\Goal冒烟` 那种），别拿正在干活的会话。
 *   - 命令/中断/删会话走 HTTP API（Basic auth，口令来自 `opencode pair`）；
 *     OpenAPI 从 `GET /openapi.json` 动态解析 operationId → 路径，不写死路由。
 *   - 目标状态只读读 `opencode.db` 的 kv 表：把 db + `-wal` + `-shm` **复制**到临时目录再读，不碰原库。
 *   - 观察回执/事件走 SSE `GET /api/event`（跨 location 的全局流）。
 *   - 需要 bun（`bun:sqlite`）与 `opencode` CLI（`pair` / `reload`）。
 *
 * 退出码：0 全过；1 有失败。
 */
import { execSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

// 必须与 src/server.ts 的 PLUGIN_ID 一致（决定 KV 命名空间）
const PLUGIN_ID = "opencode-goal"
const KV_PREFIX = "goal:"
const NS = "plugin:" + [...PLUGIN_ID].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + ":"

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

// ---------- 服务器（pair / 显式） ----------
function resolveServer() {
  const server = opt("server")
  const password = opt("password") ?? process.env.OPENCODE_PASSWORD
  if (server && password) return { base: server.replace(/\/$/, ""), password }
  const out = execSync("opencode pair", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1]
  const pass = /Password\s+(\S+)/.exec(out)?.[1]
  if (!port || !pass) throw new Error("无法从 `opencode pair` 解析出地址/口令；用 --server/--password 显式指定")
  return { base: `http://127.0.0.1:${port}`, password: pass }
}
const { base, password } = resolveServer()
const auth = { Authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }

// ---------- OpenAPI：operationId → {method, path} ----------
let spec
async function loadSpec() {
  const res = await fetch(`${base}/openapi.json`, { headers: auth })
  if (!res.ok) throw new Error(`GET /openapi.json -> ${res.status}`)
  spec = await res.json()
}
function resolveOp(opId) {
  for (const [path, methods] of Object.entries(spec.paths))
    for (const [method, op] of Object.entries(methods))
      if (op.operationId === opId) return { method: method.toUpperCase(), path }
  throw new Error(`OpenAPI 里找不到 operationId=${opId}`)
}
async function api(opId, { params = {}, query = {}, body } = {}) {
  const { method, path } = resolveOp(opId)
  let url = base + path.replace(/\{([^}]+)\}/g, (_, k) => {
    if (!(k in params)) throw new Error(`${opId} 缺路径参数 ${k}`)
    return encodeURIComponent(params[k])
  })
  const qs = new URLSearchParams(query).toString()
  if (qs) url += `?${qs}`
  const res = await fetch(url, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${opId} ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

// ---------- KV（只读：复制 db+wal+shm） ----------
function liveDbPath() {
  return process.env.OPENCODE_DB || join(homedir(), ".local", "share", "opencode", "opencode.db")
}
/** 直接写宿主 KV（仅用于构造孤儿记录；用完即删）。KV 直连 DB、无内存缓存，reload 后可见。 */
function writeGoalRow(sessionID, goal) {
  const db = new Database(liveDbPath())
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const now = Date.now()
    db.query(
      "insert into kv (key, value, time_created, time_updated) values (?, ?, ?, ?) " +
        "on conflict(key) do update set value = excluded.value, time_updated = excluded.time_updated",
    ).run(NS + KV_PREFIX + sessionID, JSON.stringify(goal), now, now)
  } finally {
    db.close()
  }
}
function deleteGoalRow(sessionID) {
  const db = new Database(liveDbPath())
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.query("delete from kv where key = ?").run(NS + KV_PREFIX + sessionID)
  } finally {
    db.close()
  }
}
async function readGoals(filter) {
  const dbPath = liveDbPath()
  const dir = mkdtempSync(join(tmpdir(), "goal-smoke-"))
  const copy = join(dir, "opencode.db")
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = dbPath + suffix
      if (!existsSync(src)) continue
      let ok = false
      for (let i = 0; i < 6 && !ok; i++) {
        try { copyFileSync(src, copy + suffix); ok = true } catch { await sleep(150) } // Windows 上 -shm 偶发 EBUSY
      }
      if (!ok && suffix !== "-shm") throw new Error(`复制失败（被占用）：${src}`)
    }
    const db = new Database(copy)
    const rows = db.query("select key, value from kv where key like ? order by key").all(NS + "%")
    const live = new Set(db.query("select id from session_v2").all().map((r) => r.id))
    db.close()
    return rows
      .map((r) => {
        const sid = r.key.slice(NS.length + KV_PREFIX.length)
        let goal = null
        try { goal = JSON.parse(r.value) } catch {}
        return { sessionID: sid, live: live.has(sid), goal }
      })
      .filter((x) => !filter || x.sessionID === filter)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- SSE 事件流 ----------
class Events {
  list = []
  #ctrl
  #stopped = false
  async start() {
    this.#ctrl = new AbortController()
    const res = await fetch(`${base}/api/event`, { headers: auth, signal: this.#ctrl.signal })
    if (!res.ok) throw new Error(`GET /api/event -> ${res.status}`)
    // 长连接可能被服务端/网络断开：结束就自动重连（不丢已收集的事件）
    this.#pump(res.body).finally(() => {
      if (!this.#stopped) setTimeout(() => this.start().catch(() => {}), 1000)
    })
  }
  async #pump(body) {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line.startsWith("data:")) {
            try { this.list.push(JSON.parse(line.slice(5).trim())) } catch {}
          }
        }
      }
    } catch {}
  }
  stop() { this.#stopped = true; this.#ctrl?.abort() }
  mark() { return this.list.length }
  count(type, from = 0, sid) {
    return this.list.slice(from).filter((e) => e.type === type && (!sid || e.data?.sessionID === sid)).length
  }
  /** 命令/续跑的 TUI 回执（synthetic item 的 description；事件流是全局的，按会话过滤） */
  descriptions(from = 0, sid) {
    return this.list
      .slice(from)
      .filter((e) => e.type === "session.inbox.enqueued" && (!sid || e.data?.sessionID === sid))
      .map((e) => e.data?.item?.payload?.description)
      .filter(Boolean)
  }
}

// ---------- 通用 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 命令名与插件 options.command_name 默认值一致；状态控制是独立命令（宿主没有子命令概念）。
const COMMAND_NAME = "goal"
const sendCommand = (sid, name, text = "") => api("session.command", { params: { sessionID: sid }, body: { name, text } })
const sendGoal = (sid, text) => sendCommand(sid, COMMAND_NAME, text)
const control = (sid, action) => sendCommand(sid, `${COMMAND_NAME}-${action}`)
const sendPrompt = (sid, text) => api("session.prompt", { params: { sessionID: sid }, body: { text, resume: true } })
const sessionInfo = async (sid) => {
  const r = await api("session.get", { params: { sessionID: sid } })
  return r.data ?? r.info ?? r
}
const sessionExport = (sid) => api("experimental.session.export", { params: { sessionID: sid } })
const reload = () => execSync("opencode reload", { encoding: "utf8" })
async function waitFor(label, fn, { timeout = 180000, interval = 3000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) return undefined
    await sleep(interval)
  }
}

class Fail extends Error {}
const check = (cond, msg) => { if (!cond) throw new Fail(msg) }

// ---------- 场景 ----------
const SCENARIOS = {
  // 零 token：命令面
  commands: {
    title: "命令面：无目标时 status / pause / resume / clear",
    run: async (ctx) => {
      await control(ctx.sid, "clear")
      await sleep(1000)
      const m = ctx.events.mark()
      for (const action of ["status", "pause", "resume", "clear"]) { await control(ctx.sid, action); await sleep(1200) }
      await sleep(2500)
      const receipts = ctx.receipts(m)
      check(receipts.length >= 4, `应有 4 条回执，实际 ${receipts.length}`)
      check(receipts.every((d) => /No goal/i.test(d)), `回执应都是 No goal：${JSON.stringify(receipts)}`)
      check(!(await ctx.goal()), "不应留下 KV 记录")
    },
  },

  // 基本流程：create → complete → status → clear
  basic: {
    title: "基本流程：/goal 建目标 → 单轮完成 → status/clear",
    run: async (ctx) => {
      await ctx.clearGoal()
      const m = ctx.events.mark()
      await sendGoal(ctx.sid, "在当前目录创建一个 smoke-basic.txt 文件，内容写 ok，然后用 ls 验证文件存在。")
      const active = await ctx.waitStatus("active", 90000)
      check(active, "目标应进入 active")
      const done = await ctx.waitStatus(["complete", "blocked", "budget-limited"], 180000)
      check(done?.status === "complete", `应 complete，实际 ${done?.status}`)
      const m2 = ctx.events.mark()
      await control(ctx.sid, "status")
      await sleep(1500)
      check(ctx.receipts(m2).some((d) => /^Goal \(/.test(d)), "status 回执应报告目标状态")
      await control(ctx.sid, "clear")
      await sleep(2000)
      check(!(await ctx.goal()), "clear 后 KV 记录应消失")
      ctx.log(`回执：${ctx.receipts(m).slice(0, 1)}`)
    },
  },

  // 模型报 blocked（同 key ×3）→ resume 复位
  block: {
    title: "模型报 blocked（同 key 3 次）→ 服务端置 blocked → resume 复位",
    run: async (ctx) => {
      await ctx.clearGoal()
      await sendGoal(ctx.sid, "使用 goal 工具连续调用 op=block 三次：blocker_key 都用 smoke-blocker，blocker 写 等待用户提供信息。不要做其它事情。")
      const blocked = await ctx.waitStatus("blocked", 150000)
      check(blocked, "应进入 blocked")
      check(blocked.blockerStreak >= 3, `blockerStreak 应 >= 3，实际 ${blocked.blockerStreak}`)
      check(blocked.blockerKey === "smoke-blocker", `blockerKey 应为 smoke-blocker，实际 ${blocked.blockerKey}`)
      await control(ctx.sid, "resume")
      const active = await ctx.waitStatus("active", 30000)
      check(active, "resume 后应 active")
      check(active.blockerStreak === 0, `resume 应把 streak 归零，实际 ${active.blockerStreak}`)
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // 预算护栏
  budget: {
    title: "预算：token_budget=1 → budget-limited",
    run: async (ctx) => {
      await ctx.clearGoal()
      await sendGoal(ctx.sid, "调用 goal 工具 op=create，token_budget 设为 1，objective 写 预算冒烟目标。完成后回复一句 已创建。")
      const g = await ctx.waitStatus("budget-limited", 120000)
      check(g, "应进入 budget-limited")
      check(g.tokenBudget === 1, `tokenBudget 应为 1，实际 ${g.tokenBudget}`)
      check(g.tokensUsed > 0, `tokensUsed 应 > 0，实际 ${g.tokensUsed}`)
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // 中断 → paused
  interrupt: {
    title: "中断：运行中 interrupt → paused",
    run: async (ctx) => {
      await ctx.clearGoal()
      await sendGoal(ctx.sid, '调用 bash 工具执行这条命令：for i in $(seq 1 30); do echo "step $i"; sleep 1; done —— 等命令跑完后再回复 完成。')
      const active = await ctx.waitStatus("active", 90000)
      check(active, "目标应先进入 active")
      const res = await api("session.interrupt", { params: { sessionID: ctx.sid } })
      ctx.log(`interrupt -> ${JSON.stringify(res)}`)
      const paused = await ctx.waitStatus("paused", 45000)
      check(paused, "中断后应 paused")
      const evSeen = await waitFor("interrupted-event", () => (ctx.evCount("session.execution.interrupted", ctx.mark0) >= 1 ? true : undefined), { timeout: 10000, interval: 1000 })
      check(evSeen, "应有 session.execution.interrupted 事件")
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // 跨轮自动续跑（依赖模型配合，可能单轮做完而失败）
  continuation: {
    title: "跨轮续跑：每轮只做一个文件，靠自动续跑跨 ≥2 轮",
    run: async (ctx) => {
      await ctx.clearGoal()
      const m = ctx.events.mark()
      await sendGoal(ctx.sid, "分 3 轮完成：第 1 轮创建 r1.txt，第 2 轮创建 r2.txt，第 3 轮创建 r3.txt。每轮只做一个文件就结束本轮，绝不在同一轮里做多个。3 个文件都建好后回复 完成。")
      const done = await ctx.waitStatus(["complete", "blocked", "budget-limited"], 300000)
      check(done, "应到达终态（complete/blocked/budget-limited）")
      const succeeded = ctx.evCount("session.execution.succeeded", m)
      const cont = ctx.receipts(m).filter((d) => /Goal auto-continue/i.test(d)).length
      ctx.log(`execution.succeeded=${succeeded}  auto-continue 回执=${cont}`)
      check(succeeded >= 2, `应至少 2 轮，实际 ${succeeded}（模型可能单轮做完）`)
      check(cont >= 1, `应至少 1 条 auto-continue 回执，实际 ${cont}`)
      // 每轮结束最多投 1 条续跑：> 轮数说明同 location 有多实例/旧激活重复投递（回归护栏）。
      check(cont <= succeeded, `auto-continue 回执 ${cont} 超过轮数 ${succeeded}（多实例重复投递回归）`)
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // create 冲突
  conflict: {
    title: "create 冲突：已有未关闭目标时拒绝 create",
    run: async (ctx) => {
      await ctx.clearGoal()
      await sendGoal(ctx.sid, "在当前目录创建一个 smoke-conflict.txt，内容写 ok。")
      const rec = await ctx.waitStatus(["active", "complete"], 90000)
      check(rec, "应先有一个目标")
      await control(ctx.sid, "pause")
      const paused = await ctx.waitStatus("paused", 30000)
      check(paused, "应能 pause 成未关闭状态")
      await sendPrompt(ctx.sid, "调用 goal 工具 op=create，objective 写 第二个目标。")
      await sleep(8000)
      const exp = await sessionExport(ctx.sid)
      const text = JSON.stringify(exp)
      check(text.includes("already open"), "转录里应出现 already open 的拒绝")
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // 超长目标：KV 存全文（注入截断在 system，不可从转录观察）
  truncate: {
    title: "超长目标：>4000 字符原文进 KV",
    run: async (ctx) => {
      await ctx.clearGoal()
      const long = "截断冒烟：" + "A".repeat(8000)
      await sendGoal(ctx.sid, `调用 goal 工具 op=create，objective 原文照抄下面这段（不要改写、不要省略、不要总结）：\n${long}`)
      const g = await ctx.waitStatus(["active", "complete", "blocked", "budget-limited"], 150000)
      check(g, "应建立目标")
      // 注意：模型可能压缩目标，所以只要求「明显偏长」；插件侧不做截断（KV 存全文）。
      ctx.log(`objective 长度 = ${g.objective.length}（模型可能压缩）`)
      check(g.objective.length >= 3000, `KV 里 objective 应明显偏长，实际 ${g.objective.length}`)
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // 删会话 → KV 清理（含 reload 清实例缓存）
  "kv-cleanup": {
    title: "删会话清理：reload 后删会话 → 记录消失 + session.deleted 判定 allow",
    run: async (ctx) => {
      const info = await sessionInfo(ctx.sid)
      const location = opt("location") ?? info.location?.directory
      check(location, "需要 location（--location 或目标会话的 directory）")
      const created = await api("session.create", { body: { title: "smoke-kv-cleanup", agent: "build", model: info.model, location: { directory: location } } })
      const tmp = created.data.id
      ctx.log(`临时会话：${tmp}`)
      try {
        await sendGoal(tmp, "创建一个 kv-cleanup.txt，内容写 ok，然后用 ls 验证文件存在。")
        const g = await waitFor("record", async () => await ctx.goal(tmp), { timeout: 90000 })
        check(g, "临时会话应建立目标记录")
        reload()
        await sleep(6000)
        check(await ctx.goal(tmp), "reload 不应动 KV")
        await api("session.remove", { params: { sessionID: tmp } })
        await sleep(4000)
        check(!(await ctx.goal(tmp)), "删会话后 KV 记录应消失")
        const m = ctx.events.mark()
        // 注意：要调 `goal-debug` 命令，不是把 "goal-debug events" 当目标发给 /goal
        await api("session.command", { params: { sessionID: ctx.sid }, body: { name: "goal-debug", text: "events" } })
        await sleep(2000)
        const dump = ctx.receipts(m).join("\n")
        ctx.log(`debug events 回执：${dump.replace(/\s+/g, " ").slice(0, 400)}`)
        check(/session\.deleted/.test(dump), "debug events 应包含 session.deleted")
        check(/session\.deleted[^\n]*allow/.test(dump), "session.deleted 判定应为 allow")
      } finally {
        await api("session.remove", { params: { sessionID: tmp } }).catch(() => {})
        await ctx.clearGoal().catch(() => {})
      }
    },
  },

  // 空转 → blocked（依赖模型配合：自动续跑轮只输出空白 = 无活动）
  empty: {
    title: "空转：连续 3 个自动续跑轮无活动 → blocked",
    run: async (ctx) => {
      await ctx.clearGoal()
      await sendGoal(
        ctx.sid,
        "调用 goal 工具 op=create，objective 写：每轮都不要调用任何工具、不要做任何事，只回复一个空格（不要写任何其它文字、不要做任何说明）。创建目标后这一轮回复 已创建。",
      )
      const t0 = Date.now()
      let last
      for (;;) {
        last = await ctx.goal()
        ctx.log(`status=${last?.status} emptyStreak=${last?.emptyStreak} blockerStreak=${last?.blockerStreak}`)
        if (last && ["blocked", "complete", "budget-limited"].includes(last.status)) break
        if (Date.now() - t0 > 240000) break
        await sleep(10000)
      }
      check(last?.status === "blocked", `应 blocked，实际 ${last?.status}（emptyStreak=${last?.emptyStreak}）`)
      check(last.emptyStreak >= 3, `emptyStreak 应 >= 3，实际 ${last.emptyStreak}`)
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },

  // 启动兜底 reconcile：孤儿记录（会话不存在 + 超保护窗）在 reload 后消失，活记录保留
  reconcile: {
    title: "reconcile 冷启动：孤儿 KV（会话不存在）reload 后消失，活记录不被误删",
    run: async (ctx) => {
      await ctx.clearGoal()
      await sendGoal(ctx.sid, "调用 goal 工具 op=create，objective 写 reconcile 活记录。完成后回复 已创建。")
      const live = await ctx.waitStatus(["active", "complete", "blocked", "budget-limited"], 90000)
      check(live, "应建立活记录")
      const orphan = "ses_smokeorphan" + Date.now().toString(36)
      const staleAt = Date.now() - 10 * 60_000 // 超出默认 guard（reconcile_guard_minutes=5）
      try {
        writeGoalRow(orphan, {
          version: 1,
          goalId: "g-orphan",
          objective: "孤儿记录（会话不存在）",
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          blockerStreak: 0,
          emptyStreak: 0,
          createdAt: staleAt,
          updatedAt: staleAt,
        })
        check(await ctx.goal(orphan), "孤儿记录应已写入宿主 KV")
        reload()
        await sleep(7000)
        check(!(await ctx.goal(orphan)), "reconcile 应清掉孤儿记录")
        check(await ctx.goal(ctx.sid), "reconcile 不得误删活记录")
      } finally {
        deleteGoalRow(orphan)
        await control(ctx.sid, "clear").catch(() => {})
        await sleep(1500)
      }
    },
  },
}

// ---------- 选择场景 ----------
if (has("list")) {
  console.log("场景：\n  " + Object.keys(SCENARIOS).join("\n  "))
  process.exit(0)
}
const sessionID = opt("session")
if (!sessionID || !sessionID.startsWith("ses")) {
  console.error("用法：bun scripts/smoke-api.mjs --session ses_xxxx [--scenario a,b] [--location <dir>]")
  process.exit(2)
}
const only = opt("scenario")
const chosen = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(SCENARIOS)

// ---------- 跑 ----------
await loadSpec()
const events = new Events()
await events.start()
await sleep(1500)

const ctxBase = {
  sid: sessionID,
  events,
  log: (m) => console.log(`    · ${m}`),
  goal: async (sid = sessionID) => (await readGoals(sid))[0]?.goal,
  receipts: (from) => events.descriptions(from, sessionID),
  evCount: (type, from) => events.count(type, from, sessionID),
  clearGoal: async () => { await control(sessionID, "clear").catch(() => {}); await sleep(1500) },
  waitStatus: async (want, timeout) => {
    const wants = Array.isArray(want) ? want : [want]
    return waitFor("status", async () => {
      const g = (await readGoals(sessionID))[0]?.goal
      return g && wants.includes(g.status) ? g : undefined
    }, { timeout })
  },
  mark0: 0,
}

const results = []
console.log(`目标会话 ${sessionID} @ ${base}\n`)
for (const name of chosen) {
  const sc = SCENARIOS[name]
  if (!sc) { results.push({ name, ok: false, error: "未知场景" }); continue }
  console.log(`▶ ${name} — ${sc.title}`)
  const t0 = Date.now()
  const ctx = { ...ctxBase, mark0: events.mark() }
  try {
    await sc.run(ctx)
    results.push({ name, ok: true, ms: Date.now() - t0 })
    console.log(`  PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`)
  } catch (e) {
    results.push({ name, ok: false, error: e.message, ms: Date.now() - t0 })
    console.log(`  FAIL: ${e.message}\n`)
    await ctx.clearGoal().catch(() => {})
  }
}
events.stop()

console.log("—— 汇总 ——")
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  " + r.error}`)
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)