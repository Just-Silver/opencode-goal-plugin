import { describe, expect, test } from "bun:test"
import { createTurnTracker } from "./turn"

describe("createTurnTracker", () => {
  test("an automatic turn with no activity is empty", () => {
    const tracker = createTurnTracker()
    tracker.start(true)
    expect(tracker.finish()).toEqual({ automatic: true, hasActivity: false })
  })

  test("markActivity flips hasActivity", () => {
    const tracker = createTurnTracker()
    tracker.start(true)
    tracker.markActivity()
    expect(tracker.finish()).toEqual({ automatic: true, hasActivity: true })
  })

  test("a user-triggered turn is not automatic", () => {
    const tracker = createTurnTracker()
    tracker.start(false)
    expect(tracker.finish()).toEqual({ automatic: false, hasActivity: false })
  })

  test("finish resets state for the next turn", () => {
    const tracker = createTurnTracker()
    tracker.start(true)
    tracker.markActivity()
    tracker.finish()
    tracker.start(true)
    expect(tracker.finish()).toEqual({ automatic: true, hasActivity: false })
  })

  test("finish resets the tracker even without a following start", () => {
    const tracker = createTurnTracker()
    tracker.start(true)
    tracker.markActivity()
    expect(tracker.finish()).toEqual({ automatic: true, hasActivity: true })
    // 关键：没有 start，直接再 finish
    expect(tracker.finish()).toEqual({ automatic: false, hasActivity: false })
  })
})
