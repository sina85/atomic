import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ATOMIC_AI_AGENT } from "../utils/agent-attribution.ts";
import { readVersionOutput } from "../version-display.ts";
import { INTERNAL_INTERCOM_BROKER_ARG, importInternalIntercomBroker } from "./internal-intercom-broker.ts";

const APP_NAME = "atomic";

process.title = APP_NAME;
process.env.ATOMIC_CODING_AGENT = "true";
process.env.AI_AGENT = ATOMIC_AI_AGENT;
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);

if (args[0] === INTERNAL_INTERCOM_BROKER_ARG) {
	if (args.length !== 2) {
		console.error(`Atomic startup error: ${INTERNAL_INTERCOM_BROKER_ARG} requires exactly one broker module path`);
		process.exit(1);
	}
	void importInternalIntercomBroker(args[1]).catch((error: Error) => {
		console.error(`Atomic startup error: ${error.message}`);
		process.exit(1);
	});
} else {
	if (args[0] === "--version" || args[0] === "-v") {
		console.log(readVersionOutput(join(dirname(process.execPath), "package.json")));
		process.exit(0);
	}

	const appPath = join(dirname(process.execPath), "app.js");
	if (!existsSync(appPath)) {
		console.error(`Atomic startup error: missing app bundle at ${appPath}`);
		process.exit(1);
	}

	void import(pathToFileURL(appPath).href);
}
