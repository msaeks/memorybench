import { describe, expect, it } from "bun:test"
import { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base"
import type { JudgeInput } from "../types/judge"

describe("judge base helpers", () => {
  it("builds prompt using provider-specific judgePrompt when provided", () => {
    const input: JudgeInput = {
      question: "Q?",
      groundTruth: "A",
      hypothesis: "H",
      questionType: "temporal",
      providerPrompts: {
        judgePrompt: () => ({
          default: "default prompt",
          temporal: "temporal prompt",
        }),
      },
    }

    expect(buildJudgePrompt(input)).toBe("temporal prompt")
    expect(getJudgePrompt("any", input.providerPrompts)).toContain("JSON object")
  })

  it("builds default prompt and uses rubric label for preference questions", () => {
    const prefPrompt = buildJudgePrompt({
      question: "q",
      groundTruth: "gt",
      hypothesis: "h",
      questionType: "user preference",
    })
    expect(prefPrompt).toContain("Rubric: gt")

    const normalPrompt = buildJudgePrompt({
      question: "q",
      groundTruth: "gt",
      hypothesis: "h",
      questionType: "factual",
    })
    expect(normalPrompt).toContain("Ground Truth Answer: gt")
  })

  it("parses JSON and handles fallback parse failures", () => {
    expect(parseJudgeResponse('{"score":1,"label":"correct","explanation":"ok"}')).toEqual({
      score: 1,
      label: "correct",
      explanation: "ok",
    })

    expect(parseJudgeResponse('{"score":0,"label":"incorrect"}')).toEqual({
      score: 0,
      label: "incorrect",
      explanation: "",
    })

    expect(parseJudgeResponse("not json but has \"correct\" keyword")).toEqual({
      score: 1,
      label: "correct",
      explanation: "Failed to parse judge response",
    })

    expect(parseJudgeResponse("not json and no winner")).toEqual({
      score: 0,
      label: "incorrect",
      explanation: "Failed to parse judge response",
    })
  })
})

