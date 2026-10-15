import type { Decision } from "./types.ts"

const DECISIONS = new Set(["allow", "allow_session", "deny"])
const REQUIRED_KEYS = ["decision", "reason", "reasonCode"]
const ALLOWED_KEYS = [...REQUIRED_KEYS, "alternatives"]
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/
const MAX_REASON_LENGTH = 240
const MAX_ALTERNATIVES = 3
const MAX_ALTERNATIVE_LENGTH = 180

export function parseDecision(value: unknown): Decision | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort()
  if (
    keys.join(",") !== REQUIRED_KEYS.join(",") &&
    keys.join(",") !== ALLOWED_KEYS.sort().join(",")
  ) return null

  const decision = value.decision
  const reasonCode = value.reasonCode
  const reason = value.reason
  if (typeof decision !== "string" || !DECISIONS.has(decision)) return null
  if (typeof reasonCode !== "string" || !REASON_CODE.test(reasonCode)) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  const alternatives = value.alternatives
  if (
    alternatives !== undefined &&
    (!Array.isArray(alternatives) ||
      alternatives.length > MAX_ALTERNATIVES ||
      !alternatives.every((item) => typeof item === "string" && item.trim()))
  ) return null
  // Verbose but otherwise valid decisions are usable: trimming keeps the
  // structured result inside the reason contract instead of failing the review
  // and blocking the action the reviewer intended to approve or deny.
  const parsed = { kind: decision as Decision["kind"], reasonCode, reason: reason.slice(0, MAX_REASON_LENGTH) }
  if (decision !== "deny" || !Array.isArray(alternatives) || alternatives.length === 0) return parsed
  return {
    ...parsed,
    alternatives: alternatives.map((alternative) => alternative.trim().slice(0, MAX_ALTERNATIVE_LENGTH)),
  } as Decision
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
