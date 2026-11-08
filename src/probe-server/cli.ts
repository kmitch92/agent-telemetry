import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOtlpSender } from '../events/otlp.js';
import { createProbeServer, PROBE_SERVICE_NAME } from './server.js';

const sender = createOtlpSender({ serviceName: PROBE_SERVICE_NAME });
const { server } = createProbeServer({ sender });

await server.connect(new StdioServerTransport());
