import { createContext, useContext } from 'react';

const DATABASE_NAME = 'harbor-command-history';
const DATABASE_VERSION = 1;
const STORE_NAME = 'commands';
const SERVER_INDEX = 'by_server';
const SERVER_TIME_INDEX = 'by_server_time';
const MAX_RESULTS = 50;

export interface CommandHistoryEntry {
  id?: number;
  serverId: string;
  command: string;
  executedAt: number;
}

export interface CommandHistoryStore {
  add(serverId: string, command: string): Promise<CommandHistoryEntry>;
  search(serverId: string, query: string, limit?: number): Promise<CommandHistoryEntry[]>;
}

export const CommandHistoryContext = createContext<CommandHistoryStore | null>(null);

export function useCommandHistory(): CommandHistoryStore {
  const history = useContext(CommandHistoryContext);
  if (!history) {
    throw new Error('CommandHistoryContext is missing');
  }
  return history;
}

export function createMemoryCommandHistory(
  now: () => number = Date.now,
): CommandHistoryStore {
  let entries: CommandHistoryEntry[] = [];
  let nextId = 1;
  return {
    add: async (serverId, command) => {
      const normalized = normalizeCommand(command);
      const entry = {
        id: nextId,
        serverId,
        command: normalized,
        executedAt: now(),
      };
      nextId += 1;
      entries = [...entries, entry];
      return { ...entry };
    },
    search: async (serverId, query, limit = MAX_RESULTS) => (
      searchEntries(entries, serverId, query, limit)
    ),
  };
}

export function createIndexedDbCommandHistory(
  factory: IDBFactory = globalThis.indexedDB,
  now: () => number = Date.now,
): CommandHistoryStore {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const database = () => {
    databasePromise ??= openDatabase(factory);
    return databasePromise;
  };

  return {
    add: async (serverId, command) => {
      const normalized = normalizeCommand(command);
      const entry: CommandHistoryEntry = {
        serverId,
        command: normalized,
        executedAt: now(),
      };
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const request = transaction.objectStore(STORE_NAME).add(entry);
        request.onsuccess = () => {
          entry.id = Number(request.result);
        };
        transaction.oncomplete = () => resolve({ ...entry });
        transaction.onerror = () => reject(
          transaction.error ?? new Error('无法写入命令历史'),
        );
        transaction.onabort = () => reject(
          transaction.error ?? new Error('无法写入命令历史'),
        );
      });
    },
    search: async (serverId, query, limit = MAX_RESULTS) => {
      const db = await database();
      const rows = await new Promise<CommandHistoryEntry[]>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const index = transaction.objectStore(STORE_NAME).index(SERVER_INDEX);
        const request = index.getAll(IDBKeyRange.only(serverId));
        request.onsuccess = () => resolve(request.result as CommandHistoryEntry[]);
        request.onerror = () => reject(
          request.error ?? new Error('无法读取命令历史'),
        );
      });
      return searchEntries(rows, serverId, query, limit);
    },
  };
}

export function createDefaultCommandHistory(): CommandHistoryStore {
  if (typeof globalThis.indexedDB === 'undefined') {
    return createMemoryCommandHistory();
  }
  const fallback = createMemoryCommandHistory();
  const primary = createIndexedDbCommandHistory();
  return {
    add: async (serverId, command) => {
      try {
        return await primary.add(serverId, command);
      } catch {
        return fallback.add(serverId, command);
      }
    },
    search: async (serverId, query, limit) => {
      try {
        return await primary.search(serverId, query, limit);
      } catch {
        return fallback.search(serverId, query, limit);
      }
    },
  };
}

export function fuzzyCommandScore(query: string, candidate: string): number {
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  const haystack = candidate.toLocaleLowerCase('zh-CN');
  if (needle.length === 0) return 1;
  if (haystack === needle) return 10_000;
  const substringAt = haystack.indexOf(needle);
  if (substringAt >= 0) {
    return 5_000 - substringAt * 8 - (haystack.length - needle.length);
  }

  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let gaps = 0;
  for (let index = 0; index < haystack.length && queryIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = index;
    if (lastMatch >= 0) gaps += index - lastMatch - 1;
    lastMatch = index;
    queryIndex += 1;
  }
  if (queryIndex !== needle.length) return -1;
  return Math.max(
    1,
    1_000 - gaps * 10 - (lastMatch - firstMatch + 1) - (haystack.length - needle.length) / 4,
  );
}

function searchEntries(
  entries: CommandHistoryEntry[],
  serverId: string,
  query: string,
  limit: number,
): CommandHistoryEntry[] {
  return entries
    .filter((entry) => entry.serverId === serverId)
    .map((entry) => ({
      entry,
      score: fuzzyCommandScore(query, entry.command),
    }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => (
      right.score - left.score
      || right.entry.executedAt - left.entry.executedAt
    ))
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => ({ ...entry }));
}

function normalizeCommand(command: string): string {
  const normalized = command.trim();
  if (normalized.length === 0 || normalized.length > 4_096) {
    throw new Error('命令不能为空');
  }
  return normalized;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true,
          });
      if (!store) return;
      if (!store.indexNames.contains(SERVER_INDEX)) {
        store.createIndex(SERVER_INDEX, 'serverId');
      }
      if (!store.indexNames.contains(SERVER_TIME_INDEX)) {
        store.createIndex(SERVER_TIME_INDEX, ['serverId', 'executedAt']);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error('无法打开命令历史数据库'),
    );
    request.onblocked = () => reject(new Error('命令历史数据库被其他窗口占用'));
  });
}
