/**
 * Operator one-shot for the `stack` ticket.
 *
 * Sends exactly one Event through the OTLP sender so an operator can
 * confirm the Collector is reachable and ingesting.
 */
import { createOtlpSender } from '../src/events/otlp.js';
import type { PromptEvent } from '../src/schema/events.js';

const event: PromptEvent = {
  kind: 'prompt',
  agent: 'claude-code',
  session_id: 'compose-stack-test-0000-0000-0000-000000000001',
  project: 'agent-telemetry-00000000',
  prompt_length: 7,
};

async function main(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    process.stderr.write(
      'OTEL_EXPORTER_OTLP_ENDPOINT must be set, for example to http://localhost:4318\n',
    );
    process.exitCode = 1;
    return;
  }

  const sender = createOtlpSender({ serviceName: 'claude-code', installSignalHandlers: false });
  sender.emit(event, 'claude_code.user_prompt');
  await sender.flush();

  process.stdout.write(`sent one Event to ${endpoint} for session_id ${event.session_id}\n`);
}

await main();
