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
  result: { schema: string | null; shape: 'array' | 'single' | 'void' };
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
  payloadTypes: Record<string, string>;
  returnType: string;
}

function rustFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...rustFiles(path));
    else if (entry.name.endsWith('.rs')) files.push(path);
  }
  return files;
}

function parseCommandFunctions(): RustCommand[] {
  const directory = join(repoRoot, 'src-tauri/src/commands');
  const commands: RustCommand[] = [];
  for (const path of rustFiles(directory)) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /#\[tauri::command\]\s*pub\(crate\)\s+(?:async\s+)?fn\s+(\w+)\s*\(([\s\S]*?)\)\s*->\s*([\s\S]*?)\s*\{/gu,
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
        payloadTypes: Object.fromEntries(
          params
            .filter(({ type }) => (
              !injected.has(type.split('<')[0].trim())
              && !injectedPath.test(type)
            ))
            .map(({ name, type }) => [name, type]),
        ),
        returnType: match[3].replaceAll(/\s+/gu, ' ').trim(),
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

  const resultSchemaFor = (
    node: ts.Node,
  ): { schema: string | null; shape: 'array' | 'single' | 'void' } => {
    let current: ts.Node = node;
    while (current.parent) {
      const parent: ts.Node = current.parent;
      if (
        ts.isCallExpression(parent)
        && ts.isPropertyAccessExpression(parent.expression)
        && parent.expression.name.text === 'parse'
        && parent.arguments.some((argument) => argument === current)
      ) {
        const receiver = parent.expression.expression.getText(sourceFile);
        const schema = /\b(\w+Schema)\b/u.exec(receiver)?.[1];
        return {
          schema: schema ? schemaImports.get(schema) ?? schema : null,
          shape: /\.array\(\)$/u.test(receiver) ? 'array' : 'single',
        };
      }
      current = parent;
    }
    return { schema: null, shape: 'void' };
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
      calls.push({
        command: command.text,
        keys,
        spreadSchemas,
        result: resultSchemaFor(node),
      });
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

interface ReturnContract {
  schema: string | null;
  shape: 'array' | 'single' | 'void';
}

const EXPECTED_RETURN_SCHEMAS: Record<string, ReturnContract> = {
  CoreHealth: { schema: 'CoreHealthSchema', shape: 'single' },
  'Result<CoreHealth, CoreError>': { schema: 'CoreHealthSchema', shape: 'single' },
  'Result<String, CoreError>': { schema: 'ClipboardTextSchema', shape: 'single' },
  'Result<Vec<Server>, CoreError>': { schema: 'ServerSchema', shape: 'array' },
  'Result<Server, CoreError>': { schema: 'ServerSchema', shape: 'single' },
  'Result<ServerSaveOutcome, CoreError>': {
    schema: 'ServerSaveOutcomeSchema',
    shape: 'single',
  },
  'Result<ServerDeleteOutcome, CoreError>': {
    schema: 'ServerDeleteOutcomeSchema',
    shape: 'single',
  },
  'Result<Vec<opspilot_domain::ServerGroup>, CoreError>': {
    schema: 'GroupSchema',
    shape: 'array',
  },
  'Result<opspilot_domain::ServerGroup, CoreError>': {
    schema: 'GroupSchema',
    shape: 'single',
  },
  'Result<ConnectOutcome, CoreError>': {
    schema: 'ConnectOutcomeSchema',
    shape: 'single',
  },
  'Result<TerminalSession, CoreError>': {
    schema: 'TerminalSessionSchema',
    shape: 'single',
  },
  'Result<Vec<RemoteFileEntry>, CoreError>': {
    schema: 'RemoteFileListSchema',
    shape: 'single',
  },
  'Result<RemoteTextFile, CoreError>': {
    schema: 'RemoteTextFileSchema',
    shape: 'single',
  },
  'Result<RemoteFileWriteResult, CoreError>': {
    schema: 'RemoteFileWriteResultSchema',
    shape: 'single',
  },
  'Result<RemoteFileDownload, CoreError>': {
    schema: 'RemoteDownloadSchema',
    shape: 'single',
  },
  'Result<RemoteUploadOutcome, CoreError>': {
    schema: 'RemoteUploadOutcomeSchema',
    shape: 'single',
  },
  'Result<RemoteFileMutationResult, CoreError>': {
    schema: 'RemoteFileMutationResultSchema',
    shape: 'single',
  },
  'Result<RemoteRenameResult, CoreError>': {
    schema: 'RemoteRenameResultSchema',
    shape: 'single',
  },
  'Result<DockerContainerList, CoreError>': {
    schema: 'DockerContainerListSchema',
    shape: 'single',
  },
  'Result<DockerLogs, CoreError>': {
    schema: 'DockerLogsSchema',
    shape: 'single',
  },
  'Result<MonitorSnapshot, CoreError>': {
    schema: 'MonitorSnapshotSchema',
    shape: 'single',
  },
  'Result<SshConfigImportPreview, CoreError>': {
    schema: 'SshConfigImportPreviewSchema',
    shape: 'single',
  },
  'Result<SshConfigImportResult, CoreError>': {
    schema: 'SshConfigImportResultSchema',
    shape: 'single',
  },
  'Result<(), CoreError>': { schema: null, shape: 'void' },
};

const EXPECTED_PARAMETER_TYPES: Record<string, Record<string, string>> = {
  server_create: {
    input: 'ServerInput',
    credential: 'ServerCredentialInput',
  },
  server_update: {
    id: 'Id',
    input: 'ServerInput',
    credential: 'Option<ServerCredentialInput>',
  },
  connection_connect: { server_id: 'Id' },
  connection_trust_host_key: { server_id: 'Id', verification_id: 'Id' },
  connection_disconnect: { connection: 'ConnectionHandle' },
  terminal_open: { connection: 'ConnectionHandle', columns: 'u32', rows: 'u32' },
  terminal_write: {
    connection: 'ConnectionHandle',
    terminal_session_id: 'Id',
    bytes: 'Vec<u8>',
  },
  terminal_resize: {
    connection: 'ConnectionHandle',
    terminal_session_id: 'Id',
    columns: 'u32',
    rows: 'u32',
  },
  terminal_close: { connection: 'ConnectionHandle', terminal_session_id: 'Id' },
  file_write: {
    connection: 'ConnectionHandle',
    path: 'RemotePath',
    content: 'String',
    expected_sha256: 'String',
  },
  file_upload: {
    connection: 'ConnectionHandle',
    directory: 'RemoteDirectoryPath',
    files: 'Vec<RemoteUploadFile>',
  },
  docker_logs: {
    connection: 'ConnectionHandle',
    container_id: 'String',
    tail: 'u32',
  },
  docker_exec: {
    connection: 'ConnectionHandle',
    container_id: 'String',
    shell: 'Option<DockerShell>',
    columns: 'u32',
    rows: 'u32',
  },
  monitor_snapshot: { connection: 'ConnectionHandle' },
  ssh_config_import_apply: { input: 'SshConfigImportApplyInput' },
};

describe('Tauri command surface', () => {
  const manifestCommands = parseManifestCommands();
  const handlerCommands = parseHandlerCommands();
  const functions = parseCommandFunctions();
  const capability = readJson('src-tauri/capabilities/main.json');
  const generatedCapability = readJson('src-tauri/gen/schemas/capabilities.json');
  const acl = readJson('src-tauri/gen/schemas/acl-manifests.json');

  it('keeps the manifest, invoke handler, and command functions in lockstep', () => {
    expect(manifestCommands).toHaveLength(33);
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
    expect(identifiers.filter((identifier) => !identifier.startsWith('core:')))
      .toEqual(expectedIdentifiers);
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

      const expectedTypes = EXPECTED_PARAMETER_TYPES[call.command];
      if (expectedTypes) {
        for (const [param, type] of Object.entries(expectedTypes)) {
          expect(
            rust?.payloadTypes[param],
            `${call.command}(${param}) Rust type`,
          ).toBe(type);
        }
      }
      for (const [param, type] of Object.entries(rust?.payloadTypes ?? {})) {
        expect(
          type,
          `${call.command}(${param}) must have a recognized Rust type`,
        ).toMatch(
          /^(?:Id|String|u8|u16|u32|u64|usize|i32|i64|bool|Vec<[^<>]+>|Option<[^<>]+>|ServerInput|ServerCredentialInput|GroupInput|ConnectionHandle|RemotePath|RemoteDirectoryPath|RemoteUploadFile|DockerAction|DockerShell|SshConfigImportApplyInput)$/u,
        );
      }

      expect(
        rust?.returnType,
        `${call.command} return type must be in the contract map`,
      ).toBeDefined();
      expect(
        call.result,
        `${call.command} must parse the Rust return type with the matching schema`,
      ).toStrictEqual(EXPECTED_RETURN_SCHEMAS[rust?.returnType ?? '']);
    }
  });

  it('subscribes to every emitted event with the matching capability', () => {
    const sources = rustFiles(join(repoRoot, 'src-tauri/src'))
      .map((path) => readFileSync(path, 'utf8'));
    const emitted = new Set(
      sources.flatMap((source) => (
        [...source.matchAll(/\.emit\(\s*\n?\s*"([^"]+)"/gu)]
          .map(([, name]) => name)
      )),
    );
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
