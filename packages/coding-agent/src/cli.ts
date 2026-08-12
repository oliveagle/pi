#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

// process.title / process.env.PI_CODING_AGENT / process.emitWarning setup moved
// to packages/coding-agent/src/runtime/node-shim.ts to keep this entry scriptc-friendly
// (scriptc — TypeScript-to-native — does not yet lower assignment to import-namespace
// properties). Imported here so Node/Bun runtimes still apply the shim before main().

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

main(process.argv.slice(2));
