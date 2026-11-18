import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

export interface RustField {
  name: string;
  type: string;
  attributes: string[];
}

export interface RustVariant {
  name: string;
  fields: RustField[];
  attributes: string[];
}

export interface RustItem {
  kind: 'struct' | 'enum';
  name: string;
  attributes: string[];
  fields: RustField[];
  variants: RustVariant[];
  file: string;
}

function isBalanced(attribute: string): boolean {
  let depth = 0;
  for (const character of attribute) {
    if (character === '[') depth += 1;
    if (character === ']') depth -= 1;
  }
  return depth <= 0;
}

function readAttribute(lines: string[], start: number): {
  attribute: string;
  end: number;
} {
  let attribute = lines[start].trim();
  let end = start;
  while (!isBalanced(attribute) && end + 1 < lines.length) {
    end += 1;
    attribute += `\n${lines[end].trim()}`;
  }
  return { attribute, end };
}

function parseField(name: string, type: string, attributes: string[]): RustField {
  return { name, type: type.trim(), attributes };
}

function parseStructFields(lines: string[]): RustField[] {
  const fields: RustField[] = [];
  let attributes: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('#[')) {
      const attribute = readAttribute(lines, index);
      attributes.push(attribute.attribute);
      index = attribute.end;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const field = /^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*(.+?),\s*$/.exec(
      trimmed,
    );
    if (field) {
      fields.push(parseField(field[1], field[2], attributes));
      attributes = [];
      continue;
    }
    attributes = [];
  }
  return fields;
}

function parseEnumVariants(lines: string[]): RustVariant[] {
  const variants: RustVariant[] = [];
  let attributes: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('#[')) {
      const attribute = readAttribute(lines, index);
      attributes.push(attribute.attribute);
      index = attribute.end;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const variant = /^(\w+)\s*([({])?/u.exec(trimmed);
    if (!variant) {
      attributes = [];
      continue;
    }

    const fields: RustField[] = [];
    if (variant[2]) {
      const open = variant[2];
      const close = open === '{' ? '}' : ')';
      let body = trimmed.slice(trimmed.indexOf(open) + 1);
      while (!body.includes(close) && index + 1 < lines.length) {
        index += 1;
        body += `\n${lines[index]}`;
      }
      const inner = body.slice(0, body.indexOf(close));
      for (const field of inner.split(',')) {
        const parsed = /^(\w+)\s*:\s*(.+)$/u.exec(field.trim());
        if (parsed) fields.push(parseField(parsed[1], parsed[2], []));
      }
    }
    variants.push({ name: variant[1], fields, attributes });
    attributes = [];
  }
  return variants;
}

export function parseRustItems(source: string, file: string): RustItem[] {
  const lines = source.split(/\r?\n/u);
  const items: RustItem[] = [];
  let attributes: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('#[')) {
      const attribute = readAttribute(lines, index);
      attributes.push(attribute.attribute);
      index = attribute.end;
      continue;
    }
    const declaration = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+(\w+)/u.exec(
      lines[index],
    );
    if (!declaration) {
      if (trimmed !== '' && !trimmed.startsWith('//')) attributes = [];
      continue;
    }

    let end = index + 1;
    while (end < lines.length && lines[end] !== '}') end += 1;
    const body = lines.slice(index + 1, end);
    items.push({
      kind: declaration[1] as 'struct' | 'enum',
      name: declaration[2],
      attributes,
      fields: declaration[1] === 'struct' ? parseStructFields(body) : [],
      variants: declaration[1] === 'enum' ? parseEnumVariants(body) : [],
      file,
    });
    attributes = [];
    index = end;
  }
  return items;
}

export function pascalToSnake(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase();
}

export function snakeToCamel(value: string): string {
  return value
    .split('_')
    .map((part, index) => (
      index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`
    ))
    .join('');
}

export function renameVariant(name: string, style: string): string {
  switch (style) {
    case 'camelCase':
      return snakeToCamel(pascalToSnake(name));
    case 'snake_case':
      return pascalToSnake(name);
    case 'SCREAMING_SNAKE_CASE':
      return pascalToSnake(name).toUpperCase();
    case 'lowercase':
      return name.toLowerCase();
    default:
      throw new Error(`Unsupported serde rename_all style: ${style}`);
  }
}

function attributesText(attributes: string[]): string {
  return attributes.join('\n');
}

export function serdeRenameStyle(item: RustItem | RustVariant): string | null {
  return /rename_all\s*=\s*"([^"]+)"/u.exec(attributesText(item.attributes))?.[1]
    ?? null;
}

export function serdeTag(item: RustItem): string | null {
  return /tag\s*=\s*"([^"]+)"/u.exec(attributesText(item.attributes))?.[1] ?? null;
}

export function serdeSkipsNone(field: RustField): boolean {
  return /skip_serializing_if\s*=\s*"Option::is_none"/u
    .test(attributesText(field.attributes));
}

export function serdeHasDefault(field: RustField): boolean {
  return /#\[serde\([^)]*default/u.test(attributesText(field.attributes));
}

export function serdeFieldRename(field: RustField): string | null {
  return /rename\s*=\s*"([^"]+)"/u.exec(attributesText(field.attributes))?.[1]
    ?? null;
}

export function serdeDeniesUnknownFields(item: RustItem): boolean {
  return /\bdeny_unknown_fields\b/u.test(attributesText(item.attributes));
}

export function derivesDeserialize(item: RustItem): boolean {
  return /\bDeserialize\b/u.test(attributesText(item.attributes));
}

export function unwrapOption(type: string): string | null {
  const match = /^Option<(.+)>$/u.exec(type.trim());
  return match ? match[1] : null;
}

const NUMERIC_TYPES = new Set([
  'u8',
  'u16',
  'u32',
  'u64',
  'usize',
  'i8',
  'i16',
  'i32',
  'i64',
  'isize',
  'f32',
  'f64',
]);

const STRING_TYPES = new Set(['String', 'Id']);

export type RustTypeKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bytes'
  | 'array'
  | 'object'
  | 'enum'
  | 'unknown';

export interface RustTypeShape {
  kind: RustTypeKind;
  inner: string | null;
}

export function classifyRustType(
  type: string,
  structNames: Set<string>,
  enumNames: Set<string>,
): RustTypeShape {
  let current = type.trim();
  const option = unwrapOption(current);
  if (option) current = option.trim();
  current = current.replace(/^&(?:'\w+\s*)?/u, '').trim();

  if (current === 'str' || STRING_TYPES.has(current)) {
    return { kind: 'string', inner: null };
  }
  if (NUMERIC_TYPES.has(current)) {
    return { kind: 'number', inner: null };
  }
  if (current === 'bool') {
    return { kind: 'boolean', inner: null };
  }
  const vector = /^Vec<(.+)>$/u.exec(current);
  if (vector) {
    const inner = vector[1].trim();
    return {
      kind: inner === 'u8' ? 'bytes' : 'array',
      inner: inner === 'u8' ? null : inner,
    };
  }
  if (structNames.has(current)) {
    return { kind: 'object', inner: current };
  }
  if (enumNames.has(current)) {
    return { kind: 'enum', inner: current };
  }
  return { kind: 'unknown', inner: current };
}

export function parseNumericConstants(source: string): Map<string, number> {
  const constants = new Map<string, number>();
  for (const match of source.matchAll(
    /^(?:pub(?:\([^)]*\))?\s+)?const (\w+): \w+ = ([\d_\s*]+);$/gmu,
  )) {
    const value = match[2]
      .replaceAll('_', '')
      .split('*')
      .map((part) => Number.parseInt(part.trim(), 10))
      .reduce((product, part) => product * part, 1);
    constants.set(match[1], value);
  }
  return constants;
}
