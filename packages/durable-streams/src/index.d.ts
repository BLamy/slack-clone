export interface StreamReadResult<TRecord = unknown, TMessage = TRecord> {
  records: TRecord[];
  messages: TMessage[];
  nextOffset: string;
  streamDigest: string;
}

export interface StreamBatch<TRecord = unknown> {
  records: TRecord[];
  nextOffset: string;
  upToDate: boolean;
  streamClosed: boolean;
}

export interface FollowSession {
  readonly startOffset: string;
  readonly currentOffset: string;
  readonly closed: Promise<void>;
  cancel(reason?: unknown): void;
}

export interface DurableStreamsDiagnostics {
  appendCalls: number;
  boundedReads: number;
  createRequests: number;
  ensureCalls: number;
  followCalls: number;
  requests: number;
  sseRequests: number;
  longPollRequests: number;
  activeFollowers: number;
  pendingIdleWaiters: number;
  cachedStreams: number;
  requestsByMethod: Record<string, number>;
  responsesByStatus: Record<string, number>;
}

export interface DurableStreamsStore<TRecord = unknown, TMessage = TRecord> {
  ensure(roomId: string): Promise<unknown>;
  append(
    roomId: string,
    record: TRecord,
    options?: { signal?: AbortSignal },
  ): Promise<{ message: TRecord; nextOffset: string }>;
  read(
    roomId: string,
    offset?: string,
    options?: { signal?: AbortSignal },
  ): Promise<StreamReadResult<TRecord, TMessage>>;
  follow(
    roomId: string,
    offset: string,
    options: {
      onBatch(batch: StreamBatch<TRecord>): void | Promise<void>;
      signal?: AbortSignal;
      live?: "sse" | "long-poll";
    },
  ): Promise<FollowSession>;
  remove(roomId: string, options?: { signal?: AbortSignal }): Promise<void>;
  diagnostics(): DurableStreamsDiagnostics;
  close(): void;
}

export class DurableStreamsAdapterError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly finalOffset?: string;
}

export function createDurableStreamsStore<
  TRecord = unknown,
  TMessage = TRecord,
>(options: {
  baseUrl: string | URL;
  token: string;
  fetchFn: typeof fetch;
  digestRecords(records: TRecord[]): string;
  backoffOptions?: {
    initialDelay: number;
    maxDelay: number;
    multiplier: number;
    maxRetries?: number;
  };
}): DurableStreamsStore<TRecord, TMessage>;
