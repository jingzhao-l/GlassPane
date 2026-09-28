/**
 * A validator for the JSON Schema subset used by `schema/update-state.schema.json`
 * (`type`, `enum`, `required`, `properties`, `additionalProperties`, `items`,
 * `maxItems`, `minItems`, `pattern`, `minLength`). Written by hand because this
 * package keeps zero dependencies — the same reason the MCP shell and the
 * installer do.
 *
 * It is real validation, not a shape echo: `validateState` is what refuses to
 * publish a status outside the closed enum, and the state tests prove the
 * refusal by handing it one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SCHEMA_PATH = path.join(HERE, '..', 'schema', 'update-state.schema.json')

let cached = null
/** Read (and cache) the schema this package self-validates against. */
export function loadSchema(file = SCHEMA_PATH) {
  if (cached && file === SCHEMA_PATH) return cached
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (file === SCHEMA_PATH) cached = parsed
  return parsed
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function typeMatches(value, want) {
  const actual = typeOf(value)
  if (actual === want) return true
  if (want === 'number' && actual === 'integer') return true
  return false
}

function describePath(label, key) {
  return key === undefined ? label : `${label}/${key}`
}

/** Validate `value` against `schema`; returns an array of readable errors. */
export function validate(schema, value, label = '#') {
  const errors = []
  checkNode(schema, value, label, errors)
  return errors
}

function checkNode(schema, value, label, errors) {
  if (!schema || typeof schema !== 'object') return

  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => v === value)) {
      errors.push(`${label}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
    }
    return
  }
  if (schema.type !== undefined) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!wants.some((w) => typeMatches(value, w))) {
      errors.push(`${label}: expected ${wants.join('|')}, got ${typeOf(value)}`)
      return
    }
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${label}: ${JSON.stringify(value)} does not match /${schema.pattern}/`)
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${label}: shorter than minLength ${schema.minLength}`)
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${label}: ${value} < minimum ${schema.minimum}`)
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${label}: ${value.length} items exceeds maxItems ${schema.maxItems}`)
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${label}: ${value.length} items below minItems ${schema.minItems}`)
    }
    if (schema.items) {
      value.forEach((entry, i) => checkNode(schema.items, entry, `${label}/${i}`, errors))
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${label}: missing required property ${key}`)
    }
    const props = schema.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) {
        checkNode(props[key], child, describePath(label, key), errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${label}: property ${key} is not allowed by the schema`)
      }
    }
  }
}

/** Throw with a readable aggregate message when `state` violates the schema. */
export function assertValidState(state, schema = loadSchema()) {
  const errors = validate(schema, state)
  if (errors.length > 0) {
    throw new Error(`update-state schema violated: ${errors.join('; ')}`)
  }
  return state
}
