import { EventSchema, type Event } from '../schema/index.js';
import { createMonotonicNanoClock } from './clock.js';
import {
  buildLogsPayload,
  parseResourceAttributes,
  type LogsPayloadRecord,
  type OtlpLogsPayload,
} from './otlp-payload.js';

const SCOPE_NAME = 'agent-telemetry';
const SCOPE_VERSION = '0.1.0';

/**
 * Module-level once-only flag: shared by every sender created from one
 * module load, per SPEC.md's "write one line to standard error at the
 * first failure, then stay silent" rule. Tests that need a fresh flag use
 * `vi.resetModules()` and re-import this module.
 */
let hasWarned = false;

export interface SenderOptions {
  serviceName: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Nanoseconds. Defaults to a strictly increasing nanosecond clock. */
  now?: () => bigint;
  stderr?: { write: (line: string) => unknown };
  /** Default true. */
  installSignalHandlers?: boolean;
  /** Default 1000. */
  scheduledDelayMs?: number;
  /** Default 2000. */
  exportTimeoutMs?: number;
}

export interface OtlpSender {
  readonly enabled: boolean;
  emit(event: Event, eventName: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

function isFailureStatus(status: number): boolean {
  return status < 200 || status > 299;
}

/**
 * Fire-and-forget OTLP/HTTP log sender. When
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is absent or empty, the returned sender is
 * disabled: `emit` queues nothing, `flush` resolves at once, and no
 * network call or signal handler is ever created.
 */
export function createOtlpSender(options: SenderOptions): OtlpSender {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const enabled = endpoint !== undefined && endpoint !== '';

  if (!enabled) {
    return {
      enabled: false,
      emit: (): void => undefined,
      flush: (): Promise<void> => Promise.resolve(),
      shutdown: (): Promise<void> => Promise.resolve(),
    };
  }

  const serviceName = options.serviceName;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? createMonotonicNanoClock();
  const stderr = options.stderr ?? process.stderr;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const scheduledDelayMs = options.scheduledDelayMs ?? 1000;
  const exportTimeoutMs = options.exportTimeoutMs ?? 2000;

  const envAttributes = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const targetUrl = `${endpoint.replace(/\/+$/, '')}/v1/logs`;

  let queue: LogsPayloadRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Set<Promise<void>>();

  function warnOnce(message: string): void {
    if (hasWarned) {
      return;
    }
    hasWarned = true;
    stderr.write(`${message}\n`);
  }

  async function sendPayload(payload: OtlpLogsPayload): Promise<void> {
    try {
      const response = await fetchImpl(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(exportTimeoutMs),
      });
      if (isFailureStatus(response.status)) {
        warnOnce(
          `agent-telemetry: OTLP export to ${targetUrl} failed (status ${String(response.status)}); staying silent.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnOnce(`agent-telemetry: OTLP export to ${targetUrl} failed (${message}); staying silent.`);
    }
  }

  function drainAndExport(): void {
    if (queue.length === 0) {
      return;
    }
    const records = queue;
    queue = [];

    const payload = buildLogsPayload({
      serviceName,
      scopeName: SCOPE_NAME,
      scopeVersion: SCOPE_VERSION,
      records,
      envAttributes,
    });

    const exportPromise = sendPayload(payload);
    inFlight.add(exportPromise);
    void exportPromise.finally(() => {
      inFlight.delete(exportPromise);
    });
  }

  function scheduleExport(): void {
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      drainAndExport();
    }, scheduledDelayMs);
    timer.unref();
  }

  function emit(event: Event, eventName: string): void {
    const result = EventSchema.safeParse(event);
    if (!result.success) {
      warnOnce(
        `agent-telemetry: dropped an Event that failed schema validation (${result.error.message}).`,
      );
      return;
    }

    queue.push({
      event: result.data,
      eventName,
      timeUnixNano: now().toString(),
    });
    scheduleExport();
  }

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    drainAndExport();

    const pending = Promise.all(Array.from(inFlight)).then((): void => undefined);
    const timeout = new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, exportTimeoutMs);
      handle.unref();
    });
    await Promise.race([pending, timeout]);
  }

  let removeSignalHandlers = (): void => undefined;

  if (installSignalHandlers) {
    const handleSignal = (signal: NodeJS.Signals): void => {
      void flush().then(() => {
        process.off(signal, handleSignal);
        process.kill(process.pid, signal);
      });
    };
    const handleStdinClose = (): void => {
      void flush();
    };

    process.on('SIGTERM', handleSignal);
    process.on('SIGINT', handleSignal);
    process.stdin.on('end', handleStdinClose);
    process.stdin.on('close', handleStdinClose);

    removeSignalHandlers = (): void => {
      process.off('SIGTERM', handleSignal);
      process.off('SIGINT', handleSignal);
      process.stdin.off('end', handleStdinClose);
      process.stdin.off('close', handleStdinClose);
    };
  }

  async function shutdown(): Promise<void> {
    removeSignalHandlers();
    await flush();
  }

  return { enabled: true, emit, flush, shutdown };
}
