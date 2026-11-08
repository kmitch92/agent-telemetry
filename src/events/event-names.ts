/**
 * The first three names below come from SPEC.md. The three `REPLAY_*` names
 * are the Replayer's own synthetic names, chosen so that they match no event
 * name the Collector's Normaliser maps or ignores, which leaves the `kind`
 * attribute the sender already wrote untouched.
 */
export const MCP_SERVER_CALL = 'mcp_server.call';
export const RUNNER_RUN_START = 'runner.run_start';
export const RUNNER_RUN_END = 'runner.run_end';

export const REPLAY_MODEL_CALL = 'replay.model_call';
export const REPLAY_TOOL_CALL = 'replay.tool_call';
export const REPLAY_PROMPT = 'replay.prompt';
