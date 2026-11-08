/**
 * The first three names below come from SPEC.md. The four `REPLAY_*` names
 * are the Replayer's own synthetic names, chosen so that they match no event
 * name the Collector's Normaliser maps or ignores, which leaves the `kind`
 * attribute the sender already wrote untouched. `REPLAY_API_ERROR` exists
 * only to keep the Kind-to-name record in `src/replayer/plan.ts` total: the
 * Claude Code Transcript parser emits no `api_error` Event today.
 */
export const MCP_SERVER_CALL = 'mcp_server.call';
export const RUNNER_RUN_START = 'runner.run_start';
export const RUNNER_RUN_END = 'runner.run_end';

export const REPLAY_MODEL_CALL = 'replay.model_call';
export const REPLAY_TOOL_CALL = 'replay.tool_call';
export const REPLAY_PROMPT = 'replay.prompt';
export const REPLAY_API_ERROR = 'replay.api_error';
