import { describe, expect, it } from 'vitest';

import * as contracts from '../../packages/contracts/src/index.ts';
import {
  classifyRustType,
  parseNumericConstants,
  parseRustItems,
  pascalToSnake,
  readRepoFile,
  renameVariant,
  serdeHasDefault,
  serdeRenameStyle,
  serdeSkipsNone,
  serdeTag,
  type RustField,
  type RustItem,
  unwrapOption,
} from './support/rust-source.ts';

const SOURCES = [
  'crates/domain/src/server.rs',
  'crates/domain/src/error.rs',
  'crates/ssh-core/src/terminal.rs',
  'crates/ssh-core/src/connection.rs',
  'crates/ssh-core/src/remote_files.rs',
  'crates/ssh-core/src/russh_backend.rs',
  'crates/remote-adapters/src/docker.rs',
  'crates/remote-adapters/src/monitor.rs',
  'crates/remote-adapters/src/linux.rs',
  'src-tauri/src/commands/catalog.rs',
  'src-tauri/src/commands/ssh_config_import.rs',
  'src-tauri/src/commands/health.rs',
  'src-tauri/src/commands/connection.rs',
] as const;

interface ZodNode {
  _def: {
    type: string;
    innerType?: ZodNode;
    shape?: Record<string, ZodNode>;
    catchall?: ZodNode;
    options?: ZodNode[];
    values?: string[];
    entries?: Record<string, string>;
    element?: ZodNode;
    valueType?: ZodNode;
    type_?: string;
  };
  shape?: Record<string, ZodNode>;
  isOptional(): boolean;
  isNullable(): boolean;
}

function zodNode(schema: unknown): ZodNode {
  return schema as ZodNode;
}

function unwrap(schema: ZodNode): { node: ZodNode; optional: boolean; nullable: boolean } {
  let node = schema;
  let optional = false;
  let nullable = false;
  for (let index = 0; index < 4; index += 1) {
    if (node._def.type === 'optional' && node._def.innerType) {
      optional = true;
      node = node._def.innerType;
      continue;
    }
    if (node._def.type === 'nullable' && node._def.innerType) {
      nullable = true;
      node = node._def.innerType;
      continue;
    }
    break;
  }
  return { node, optional, nullable };
}

function objectShape(schema: unknown): Record<string, ZodNode> {
  const shape = zodNode(schema).shape;
  if (!shape) throw new Error('Expected a Zod object schema');
  return shape;
}

function zodKind(schema: ZodNode): string {
  const { node } = unwrap(schema);
  return node._def.type;
}

function enumValues(schema: ZodNode): string[] {
  const { node } = unwrap(schema);
  return node._def.options ?? node._def.entries ? Object.keys(node._def.entries ?? {}) : [];
}

function strictObject(schema: unknown): boolean {
  return zodNode(schema)._def.catchall?._def.type === 'never';
}

const allItems = SOURCES.flatMap((file) => parseRustItems(readRepoFile(file), file));
const itemByName = new Map(allItems.map((item) => [item.name, item]));
const structNames = new Set(
  allItems.filter((item) => item.kind === 'struct').map((item) => item.name),
);
const enumNames = new Set(
  allItems.filter((item) => item.kind === 'enum').map((item) => item.name),
);

function requireItem(name: string): RustItem {
  const item = itemByName.get(name);
  if (!item) throw new Error(`Rust item ${name} was not parsed`);
  return item;
}

function serdeFields(item: RustItem): Array<{ json: string; field: RustField }> {
  const style = serdeRenameStyle(item);
  return item.fields.map((field) => ({
    json: style === 'camelCase' ? snakeToCamel(field.name) : field.name,
    field,
  }));
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/gu, (_, character: string) => character.toUpperCase());
}

function expectRustMatchesZod(
  rustName: string,
  schemaName: string,
  options: { nullableFields?: string[]; optionalFields?: string[] } = {},
) {
  const rust = requireItem(rustName);
  const schema = (contracts as unknown as Record<string, unknown>)[schemaName];
  if (!schema) throw new Error(`contracts.${schemaName} is missing`);
  const shape = objectShape(schema);
  const rustFields = serdeFields(rust);
  const rustJsonNames = rustFields.map(({ json }) => json).toSorted();
  expect(rustJsonNames, `${rustName} fields`).toEqual(Object.keys(shape).toSorted());
  expect(strictObject(schema), `${schemaName} must reject unknown keys`).toBe(true);

  for (const { json, field } of rustFields) {
    const zodField = shape[json];
    const shapeOfField = unwrap(zodField);
    const rustType = classifyRustType(field.type, structNames, enumNames);
    const optionalBySerde = serdeSkipsNone(field) || serdeHasDefault(field);
    const expectOptional = options.optionalFields?.includes(json) ?? optionalBySerde;
    const hasOption = unwrapOption(field.type) !== null;
    const declaredNullable = options.nullableFields?.includes(json);
    if (serdeSkipsNone(field)) {
      expect(
        shapeOfField.optional,
        `${rustName}.${field.name} must be optional when skipped`,
      ).toBe(true);
    } else if (declaredNullable === true) {
      expect(
        shapeOfField.nullable,
        `${rustName}.${field.name} nullable mismatch`,
      ).toBe(true);
    } else if (declaredNullable === false) {
      expect(
        shapeOfField.nullable,
        `${rustName}.${field.name} nullable mismatch`,
      ).toBe(false);
    } else if (hasOption && !serdeSkipsNone(field) && !serdeHasDefault(field)) {
      expect(
        shapeOfField.nullable,
        `${rustName}.${field.name} nullable mismatch`,
      ).toBe(true);
    }
    expect(
      shapeOfField.optional,
      `${rustName}.${field.name} optional mismatch`,
    ).toBe(expectOptional);

    switch (rustType.kind) {
      case 'string':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toMatch(/^(string|pipe)$/u);
        break;
      case 'number':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toBe('number');
        break;
      case 'boolean':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toBe('boolean');
        break;
      case 'bytes':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toBe('array');
        break;
      case 'array':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toBe('array');
        break;
      case 'object':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toBe('object');
        break;
      case 'enum':
        expect(zodKind(zodField), `${rustName}.${field.name}`).toBe('enum');
        break;
      default:
        throw new Error(
          `${rustName}.${field.name} has unmapped Rust type ${field.type}`,
        );
    }
  }
}

describe('Rust DTO ↔ Zod contract', () => {
  it('keeps catalog and health DTOs aligned with the frontend schemas', () => {
    expectRustMatchesZod('Server', 'ServerSchema', {
      nullableFields: ['secretRef', 'groupId'],
    });
    expectRustMatchesZod('ServerGroup', 'GroupSchema');
    expectRustMatchesZod('ServerInput', 'ServerInputSchema', {
      optionalFields: ['groupId'],
    });
    expectRustMatchesZod('ServerCredentialInput', 'ServerCredentialInputSchema');
    expectRustMatchesZod('GroupInput', 'GroupInputSchema');
    expectRustMatchesZod('CoreHealth', 'CoreHealthSchema');
    expectRustMatchesZod('CoreError', 'CoreErrorSchema');
  });

  it('keeps connection and terminal DTOs aligned with the frontend schemas', () => {
    expectRustMatchesZod('ConnectionHandle', 'ConnectionHandleSchema');
    expectRustMatchesZod('HostKeyPrompt', 'HostKeyPromptSchema');
    expectRustMatchesZod('HostKeyChangedPrompt', 'HostKeyChangedPromptSchema');
    expectRustMatchesZod('TerminalSession', 'TerminalSessionSchema');
    expectRustMatchesZod('TerminalData', 'TerminalDataSchema');
    expectRustMatchesZod('TerminalGap', 'TerminalGapSchema');
    expectRustMatchesZod('TerminalClosed', 'TerminalClosedSchema', {
      optionalFields: ['exitStatus'],
    });
  });

  it('keeps file DTOs aligned with the frontend schemas', () => {
    expectRustMatchesZod('RemoteFileEntry', 'RemoteFileEntrySchema', {
      optionalFields: ['modifiedAt', 'permissions'],
    });
    expectRustMatchesZod('RemoteTextFile', 'RemoteTextFileSchema', {
      optionalFields: ['modifiedAt'],
    });
    expectRustMatchesZod('RemoteFileWriteResult', 'RemoteFileWriteResultSchema', {
      optionalFields: ['modifiedAt', 'warning'],
    });
    expectRustMatchesZod('RemoteFileDownload', 'RemoteDownloadSchema');
    expectRustMatchesZod('RemoteUploadFile', 'RemoteUploadFileSchema');
    expectRustMatchesZod('RemoteUploadOutcome', 'RemoteUploadOutcomeSchema', {
      optionalFields: ['warning', 'error'],
    });
    expectRustMatchesZod('RemoteRenameResult', 'RemoteRenameResultSchema', {
      optionalFields: ['warning', 'error'],
    });
    expectRustMatchesZod('RemoteFileMutationResult', 'RemoteFileMutationResultSchema', {
      optionalFields: ['warning'],
    });
  });

  it('keeps monitor and Docker DTOs aligned with the frontend schemas', () => {
    expectRustMatchesZod('ProcessMetric', 'MonitorProcessSchema');
    expectRustMatchesZod('MonitorSnapshot', 'MonitorSnapshotSchema', {
      optionalFields: ['cpuPercent', 'memory', 'disk', 'load', 'uptimeSeconds'],
    });
    expectRustMatchesZod('DockerContainer', 'DockerContainerSchema', {
      nullableFields: ['startedAt'],
    });
    expectRustMatchesZod('DockerContainerList', 'DockerContainerListSchema', {
      nullableFields: ['startedAtWarning'],
    });
    expectRustMatchesZod('DockerLogs', 'DockerLogsSchema');
  });

  it('keeps SSH Config import DTOs aligned with the frontend schemas', () => {
    expectRustMatchesZod('SshConfigImportWarning', 'SshConfigImportWarningSchema');
    expectRustMatchesZod('SshConfigImportItem', 'SshConfigImportItemSchema', {
      nullableFields: ['identityFile'],
    });
    expectRustMatchesZod('SshConfigImportPreview', 'SshConfigImportPreviewSchema');
    expectRustMatchesZod('SshConfigImportApplyInput', 'SshConfigImportApplyInputSchema');
    expectRustMatchesZod('SshConfigImportResult', 'SshConfigImportResultSchema');
  });

  it('serializes Rust enum variants to the same strings the Zod enums accept', () => {
    const mappings: Array<[string, string]> = [
      ['AuthType', 'ServerAuthTypeSchema'],
      ['CoreErrorCode', 'CoreErrorCodeSchema'],
      ['RemoteFileKind', 'RemoteFileKindSchema'],
      ['UploadBatchStatus', 'UploadBatchStatusSchema'],
      ['RenameStatus', 'RenameStatusSchema'],
      ['TerminalCloseReason', 'TerminalCloseReasonSchema'],
      ['DockerAction', 'DockerActionSchema'],
      ['DockerShell', 'DockerShellSchema'],
      ['MonitorUnavailable', 'MonitorUnavailableSchema'],
      ['SshConfigImportStatus', 'SshConfigImportStatusSchema'],
    ];
    for (const [rustName, schemaName] of mappings) {
      const rust = requireItem(rustName);
      expect(rust.kind, `${rustName} must be an enum`).toBe('enum');
      const style = serdeRenameStyle(rust);
      expect(style, `${rustName} must declare serde(rename_all)`).not.toBeNull();
      const rustValues = rust.variants
        .map((variant) => renameVariant(variant.name, style ?? 'camelCase'))
        .toSorted();
      const schema = (contracts as unknown as Record<string, unknown>)[schemaName];
      if (!schema) throw new Error(`contracts.${schemaName} is missing`);
      expect(enumValues(zodNode(schema)).toSorted(), schemaName).toEqual(rustValues);
    }
  });

  it('serializes tagged Rust enums with the same discriminator and variants', () => {
    const connect = requireItem('ConnectOutcome');
    expect(serdeTag(connect)).toBe('kind');
    const connectStyle = serdeRenameStyle(connect) ?? 'camelCase';
    const connectSchema = contracts.ConnectOutcomeSchema as unknown as {
      _def: { discriminator: string; options: Array<{ shape: Record<string, ZodNode> }> };
    };
    expect(connectSchema._def.discriminator).toBe('kind');
    expect(
      connectSchema._def.options
        .map((option) => option.shape.kind._def.values?.[0])
        .toSorted(),
    ).toEqual(
      connect.variants.map((variant) => renameVariant(variant.name, connectStyle)).toSorted(),
    );

    const state = requireItem('ConnectionState');
    expect(serdeTag(state)).toBe('kind');
    const stateStyle = serdeRenameStyle(state) ?? 'snake_case';
    const stateSchema = contracts.ConnectionStateEventSchema as unknown as {
      _def: { options: Array<{ shape: Record<string, ZodNode> }> };
    };
    const zodStates = stateSchema._def.options
      .map((option) => unwrap(option.shape.state).node)
      .map((node) => node._def.shape?.kind._def.values?.[0])
      .toSorted();
    const rustVariants = new Set(
      state.variants.map((variant) => renameVariant(variant.name, stateStyle)),
    );
    for (const variant of ['connecting', 'ready', 'closed', 'error']) {
      expect(rustVariants.has(variant), `ConnectionState.${variant}`).toBe(true);
    }
    expect(zodStates).toEqual(['closed', 'connecting', 'error', 'ready']);
  });

  it('accepts serde-shaped JSON for every catalog and file DTO', () => {
    const server = {
      id: '019c62b2-2970-7000-8000-000000000101',
      name: 'prod-web-01',
      host: 'prod.example.com',
      port: 22,
      user: 'deploy',
      authType: 'key',
      secretRef: null,
      favorite: true,
      createdAt: 1_699_000_000,
    };
    expect(contracts.ServerSchema.parse(server)).toEqual(server);
    expect(contracts.ServerSchema.safeParse({ ...server, tags: [] }).success).toBe(false);
    expect(contracts.ServerSchema.safeParse({
      ...server,
      secretRef: 'secret-ref',
      groupId: '019c62b2-2970-7000-8000-000000000102',
      lastConnectedAt: 1_699_000_100,
    }).success).toBe(true);
    expect(contracts.ServerSchema.safeParse({ ...server, port: 0 }).success).toBe(false);
    expect(contracts.ServerSchema.safeParse({ ...server, authType: 'agent' }).success).toBe(false);

    const group = { id: '019c62b2-2970-7000-8000-000000000102', name: '生产', sortOrder: 1 };
    expect(contracts.GroupSchema.parse(group)).toEqual(group);

    const health = {
      version: '0.1.0',
      databaseReady: true,
      secretStoreReady: false,
    };
    expect(contracts.CoreHealthSchema.parse(health)).toEqual(health);

    const error = { code: 'SSH_HOST_KEY_CHANGED', message: '指纹已变化', retryable: false };
    expect(contracts.CoreErrorSchema.parse(error)).toEqual(error);
    expect(contracts.CoreErrorSchema.safeParse({ ...error, code: 'HOST_KEY' }).success)
      .toBe(false);

    const entry = {
      name: 'app.conf',
      path: '/app.conf',
      kind: 'file',
      size: 6,
      modifiedAt: 1_700_000_100,
      permissions: 0o640,
    };
    expect(contracts.RemoteFileEntrySchema.parse(entry)).toEqual(entry);
    expect(contracts.RemoteFileEntrySchema.safeParse({
      ...entry,
      permissions: 0o10000,
    }).success).toBe(false);

    const textFile = {
      path: '/app.conf',
      text: 'hello\n',
      sha256: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
      size: 6,
      modifiedAt: 1_700_000_100,
    };
    expect(contracts.RemoteTextFileSchema.parse(textFile)).toEqual(textFile);
    expect(contracts.RemoteTextFileSchema.safeParse({ ...textFile, size: 7 }).success)
      .toBe(false);

    const writeResult = {
      path: '/app.conf',
      sha256: textFile.sha256,
      size: 6,
    };
    expect(contracts.RemoteFileWriteResultSchema.parse(writeResult)).toEqual(writeResult);

    const upload = {
      status: 'failed_with_residue',
      committed: ['/release.tmp'],
      residual: ['/release.tmp'],
      warning: '回滚未完全完成',
      error: { code: 'CONFLICT', message: '目标已存在', retryable: false },
    };
    expect(contracts.RemoteUploadOutcomeSchema.parse(upload)).toEqual(upload);
    expect(contracts.RemoteUploadOutcomeSchema.safeParse({
      ...upload,
      residual: [],
    }).success).toBe(false);

    const renamed = {
      status: 'partial',
      sourcePath: '/old.conf',
      targetPath: '/new.conf',
      targetCreated: true,
      error: { code: 'INTERNAL', message: '源文件删除失败', retryable: true },
    };
    expect(contracts.RemoteRenameResultSchema.parse(renamed)).toEqual(renamed);
    expect(contracts.RemoteRenameResultSchema.safeParse({
      ...renamed,
      targetPath: '/etc/new.conf',
    }).success).toBe(false);
  });

  it('accepts serde-shaped JSON for terminal, monitor, Docker, and import DTOs', () => {
    const handle = {
      serverId: '019c62b2-2970-7000-8000-000000000101',
      connectionId: '019c62b2-2970-7000-8000-000000000202',
    };
    expect(contracts.ConnectionHandleSchema.parse(handle)).toEqual(handle);

    expect(contracts.ConnectOutcomeSchema.parse({ kind: 'ready', connection: handle }))
      .toEqual({ kind: 'ready', connection: handle });
    expect(contracts.ConnectOutcomeSchema.parse({
      kind: 'hostKeyRequired',
      prompt: {
        verificationId: '019c62b2-2970-7000-8000-000000000201',
        algorithm: 'ssh-ed25519',
        sha256: 'SHA256:rendererFixtureHostKey',
        expiresAt: '2026-11-17T13:05:00.000Z',
      },
    }).kind).toBe('hostKeyRequired');

    const terminalData = {
      terminalSessionId: '019c62b2-2970-7000-8000-000000000301',
      sequence: 1,
      bytes: [104, 105],
    };
    expect(contracts.TerminalDataSchema.parse(terminalData)).toEqual(terminalData);
    expect(contracts.TerminalClosedSchema.parse({
      terminalSessionId: terminalData.terminalSessionId,
      reason: 'remoteExit',
      exitStatus: 0,
    }).reason).toBe('remoteExit');
    expect(contracts.TerminalClosedSchema.safeParse({
      terminalSessionId: terminalData.terminalSessionId,
      reason: 'remote_exit',
    }).success).toBe(false);

    const stateEvent = {
      serverId: handle.serverId,
      connectionId: handle.connectionId,
      sequence: 3,
      state: { kind: 'ready' },
    };
    expect(contracts.ConnectionStateEventSchema.parse(stateEvent)).toEqual(stateEvent);
    expect(contracts.ConnectionStateEventSchema.safeParse({
      ...stateEvent,
      state: { kind: 'connecting' },
    }).success).toBe(false);
    expect(contracts.ConnectionStateEventSchema.safeParse({
      serverId: handle.serverId,
      connectionId: null,
      sequence: 4,
      state: { kind: 'error', code: 'SSH_AUTHENTICATION', message: '认证失败', retryable: true },
    }).success).toBe(true);

    const snapshot = {
      timestamp: '2026-11-17T12:00:00.000Z',
      cpuPercent: 12.5,
      memory: { totalBytes: 1000, availableBytes: 400, usedBytes: 600 },
      disk: {
        filesystem: '/dev/disk1',
        totalBytes: 2000,
        usedBytes: 1000,
        availableBytes: 1000,
        mountPoint: '/',
      },
      load: { one: 0.2, five: 0.4, fifteen: 0.6 },
      uptimeSeconds: 3600,
      topProcesses: [{
        pid: 42,
        user: 'deploy',
        name: 'nginx worker',
        cpuPercent: 3.5,
        memoryPercent: 1.25,
      }],
      unavailable: ['cpu_warming_up'],
    };
    expect(contracts.MonitorSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(contracts.MonitorSnapshotSchema.safeParse({
      ...snapshot,
      disk: { ...snapshot.disk, mountPoint: '/home' },
    }).success).toBe(false);

    const container = {
      id: '0123456789ab',
      names: ['web'],
      image: 'nginx:alpine',
      state: 'running',
      status: 'Up 3 hours',
      ports: ['0.0.0.0:8080->80/tcp'],
      startedAt: '2026-11-17T12:00:00Z',
    };
    expect(contracts.DockerContainerSchema.parse(container)).toEqual(container);
    expect(contracts.DockerContainerListSchema.parse({
      containers: [container],
      startedAtWarning: null,
    }).containers).toHaveLength(1);
    expect(contracts.DockerLogsSchema.parse({
      containerId: container.id,
      tail: 500,
      stdout: 'request completed\n',
      stderr: '',
    }).tail).toBe(500);
    expect(contracts.DockerLogsSchema.safeParse({
      containerId: container.id,
      tail: 0,
      stdout: '',
      stderr: '',
    }).success).toBe(false);

    const preview = {
      previewId: '019c62b2-2970-7000-8000-000000000010',
      sourcePath: '~/.ssh/config',
      items: [{
        id: '019c62b2-2970-7000-8000-000000000011',
        alias: 'imported-prod',
        host: 'imported.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '~/.ssh/id_ed25519',
        status: 'ready',
        unsupportedDirectives: [],
        warnings: [],
      }],
      warnings: [],
      warningCount: 0,
      existingCount: 0,
      importableCount: 1,
    };
    expect(contracts.SshConfigImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(contracts.SshConfigImportPreviewSchema.safeParse({
      ...preview,
      items: [{ ...preview.items[0], status: 'importable' }],
    }).success).toBe(false);
  });

  it('keeps size limits in the frontend aligned with the Rust constants', () => {
    const remoteFiles = parseNumericConstants(
      readRepoFile('crates/ssh-core/src/remote_files.rs'),
    );
    const monitor = parseNumericConstants(
      readRepoFile('crates/remote-adapters/src/monitor.rs'),
    );
    const docker = readRepoFile('crates/remote-adapters/src/docker.rs');
    expect(remoteFiles.get('MAX_EDITABLE_FILE_BYTES')).toBe(
      contracts.MAX_EDITABLE_FILE_BYTES,
    );
    expect(remoteFiles.get('MAX_EDIT_WRITE_BYTES')).toBe(contracts.MAX_EDIT_WRITE_BYTES);
    expect(remoteFiles.get('FILE_DOWNLOAD_WARNING_BYTES')).toBe(
      contracts.FILE_DOWNLOAD_WARNING_BYTES,
    );
    expect(remoteFiles.get('MAX_FILE_DOWNLOAD_BYTES')).toBe(
      contracts.MAX_FILE_DOWNLOAD_BYTES,
    );
    expect(remoteFiles.get('FILE_UPLOAD_WARNING_BYTES')).toBe(
      contracts.FILE_UPLOAD_WARNING_BYTES,
    );
    expect(remoteFiles.get('MAX_FILE_UPLOAD_BYTES')).toBe(
      contracts.MAX_FILE_UPLOAD_BYTES,
    );
    expect(remoteFiles.get('MAX_UPLOAD_BATCH_BYTES')).toBe(
      contracts.MAX_UPLOAD_BATCH_BYTES,
    );
    expect(remoteFiles.get('MAX_UPLOAD_BATCH_FILES')).toBe(
      contracts.MAX_UPLOAD_BATCH_FILES,
    );
    expect(monitor.get('TOP_PROCESS_LIMIT')).toBe(10);
    expect(docker).toContain('if !(1..=1_000).contains(&tail)');
    expect(contracts.DockerLogsSchema.shape.tail.safeParse(1_000).success).toBe(true);
    expect(contracts.DockerLogsSchema.shape.tail.safeParse(1_001).success).toBe(false);
    expect(contracts.MonitorSnapshotSchema.shape.topProcesses.safeParse(
      Array.from({ length: 21 }, () => snapshotProcess()),
    ).success).toBe(false);
  });

  it('uses snake_case only for the enums that the UI consumes as strings', () => {
    const expected: Array<[string, string]> = [
      ['AuthType', 'snake_case'],
      ['RemoteFileKind', 'snake_case'],
      ['UploadBatchStatus', 'snake_case'],
      ['RenameStatus', 'snake_case'],
      ['MonitorUnavailable', 'snake_case'],
      ['CoreErrorCode', 'SCREAMING_SNAKE_CASE'],
      ['DockerAction', 'lowercase'],
      ['DockerShell', 'lowercase'],
    ];
    for (const [name, style] of expected) {
      expect(serdeRenameStyle(requireItem(name)), name).toBe(style);
    }
    for (const name of ['Server', 'RemoteTextFile', 'MonitorSnapshot', 'DockerContainer']) {
      expect(serdeRenameStyle(requireItem(name)), name).toBe('camelCase');
    }
    expect(pascalToSnake('SshConfigImportStatus')).toBe('ssh_config_import_status');
  });
});

function snapshotProcess() {
  return {
    pid: 1,
    user: 'root',
    name: 'init',
    cpuPercent: 0,
    memoryPercent: 0,
  };
}
