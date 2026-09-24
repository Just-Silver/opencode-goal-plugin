import { describe, expect, test } from "bun:test"
import { acquireGeneration, generationKey } from "./generation"

describe("generationKey", () => {
  test("collapses trailing separators and backslashes", () => {
    const a = generationKey("D:\\下载\\Goal冒烟")
    const b = generationKey("D:/下载/Goal冒烟/")
    expect(a).toBe(b)
  })

  test("is case-insensitive on windows", () => {
    if (process.platform !== "win32") return
    expect(generationKey("E:\\Code\\Proj")).toBe(generationKey("e:/code/proj"))
  })
})

describe("acquireGeneration", () => {
  test("a newer generation supersedes and aborts the older one", () => {
    const first = acquireGeneration("gen-test-supersede")
    expect(first.isCurrent()).toBe(true)
    expect(first.signal.aborted).toBe(false)

    const second = acquireGeneration("gen-test-supersede")
    expect(first.isCurrent()).toBe(false)
    expect(first.signal.aborted).toBe(true)
    expect(second.isCurrent()).toBe(true)
    expect(second.signal.aborted).toBe(false)

    second.release()
  })

  test("release of a superseded generation does not evict the current one", () => {
    const first = acquireGeneration("gen-test-release")
    const second = acquireGeneration("gen-test-release")

    first.release()
    expect(second.isCurrent()).toBe(true)

    second.release()
    expect(second.isCurrent()).toBe(false)
  })

  test("a fresh generation after release is current and un-aborted", () => {
    const first = acquireGeneration("gen-test-fresh")
    first.release()
    expect(first.isCurrent()).toBe(false)

    const second = acquireGeneration("gen-test-fresh")
    expect(second.isCurrent()).toBe(true)
    expect(second.signal.aborted).toBe(false)
    second.release()
  })

  test("different locations do not supersede each other", () => {
    const a = acquireGeneration("gen-test-loc-a")
    const b = acquireGeneration("gen-test-loc-b")
    expect(a.isCurrent()).toBe(true)
    expect(b.isCurrent()).toBe(true)
    expect(a.signal.aborted).toBe(false)
    a.release()
    b.release()
  })
})