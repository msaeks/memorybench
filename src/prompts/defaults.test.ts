import { describe, expect, it } from "bun:test"
import {
  ABSTENTION_JUDGE_PROMPT,
  DEFAULT_JUDGE_PROMPT,
  KNOWLEDGE_UPDATE_JUDGE_PROMPT,
  PREFERENCE_JUDGE_PROMPT,
  TEMPORAL_JUDGE_PROMPT,
  buildDefaultAnswerPrompt,
  getJudgePromptForType,
} from "./defaults"

describe("default prompts", () => {
  it("builds default answer prompt with context and fallback date", () => {
    const prompt = buildDefaultAnswerPrompt("What is my favorite color?", [{ a: 1 }])
    expect(prompt).toContain("Question: What is my favorite color?")
    expect(prompt).toContain("Question Date: Not specified")
    expect(prompt).toContain('"a": 1')
  })

  it("selects specialized judge prompts by question type", () => {
    expect(getJudgePromptForType("adversarial")).toBe(ABSTENTION_JUDGE_PROMPT)
    expect(getJudgePromptForType("temporal")).toBe(TEMPORAL_JUDGE_PROMPT)
    expect(getJudgePromptForType("knowledge update")).toBe(KNOWLEDGE_UPDATE_JUDGE_PROMPT)
    expect(getJudgePromptForType("changing facts")).toBe(KNOWLEDGE_UPDATE_JUDGE_PROMPT)
    expect(getJudgePromptForType("user preference")).toBe(PREFERENCE_JUDGE_PROMPT)
    expect(getJudgePromptForType("factual")).toBe(DEFAULT_JUDGE_PROMPT)
  })
})

