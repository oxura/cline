/**
 * Per-server MCP request timeout contract, in seconds.
 *
 * The `timeout` field in cline_mcp_settings.json is in SECONDS. Every client
 * (VSCode extension, CLI, JetBrains) resolves it through this module so all
 * apply the same default and bounds. Values above MAX are almost always a
 * milliseconds/seconds mix-up (e.g. `timeout: 60000` meaning 60s), so they
 * clamp instead of silently becoming hours.
 */
export const DEFAULT_MCP_TIMEOUT_SECONDS = 60; // matches Anthropic's default timeout in their MCP SDK
export const MIN_MCP_TIMEOUT_SECONDS = 1;
export const MAX_MCP_TIMEOUT_SECONDS = 3600;

export function isMcpTimeoutConfigured(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Clamp a timeout in seconds into [MIN_MCP_TIMEOUT_SECONDS, MAX_MCP_TIMEOUT_SECONDS].
 */
export function clampMcpTimeoutSeconds(value: number): number {
	return Math.min(
		Math.max(value, MIN_MCP_TIMEOUT_SECONDS),
		MAX_MCP_TIMEOUT_SECONDS,
	);
}

/**
 * Resolve a raw `timeout` value from MCP settings to seconds. Never throws:
 * missing or non-numeric values fall back to the default, so one malformed
 * field cannot take down a whole settings file.
 */
export function resolveMcpTimeoutSeconds(value: unknown): number {
	if (!isMcpTimeoutConfigured(value)) {
		return DEFAULT_MCP_TIMEOUT_SECONDS;
	}
	return clampMcpTimeoutSeconds(value);
}

export function formatMcpTimeoutErrorMessage(
	serverName: string,
	timeoutMs: number,
	method?: string,
): string {
	const methodText = method ? ` (${method})` : "";
	const seconds = Math.round(timeoutMs / 100) / 10;
	return (
		`MCP request to "${serverName}"${methodText} timed out after ${seconds}s. ` +
		`Increase the "timeout" field (in seconds) for this server in cline_mcp_settings.json.`
	);
}

const MCP_ROOT_SCHEMA_COMPOSITIONS = ["allOf", "anyOf", "oneOf"] as const;

function isMcpSchemaObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Follow only schemas that apply to the root argument object, not its children. */
function declaresRootTaskProgress(inputSchema: unknown): boolean {
	if (!isMcpSchemaObject(inputSchema)) return false;
	if (
		isMcpSchemaObject(inputSchema.properties) &&
		Object.hasOwn(inputSchema.properties, "task_progress")
	) {
		return true;
	}
	if (
		!Array.isArray(inputSchema.allOf) &&
		!Array.isArray(inputSchema.anyOf) &&
		!Array.isArray(inputSchema.oneOf) &&
		typeof inputSchema.$ref !== "string"
	) {
		return false;
	}

	const pending: unknown[] = [inputSchema];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const schema = pending.pop();
		if (!isMcpSchemaObject(schema) || visited.has(schema)) continue;
		visited.add(schema);
		if (
			isMcpSchemaObject(schema.properties) &&
			Object.hasOwn(schema.properties, "task_progress")
		) {
			return true;
		}
		for (const key of MCP_ROOT_SCHEMA_COMPOSITIONS) {
			const branches = schema[key];
			if (Array.isArray(branches)) {
				for (const branch of branches) pending.push(branch);
			}
		}
		if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#")) {
			continue;
		}
		let pointer: string;
		try {
			pointer = decodeURIComponent(schema.$ref.slice(1));
		} catch {
			continue;
		}
		if (pointer === "") {
			pending.push(inputSchema);
		} else if (pointer.startsWith("/")) {
			let target: unknown = inputSchema;
			for (const token of pointer.slice(1).split("/")) {
				const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
				if (
					target === null ||
					typeof target !== "object" ||
					!Object.hasOwn(target, key)
				) {
					target = undefined;
					break;
				}
				target = Reflect.get(target, key);
			}
			pending.push(target);
		}
	}
	return false;
}

/**
 * Focus-chain bookkeeping is not an MCP argument unless the tool declares it.
 * Keep the caller's object intact because local progress tracking may still use it.
 */
export function sanitizeMcpToolArguments(
	args: Record<string, unknown> | undefined,
	inputSchema: unknown,
): Record<string, unknown> | undefined {
	if (!args || !Object.hasOwn(args, "task_progress")) return args;
	if (declaresRootTaskProgress(inputSchema)) {
		return args;
	}
	const { task_progress: _taskProgress, ...serverArguments } = args;
	return serverArguments;
}
