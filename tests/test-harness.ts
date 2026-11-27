/**
 * Lightweight Jest/Vitest-compatible assertion & spy helpers built purely on
 * `node:assert/strict` + `node:test` so the test suite runs natively on
 * `node --test` with zero vulnerable third-party test-runner dependencies.
 */
import assert from 'node:assert/strict'

const ASYM = Symbol('asymmetricMatcher')

interface AsymmetricMatcher {
  readonly [ASYM]: true
  matches(actual: unknown): boolean
  describe(): string
}

function isAsymmetric(v: unknown): v is AsymmetricMatcher {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[ASYM] === true
}

function deepMatch(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual)
  if (Object.is(actual, expected)) return true
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime()
  if (actual instanceof RegExp && expected instanceof RegExp) return String(actual) === String(expected)
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false
    return expected.every((item, idx) => deepMatch(actual[idx], item))
  }
  if (
    typeof actual === 'object' &&
    actual !== null &&
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const aObj = actual as Record<string, unknown>
    const eObj = expected as Record<string, unknown>
    const eKeys = Object.keys(eObj).filter(k => eObj[k] !== undefined)
    const aKeys = Object.keys(aObj).filter(k => aObj[k] !== undefined)
    if (aKeys.length !== eKeys.length) return false
    return eKeys.every(k => Object.prototype.hasOwnProperty.call(aObj, k) && deepMatch(aObj[k], eObj[k]))
  }
  return false
}

function formatVal(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (isAsymmetric(val) ? val.describe() : val), 2)
  } catch {
    return String(v)
  }
}

export function expect(actual: unknown) {
  const matchers = (negated: boolean) => {
    const check = (pass: boolean, msg: () => string) => {
      if (negated ? pass : !pass) {
        throw new assert.AssertionError({ message: msg(), actual })
      }
    }
    return {
      toBe(expected: unknown) {
        check(Object.is(actual, expected), () => `Expected ${formatVal(actual)} ${negated ? 'not ' : ''}to be ${formatVal(expected)}`)
      },
      toEqual(expected: unknown) {
        check(deepMatch(actual, expected), () => `Expected ${formatVal(actual)} ${negated ? 'not ' : ''}to equal ${formatVal(expected)}`)
      },
      toBeDefined() {
        check(actual !== undefined, () => `Expected value ${negated ? 'not ' : ''}to be defined`)
      },
      toBeUndefined() {
        check(actual === undefined, () => `Expected ${formatVal(actual)} ${negated ? 'not ' : ''}to be undefined`)
      },
      toHaveLength(len: number) {
        const actualLen = (actual as { length?: number } | null | undefined)?.length
        check(actualLen === len, () => `Expected length ${len}${negated ? ' (negated)' : ''}, got ${String(actualLen)}`)
      },
      toContain(item: unknown) {
        let pass = false
        if (typeof actual === 'string' && typeof item === 'string') {
          pass = actual.includes(item)
        } else if (Array.isArray(actual)) {
          pass = actual.some(el => deepMatch(el, item))
        }
        check(pass, () => `Expected ${formatVal(actual)} ${negated ? 'not ' : ''}to contain ${formatVal(item)}`)
      },
    }
  }
  return Object.assign(matchers(false), { not: matchers(true) })
}

expect.objectContaining = (partial: Record<string, unknown>): AsymmetricMatcher => ({
  [ASYM]: true,
  describe: () => `ObjectContaining(${formatVal(partial)})`,
  matches(actual: unknown): boolean {
    if (typeof actual !== 'object' || actual === null) return false
    const aObj = actual as Record<string, unknown>
    return Object.entries(partial).every(([k, v]) => deepMatch(aObj[k], v))
  },
})

expect.arrayContaining = (subset: readonly unknown[]): AsymmetricMatcher => ({
  [ASYM]: true,
  describe: () => `ArrayContaining(${formatVal(subset)})`,
  matches(actual: unknown): boolean {
    if (!Array.isArray(actual)) return false
    return subset.every(expectedItem => actual.some(actualItem => deepMatch(actualItem, expectedItem)))
  },
})

type Restorer = () => void
const activeRestorers: Restorer[] = []

export const vi = {
  spyOn<T extends object, K extends keyof T>(target: T, key: K) {
    const hadOwn = Object.prototype.hasOwnProperty.call(target, key)
    const original = target[key]
    const restore = () => {
      if (hadOwn) {
        target[key] = original
      } else {
        delete target[key]
      }
    }
    activeRestorers.push(restore)
    return {
      mockImplementation(fn: T[K]) {
        target[key] = fn
        return this
      },
      mockRestore: restore,
    }
  },
  restoreAllMocks() {
    while (activeRestorers.length > 0) {
      activeRestorers.pop()?.()
    }
  },
}
