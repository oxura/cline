import { afterEach, describe, expect, it, vi } from "vitest"
import type { ExtensionState } from "@/shared/ExtensionMessage"
import type { Controller } from ".."
import { getRequestRegistry } from "../grpc-handler"
import { GrpcRequestRegistry } from "../grpc-request-registry"
import { sendStateUpdate, subscribeToState } from "./subscribeToState"

const registry = new GrpcRequestRegistry()
vi.mock("../grpc-handler", () => ({ getRequestRegistry: () => registry }))
vi.mock("@/services/telemetry", () => ({ telemetryService: { captureGrpcResponseSize: vi.fn() } }))

const controller = {
	getStateToPostToWebview: async () => ({ stateVersion: 0 }),
} as unknown as Controller

function state(stateVersion: number): ExtensionState {
	return { stateVersion } as ExtensionState
}

afterEach(() => {
	for (const [requestId] of getRequestRegistry().getAllRequests()) {
		getRequestRegistry().cancelRequest(requestId)
	}
})

describe("state stream backpressure", () => {
	it("coalesces a blocked subscriber to its newest state without blocking another subscriber", async () => {
		const gate = Promise.withResolvers<void>()
		const slow: number[] = []
		const fast: number[] = []
		await subscribeToState(
			controller,
			{},
			async (response) => {
				const version = JSON.parse(response.stateJson).stateVersion
				slow.push(version)
				if (version === 1) await gate.promise
			},
			"slow",
		)
		await subscribeToState(
			controller,
			{},
			async (response) => {
				fast.push(JSON.parse(response.stateJson).stateVersion)
			},
			"fast",
		)

		for (let version = 1; version <= 100; version++) await sendStateUpdate(state(version))
		expect(slow).toEqual([0, 1])
		expect(fast).toEqual(Array.from({ length: 101 }, (_, version) => version))
		gate.resolve()
		await vi.waitFor(() => expect(slow).toEqual([0, 1, 100]))
	})

	it("discards pending state when a blocked subscription is cancelled", async () => {
		const gate = Promise.withResolvers<void>()
		const delivered: number[] = []
		await subscribeToState(
			controller,
			{},
			async (response) => {
				const version = JSON.parse(response.stateJson).stateVersion
				delivered.push(version)
				if (version === 1) await gate.promise
			},
			"cancelled",
		)
		await sendStateUpdate(state(1))
		await sendStateUpdate(state(2))
		getRequestRegistry().cancelRequest("cancelled")
		gate.resolve()
		await sendStateUpdate(state(3))
		expect(delivered).toEqual([0, 1])
	})

	it("removes a failed stream instead of retrying queued snapshots", async () => {
		const gate = Promise.withResolvers<void>()
		const delivered: number[] = []
		await subscribeToState(
			controller,
			{},
			async (response) => {
				const version = JSON.parse(response.stateJson).stateVersion
				delivered.push(version)
				if (version === 1) await gate.promise
			},
			"failed",
		)
		await sendStateUpdate(state(1))
		await sendStateUpdate(state(2))
		gate.reject(new Error("stream disconnected"))
		await gate.promise.catch(() => {})
		await sendStateUpdate(state(3))
		expect(delivered).toEqual([0, 1])
	})
})
