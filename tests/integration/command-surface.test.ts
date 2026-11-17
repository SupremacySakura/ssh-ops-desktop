import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as contracts from '../../packages/contracts/src/index.ts';
import { readRepoFile, repoRoot, snakeToCamel } from './support/rust-source.ts';

interface InvokeCall {
  command: string;
  keys: string[];
  spreadSchemas: string[];
}

function parseManifestCommands(): string[] {
  const source = readRepoFile('src-tauri/build.rs');
  const block = /\.commands\(&\[([\s\S]*?)\]\)/u.exec(source)?.[1];
  if (!block) throw new Error('src-tauri/build.rs has no command manifest');
  return [...block.matchAll(/"([a-z][a-z0-9_]+)"/gu)].map(([, command]) => command);
}

function parseHandlerCommands(): string[] {
  const source = readRepoFile('src-tauri/src/lib.rs');
  const block = /generate_handler!\s*\[([\s\S]*?)\]/u.exec(source)?.[1];
  if (!block) throw new Error('src-tauri/src/lib.rs has no invoke handler');
  return block.split(',').map((command) => command.trim()).filter(Boolean);
}

interface RustCommand {
  name: string;
  params: string[];
  payloadParams: string[];
}

function parseCommandFunctions(): RustCommand[] {
  const directory = join(repoRoot, 'src-tauri/src/commands');
  const commands: RustCommand[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.rs'))) {
    const source = readFileSync(join(directory, file), 'utf8');
    for (const match of source.matchAll(
      /#\[tauri::command\]\s*pub\(crate\)\s+(?:async\s+)?fn\s+(\w+)\s*\(([\s\S]*?)\)\s*->/gu,
    )) {
      const params = match[2]
        .split(',')
        .map((param) => param.trim())
        .filter(Boolean)
        .map((param) => ({
          name: param.split(':')[0]?.trim() ?? '',
          type: param.split(':').slice(1).join(':').trim(),
        }));
      const injected = new Set([
        'AppHandle',
        'Window',
        'WebviewWindow',
        'Webview',
        'State',
      ]);
      const injectedPath = /^(?:tauri::)?(?:AppHandle|Window|WebviewWindow|Webview|State)\b/u;
      commands.push({
        name: match[1],
        params: params.map(({ name }) => name),
        payloadParams: params
          .filter(({ type }) => (
            !injected.has(type.split('<')[0].trim())
            && !injectedPath.test(type)
          ))
          .map(({ name }) => name),
      });
    }
  }
  return commands;
}

function importedSchemaNames(sourceFile: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || statement.moduleSpecifier.getText(sourceFile).replaceAll(/['"]/gu, '')
        !== '@opspilot/contracts'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      names.set(
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      );
    }
  }
  return names;
}

function parseInvokeCalls(): InvokeCall[] {
  const path = join(repoRoot, 'apps/desktop/src/api/core.ts');
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(
    'core.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const schemaImports = importedSchemaNames(sourceFile);
  const calls: InvokeCall[] = [];

  const schemaForVariable = (scope: ts.Node, variable: string): string | null => {
    let found: string | null = null;
    const search = (node: ts.Node) => {
      if (
        found === null
        && ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === variable
        && node.initializer
      ) {
        const text = node.initializer.getText(sourceFile);
        const schema = /\b(\w+Schema)\.parse\b/u.exec(text)?.[1];
        if (schema) found = schemaImports.get(schema) ?? schema;
      }
      if (found === null) ts.forEachChild(node, search);
    };
    search(scope);
    return found;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'invoke'
    ) {
      const command = node.arguments[0];
      if (!command || !ts.isStringLiteralLike(command)) {
        throw new Error('invoke() must use a string literal command name');
      }
      const keys: string[] = [];
      const spreadSchemas: string[] = [];
      const payload = node.arguments[1];
      if (payload && ts.isObjectLiteralExpression(payload)) {
        for (const property of payload.properties) {
          if (ts.isPropertyAssignment(property)) {
            keys.push(property.name.getText(sourceFile).replaceAll(/['"]/gu, ''));
          } else if (ts.isShorthandPropertyAssignment(property)) {
            keys.push(property.name.text);
          } else if (ts.isSpreadAssignment(property)) {
            const variable = property.expression.getText(sourceFile);
            let scope: ts.Node = node.parent;
            while (
              scope.parent
              && !ts.isBlock(scope)
              && !ts.isSourceFile(scope)
              && !ts.isFunctionLike(scope)
            ) {
              scope = scope.parent;
            }
            const schema = schemaForVariable(scope, variable);
            if (!schema) {
              throw new Error(
                `invoke('${command.text}') spreads unknown payload ${variable}`,
              );
            }
            spreadSchemas.push(schema);
          }
        }
      }
      calls.push({ command: command.text, keys, spreadSchemas });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function schemaKeys(schemaName: string): string[] {
  const schema = (contracts as unknown as Record<string, unknown>)[schemaName] as
    | { shape?: Record<string, unknown> }
    | undefined;
  if (!schema?.shape) {
    throw new Error(`contracts.${schemaName} is not an object schema`);
  }
  return Object.keys(schema.shape);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readRepoFile(path)) as Record<string, unknown>;
}

describe('Tauri command surface', () => {
  const manifestCommands = parseManifestCommands();
  const handlerCommands = parseHandlerCommands();
  const functions = parseCommandFunctions();
  const capability = readJson('src-tauri/capabilities/main.json');
  const generatedCapability = readJson('src-tauri/gen/schemas/capabilities.json');
  const acl = readJson('src-tauri/gen/schemas/acl-manifests.json');

  it('keeps the manifest, invoke handler, and command functions in lockstep', () => {
    expect(manifestCommands).toHaveLength(32);
    expect(new Set(manifestCommands).size).toBe(manifestCommands.length);
    expect(handlerCommands).toEqual(manifestCommands);

    const functionNames = functions.map(({ name }) => name).toSorted();
    expect(functionNames).toEqual([...manifestCommands].toSorted());
    expect(new Set(functionNames).size).toBe(functionNames.length);
  });

  it('registers every command with one allow and one deny permission', () => {
    const expectedAllows = manifestCommands.map(
      (command) => `allow-${command.replaceAll('_', '-')}`,
    );
    const permissions = capability.permissions as string[];
    expect(permissions).toEqual([
      ...expectedAllows,
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ]);
    expect(new Set(permissions).size).toBe(permissions.length);

    const generated = generatedCapability.main as {
      identifier: string;
      windows: string[];
      permissions: string[];
    };
    expect(generated.identifier).toBe('main');
    expect(generated.windows).toEqual(['main']);
    expect(generated.permissions).toEqual(permissions);

    const tauri = readJson('src-tauri/tauri.conf.json') as {
      app: { windows: Array<{ label: string }>; security: { capabilities: string[] } };
    };
    expect(tauri.app.security.capabilities).toEqual(['main']);
    expect(tauri.app.windows.map(({ label }) => label)).toEqual(generated.windows);
  });

  it('keeps autogenerated permission files, ACL manifest, and schema in sync', () => {
    const appAcl = acl['__app-acl__'] as {
      permissions: Record<string, {
        commands: { allow: string[]; deny: string[] };
      }>;
    };
    const expectedIdentifiers = manifestCommands
      .flatMap((command) => [
        `allow-${command.replaceAll('_', '-')}`,
        `deny-${command.replaceAll('_', '-')}`,
      ])
      .toSorted();
    expect(Object.keys(appAcl.permissions).toSorted()).toEqual(expectedIdentifiers);

    const directory = join(repoRoot, 'src-tauri/permissions/autogenerated');
    const permissionFiles = readdirSync(directory)
      .filter((name) => name.endsWith('.toml'))
      .map((name) => name.replace(/\.toml$/u, ''))
      .toSorted();
    expect(permissionFiles).toEqual([...manifestCommands].toSorted());

    for (const command of manifestCommands) {
      const source = readFileSync(join(directory, `${command}.toml`), 'utf8');
      const allowId = `allow-${command.replaceAll('_', '-')}`;
      const denyId = `deny-${command.replaceAll('_', '-')}`;
      expect(source).toContain(`identifier = "${allowId}"`);
      expect(source).toContain(`identifier = "${denyId}"`);
      expect(source).toContain(`commands.allow = ["${command}"]`);
      expect(source).toContain(`commands.deny = ["${command}"]`);
      expect(appAcl.permissions[allowId].commands).toEqual({
        allow: [command],
        deny: [],
      });
      expect(appAcl.permissions[denyId].commands).toEqual({
        allow: [],
        deny: [command],
      });
    }

    const schema = readJson('src-tauri/gen/schemas/desktop-schema.json') as {
      definitions: { Identifier: { oneOf: Array<{ const: string }> } };
    };
    const identifiers = schema.definitions.Identifier.oneOf.map(({ const: id }) => id);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const identifier of expectedIdentifiers) {
      expect(identifiers).toContain(identifier);
    }
  });

  it('matches CoreClient invoke payloads to Rust command parameters', () => {
    const calls = parseInvokeCalls();
    const callNames = calls.map(({ command }) => command).toSorted();
    expect(callNames).toEqual([...manifestCommands].toSorted());

    const byName = new Map(functions.map((command) => [command.name, command]));
    for (const call of calls) {
      const rust = byName.get(call.command);
      expect(rust, `${call.command} must have a Rust command function`).toBeDefined();
      const rustParams = (rust?.payloadParams ?? [])
        .map((param) => snakeToCamel(param))
        .toSorted();
      const payloadKeys = [
        ...call.keys,
        ...call.spreadSchemas.flatMap(schemaKeys),
      ].toSorted();
      expect(
        payloadKeys,
        `${call.command} invoke payload must match the Rust signature`,
      ).toEqual(rustParams);
    }
  });

  it('subscribes to every emitted event with the matching capability', () => {
    const libSource = readRepoFile('src-tauri/src/lib.rs');
    const connectionSource = readRepoFile('src-tauri/src/commands/connection.rs');
    const emitted = new Set([
      ...[...libSource.matchAll(/\.emit\(\s*"([^"]+)"/gu)].map(([, name]) => name),
      ...[...connectionSource.matchAll(/\.emit\(\s*\n?\s*"([^"]+)"/gu)]
        .map(([, name]) => name),
    ]);
    const subscribed = new Set(
      [...readRepoFile('apps/desktop/src/api/core.ts').matchAll(
        /\blisten\(\s*'([^']+)'/gu,
      )].map(([, name]) => name),
    );
    expect([...emitted].toSorted()).toEqual([...subscribed].toSorted());
    expect(emitted.size).toBeGreaterThan(0);

    const permissions = capability.permissions as string[];
    if (subscribed.size > 0) {
      expect(permissions).toContain('core:event:allow-listen');
      expect(permissions).toContain('core:event:allow-unlisten');
    }
  });

  it('does not reintroduce removed OpsPilot command prefixes', () => {
    for (const command of manifestCommands) {
      expect(command).not.toMatch(
        /^(agent|audit|model_profile|nginx|operation|project|task)_/u,
      );
    }
  });
});
