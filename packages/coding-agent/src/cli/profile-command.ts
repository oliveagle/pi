/**
 * CLI subcommand for managing pi profiles.
 *
 * Profiles are stored under `<agentDir>/profiles/<name>/` and the active
 * profile is recorded in `<agentDir>/.active-profile`.
 *
 * Usage:
 *   pi profile list          - list all available profiles (active is marked)
 *   pi profile current       - print the currently active profile name (if any)
 *   pi profile switch <name> - set <name> as the active profile for future runs
 *   pi profile unset         - clear the active profile (back to base agentDir)
 *   pi profile show [name]   - print the absolute path to a profile's agentDir
 */

import pc from "picocolors";
import { existsSync } from "fs";
import { join } from "path";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	getActiveProfilePath,
	getBaseAgentDir,
	getProfilesDir,
	listProfiles,
	readActiveProfileSync,
	setActiveProfile,
} from "../config.ts";

const PROFILE_COMMAND_USAGE = `${APP_NAME} profile <list|current|switch|unset|show>`;

function printProfileList(activeProfile: string | undefined): void {
	const profiles = listProfiles();
	if (profiles.length === 0) {
		console.log(pc.dim(`No profiles found. Create one under ${getProfilesDir()}/<name>/`));
		console.log(pc.dim(`Profiles store their own settings.json / auth.json / models.json.`));
		return;
	}
	console.log(pc.bold(`Profiles (${profiles.length}):`));
	for (const profile of profiles) {
		const isActive = profile === activeProfile;
		const marker = isActive ? pc.green(" * ") : "   ";
		const path = join(getProfilesDir(), profile);
		const exists = existsSync(path);
		const status = exists ? "" : pc.yellow(" (missing directory)");
		const label = isActive ? pc.green(profile) : profile;
		console.log(`${marker}${label}${status}`);
	}
	if (activeProfile && !profiles.includes(activeProfile)) {
		console.log(
			pc.yellow(
				`\nActive profile "${activeProfile}" is not in the profiles directory; using ${join(
					getProfilesDir(),
					activeProfile,
				)}.`,
			),
		);
	}
}

export async function handleProfileCommand(args: string[]): Promise<boolean> {
	const [subcommand, ...rest] = args;
	if (subcommand !== "profile") {
		return false;
	}

	const activeProfile = readActiveProfileSync(getBaseAgentDir());
	const [action, ...actionArgs] = rest;

	if (!action || action === "-h" || action === "--help") {
		console.log(`Usage: ${PROFILE_COMMAND_USAGE}
  list              List available profiles (marks the active one)
  current           Print the currently active profile name
  switch <name>     Make <name> the active profile for future runs
  unset             Clear the active profile so the base ${CONFIG_DIR_NAME}/agent dir is used
  show [name]       Print the absolute path to a profile's directory`);
		return true;
	}

	switch (action) {
		case "list": {
			printProfileList(activeProfile);
			return true;
		}

		case "current": {
			if (activeProfile) {
				console.log(activeProfile);
			} else {
				console.log(pc.dim(`(no active profile; using ${getBaseAgentDir()})`));
			}
			return true;
		}

		case "switch": {
			const target = actionArgs.find((arg) => !arg.startsWith("-"));
			if (!target) {
				console.error(pc.red(`Usage: ${APP_NAME} profile switch <name>`));
				console.error(pc.dim(`Tip: run "${APP_NAME} profile list" to see existing profiles.`));
				process.exitCode = 1;
				return true;
			}

			if (!/^[a-zA-Z0-9._-]+$/.test(target)) {
				console.error(
					pc.red(`Invalid profile name "${target}". Use letters, digits, dots, dashes, or underscores.`),
				);
				process.exitCode = 1;
				return true;
			}

			setActiveProfile(target);
			console.log(pc.green(`Active profile set to "${target}".`));
			console.log(pc.dim(`Marker: ${getActiveProfilePath()}`));
			console.log(pc.dim(`Profile dir: ${join(getProfilesDir(), target)}`));
			return true;
		}

		case "unset": {
			setActiveProfile(undefined);
			console.log(pc.green(`Cleared active profile. Future runs will use ${getBaseAgentDir()}.`));
			return true;
		}

		case "show": {
			const target = actionArgs.find((arg) => !arg.startsWith("-")) ?? activeProfile;
			if (!target) {
				console.error(pc.red("No profile specified and no active profile."));
				process.exitCode = 1;
				return true;
			}
			const dir = join(getProfilesDir(), target);
			console.log(dir);
			return true;
		}

		default: {
			console.error(pc.red(`Unknown subcommand "${action}" for "${APP_NAME} profile".`));
			console.error(pc.dim(`Usage: ${PROFILE_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}
}
