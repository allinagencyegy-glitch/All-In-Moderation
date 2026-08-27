/**
 * A tiny, dependency-free schema DSL.
 *
 * It exists for three jobs, all of which need the *same* schema to both validate a value and
 * describe itself to a language model:
 *   1. Validating structured LLM output (ADR-007).
 *   2. Validating domain event payloads (ADR-009).
 *   3. Validating Account Pack sections at publish time (ADR-010).
 *
 * Two deliberate strictness choices:
 *   - Unknown object properties are **rejected**, not stripped. A model that invents a field is
 *     usually inventing a capability, and silently dropping it hides that.
 *   - `undefined` and a missing key are the same thing; `null` is not. Ambiguity about absence is
 *     a reliable source of "why is this field empty in production".
 */
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface Schema<T> {
  readonly kind: string;
  readonly isOptional?: boolean;
  check(value: unknown, path: string, issues: ValidationIssue[]): void;
  toJsonSchema(): JsonValue;
  /** Phantom type carrier. Never assigned at runtime. */
  readonly __t?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly isOptional: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferObject<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const at = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

// --- primitives -------------------------------------------------------------------------------

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly description?: string;
}

export function string(options: StringOptions = {}): Schema<string> {
  return {
    kind: 'string',
    check(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push({ path, message: `expected string, received ${typeName(value)}` });
        return;
      }
      if (options.minLength !== undefined && value.length < options.minLength) {
        issues.push({ path, message: `expected at least ${options.minLength} characters` });
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        issues.push({ path, message: `expected at most ${options.maxLength} characters` });
      }
      if (options.pattern && !options.pattern.test(value)) {
        issues.push({ path, message: `does not match ${options.pattern.source}` });
      }
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = { type: 'string' };
      if (options.minLength !== undefined) node['minLength'] = options.minLength;
      if (options.maxLength !== undefined) node['maxLength'] = options.maxLength;
      if (options.pattern) node['pattern'] = options.pattern.source;
      if (options.description) node['description'] = options.description;
      return node;
    },
  };
}

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly description?: string;
}

export function number(options: NumberOptions = {}): Schema<number> {
  return {
    kind: 'number',
    check(value, path, issues) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: `expected finite number, received ${typeName(value)}` });
        return;
      }
      if (options.integer && !Number.isInteger(value)) {
        issues.push({ path, message: 'expected an integer' });
      }
      if (options.min !== undefined && value < options.min) {
        issues.push({ path, message: `expected >= ${options.min}` });
      }
      if (options.max !== undefined && value > options.max) {
        issues.push({ path, message: `expected <= ${options.max}` });
      }
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = { type: options.integer ? 'integer' : 'number' };
      if (options.min !== undefined) node['minimum'] = options.min;
      if (options.max !== undefined) node['maximum'] = options.max;
      if (options.description) node['description'] = options.description;
      return node;
    },
  };
}

export function boolean(description?: string): Schema<boolean> {
  return {
    kind: 'boolean',
    check(value, path, issues) {
      if (typeof value !== 'boolean') {
        issues.push({ path, message: `expected boolean, received ${typeName(value)}` });
      }
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = { type: 'boolean' };
      if (description) node['description'] = description;
      return node;
    },
  };
}

export function literal<L extends string | number | boolean>(expected: L): Schema<L> {
  return {
    kind: 'literal',
    check(value, path, issues) {
      if (value !== expected) {
        issues.push({ path, message: `expected ${JSON.stringify(expected)}` });
      }
    },
    toJsonSchema: () => ({ const: expected as JsonValue }),
  };
}

export function enumOf<const T extends readonly [string, ...string[]]>(
  values: T,
  description?: string,
): Schema<T[number]> {
  const allowed = new Set<string>(values);
  return {
    kind: 'enum',
    check(value, path, issues) {
      if (typeof value !== 'string' || !allowed.has(value)) {
        issues.push({ path, message: `expected one of: ${values.join(', ')}` });
      }
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = { type: 'string', enum: [...values] };
      if (description) node['description'] = description;
      return node;
    },
  };
}

/** Any JSON value. Used only where the shape is genuinely open (raw provider payloads). */
export function jsonValue(description?: string): Schema<JsonValue> {
  return {
    kind: 'json',
    check(value, path, issues) {
      if (!isJson(value)) {
        issues.push({ path, message: 'expected a JSON-serialisable value' });
      }
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = {};
      if (description) node['description'] = description;
      return node;
    },
  };
}

// --- combinators ------------------------------------------------------------------------------

export interface ArrayOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly description?: string;
}

export function array<S extends Schema<unknown>>(
  item: S,
  options: ArrayOptions = {},
): Schema<Infer<S>[]> {
  return {
    kind: 'array',
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `expected array, received ${typeName(value)}` });
        return;
      }
      if (options.minItems !== undefined && value.length < options.minItems) {
        issues.push({ path, message: `expected at least ${options.minItems} items` });
      }
      if (options.maxItems !== undefined && value.length > options.maxItems) {
        issues.push({ path, message: `expected at most ${options.maxItems} items` });
      }
      value.forEach((entry, index) => item.check(entry, at(path, index), issues));
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = { type: 'array', items: item.toJsonSchema() };
      if (options.minItems !== undefined) node['minItems'] = options.minItems;
      if (options.maxItems !== undefined) node['maxItems'] = options.maxItems;
      if (options.description) node['description'] = options.description;
      return node;
    },
  };
}

export function object<S extends Shape>(
  shape: S,
  options: { readonly description?: string; readonly allowUnknown?: boolean } = {},
): Schema<InferObject<S>> {
  const keys = Object.keys(shape);
  return {
    kind: 'object',
    check(value, path, issues) {
      if (!isPlainObject(value)) {
        issues.push({ path, message: `expected object, received ${typeName(value)}` });
        return;
      }
      for (const key of keys) {
        const field = shape[key]!;
        const present =
          Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
        if (!present) {
          if (!field.isOptional) issues.push({ path: at(path, key), message: 'is required' });
          continue;
        }
        field.check(value[key], at(path, key), issues);
      }
      if (!options.allowUnknown) {
        for (const key of Object.keys(value)) {
          if (!keys.includes(key)) {
            // Rejected rather than stripped: an invented field usually means an invented capability.
            issues.push({ path: at(path, key), message: 'unknown property is not allowed' });
          }
        }
      }
    },
    toJsonSchema() {
      const properties: Record<string, JsonValue> = {};
      const required: string[] = [];
      for (const key of keys) {
        const field = shape[key]!;
        properties[key] = field.toJsonSchema();
        if (!field.isOptional) required.push(key);
      }
      const node: Record<string, JsonValue> = {
        type: 'object',
        properties,
        required,
        additionalProperties: options.allowUnknown ?? false,
      };
      if (options.description) node['description'] = options.description;
      return node;
    },
  };
}

export function record<S extends Schema<unknown>>(
  value: S,
  options: { readonly maxEntries?: number; readonly description?: string } = {},
): Schema<Record<string, Infer<S>>> {
  return {
    kind: 'record',
    check(candidate, path, issues) {
      if (!isPlainObject(candidate)) {
        issues.push({ path, message: `expected object, received ${typeName(candidate)}` });
        return;
      }
      const entries = Object.entries(candidate);
      if (options.maxEntries !== undefined && entries.length > options.maxEntries) {
        issues.push({ path, message: `expected at most ${options.maxEntries} entries` });
      }
      for (const [key, entry] of entries) {
        value.check(entry, at(path, key), issues);
      }
    },
    toJsonSchema() {
      const node: Record<string, JsonValue> = {
        type: 'object',
        additionalProperties: value.toJsonSchema(),
      };
      if (options.description) node['description'] = options.description;
      return node;
    },
  };
}

export function optional<S extends Schema<unknown>>(
  inner: S,
): Schema<Infer<S> | undefined> & { readonly isOptional: true } {
  return {
    kind: `optional<${inner.kind}>`,
    isOptional: true,
    check(value, path, issues) {
      if (value === undefined) return;
      inner.check(value, path, issues);
    },
    toJsonSchema: () => inner.toJsonSchema(),
  };
}

export function nullable<S extends Schema<unknown>>(inner: S): Schema<Infer<S> | null> {
  return {
    kind: `nullable<${inner.kind}>`,
    check(value, path, issues) {
      if (value === null) return;
      inner.check(value, path, issues);
    },
    toJsonSchema: () => ({ anyOf: [inner.toJsonSchema(), { type: 'null' }] }),
  };
}

export function union<S extends readonly [Schema<unknown>, ...Schema<unknown>[]]>(
  variants: S,
): Schema<Infer<S[number]>> {
  return {
    kind: 'union',
    check(value, path, issues) {
      const attempts: ValidationIssue[][] = [];
      for (const variant of variants) {
        const local: ValidationIssue[] = [];
        variant.check(value, path, local);
        if (local.length === 0) return;
        attempts.push(local);
      }
      // Report the closest match rather than every branch: a wall of alternatives is unreadable
      // in a log and useless when fed back to a model for repair.
      const closest = attempts.reduce((a, b) => (b.length < a.length ? b : a));
      issues.push({
        path,
        message: `did not match any variant (closest: ${closest[0]?.message ?? 'unknown'})`,
      });
    },
    toJsonSchema: () => ({ anyOf: variants.map((v) => v.toJsonSchema()) }),
  };
}

// --- entry points -----------------------------------------------------------------------------

export function validate<S extends Schema<unknown>>(schema: S, value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  schema.check(value, '', issues);
  return issues;
}

export function parse<S extends Schema<unknown>>(
  schema: S,
  value: unknown,
): Result<Infer<S>, ValidationIssue[]> {
  const issues = validate(schema, value);
  if (issues.length > 0) return err(issues);
  return ok(value as Infer<S>);
}

export function formatIssues(issues: readonly ValidationIssue[], limit = 10): string {
  return issues
    .slice(0, limit)
    .map((i) => `${i.path === '' ? '<root>' : i.path}: ${i.message}`)
    .join('; ');
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean')
    return Number.isFinite(value) || t !== 'number';
  if (Array.isArray(value)) return value.every(isJson);
  if (isPlainObject(value)) return Object.values(value).every(isJson);
  return false;
}
