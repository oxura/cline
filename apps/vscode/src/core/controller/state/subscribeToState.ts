import type { EmptyRequest } from "@shared/proto/cline/common"
import type { State } from "@shared/proto/cline/state"
import { telemetryService } from "@/services/telemetry"
import type { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import type { StreamingResponseHandler } from "../grpc-handler"
import { getRequestRegistry } from "../grpc-handler"
import type { Controller } from "../index"

interface StateSubscription {
	responseStream: StreamingResponseHandler<State>
	delivering: boolean
	closed: boolean
	pendingStateJson?: string
}

const activeStateSubscriptions = new Set<StateSubscription>()

function closeSubscription(subscription: StateSubscription): void {
	subscription.closed = true
	subscription.pendingStateJson = undefined
	activeStateSubscriptions.delete(subscription)
}

async function deliverState(subscription: StateSubscription, stateJson: string): Promise<void> {
	if (subscription.closed) return
	subscription.pendingStateJson = stateJson
	if (subscription.delivering) return

	subscription.delivering = true
	try {
		while (!subscription.closed && subscription.pendingStateJson !== undefined) {
			const next = subscription.pendingStateJson
			subscription.pendingStateJson = undefined
			await subscription.responseStream({ stateJson: next }, false)
		}
	} catch (error) {
		Logger.error("Error sending state update:", error)
		closeSubscription(subscription)
	} finally {
		subscription.delivering = false
	}
}

/**
 * Subscribe to state updates
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	const subscription: StateSubscription = { responseStream, delivering: false, closed: false }
	activeStateSubscriptions.add(subscription)

	// Cancellation discards the queued snapshot even if delivery is still blocked.
	const cleanup = () => closeSubscription(subscription)

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// Send the initial state
	const initialState = await controller.getStateToPostToWebview()
	const initialStateJson = JSON.stringify(initialState)

	recordStateSizeTelemetry(Buffer.byteLength(initialStateJson, "utf8"))

	await deliverState(subscription, initialStateJson)
}

/**
 * Send a state update to all active subscribers
 * @param state The state to send
 */
export async function sendStateUpdate(state: ExtensionState): Promise<void> {
	let stateJson: string
	try {
		stateJson = JSON.stringify(state)
	} catch (error) {
		Logger.error("Error serializing state update:", error)
		return
	}

	recordStateSizeTelemetry(Buffer.byteLength(stateJson, "utf8"))

	// Delivery remains fire-and-forget: a hidden or disconnected webview must not
	// block the producer. Keep one in-flight write and only the newest queued
	// snapshot per subscriber; stateVersion/epoch make intermediate states redundant.
	for (const subscription of activeStateSubscriptions) {
		void deliverState(subscription, stateJson)
	}
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")
}
