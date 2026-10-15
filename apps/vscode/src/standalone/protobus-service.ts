import { randomUUID } from "node:crypto"
import { Controller } from "@core/controller"
import { getRequestRegistry, type StreamingResponseHandler } from "@core/controller/grpc-handler"
import { addProtobusServices } from "@generated/hosts/standalone/protobus-server-setup"
import * as grpc from "@grpc/grpc-js"

import { ReflectionService } from "@grpc/reflection"
import { GrpcHandler, GrpcStreamingResponseHandler } from "@hosts/external/grpc-types"
import * as health from "grpc-health-check"
import { getPackageDefinition, log } from "./utils"

export const PROTOBUS_PORT = 26040

export function startProtobusService(controller: Controller): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = new grpc.Server()

		// Set up health check.
		const healthImpl = new health.HealthImplementation({ "": "SERVING" })
		healthImpl.addToServer(server)

		// Add all the handlers for the ProtoBus services to the server.
		addProtobusServices(server, controller, wrapHandler, wrapStreamingResponseHandler)

		// Create reflection service with protobus service names
		const packageDefinition = getPackageDefinition()
		const reflection = new ReflectionService(packageDefinition, {
			services: getProtobusServiceNames(packageDefinition),
		})
		reflection.addToServer(server)

		// Start the server.
		const host = process.env.PROTOBUS_ADDRESS || `127.0.0.1:${PROTOBUS_PORT}`
		server.bindAsync(host, grpc.ServerCredentials.createInsecure(), (err) => {
			if (err) {
				log(`Could not start ProtoBus service: Failed to bind to ${host}, port may be unavailable. ${err.message}`)
				reject(new Error(`Failed to bind ProtoBus to ${host}: ${err.message}`))
				return
			}
			server.start()
			log(`ProtoBus gRPC server listening on ${host}`)
			resolve(host)
		})
	})
}

function getProtobusServiceNames(packageDefinition: { [x: string]: any }): string[] {
	// Filter service names to only include cline services
	const protobusServiceNames = Object.keys(packageDefinition).filter(
		(name) => name.startsWith("cline.") || name.startsWith("grpc.health"),
	)
	return protobusServiceNames
}

/**
 * Wraps a Promise-based handler function to make it compatible with gRPC's callback-based API.
 * This function converts an async handler that returns a Promise into a function that uses
 * the gRPC callback pattern.
 *
 * @template TRequest - The type of the request object
 * @template TResponse - The type of the response object
 * @param handler - The Promise-based handler function to wrap
 * @param controllerInstance - The controller instance to pass to the handler
 * @returns A gRPC-compatible callback-style handler function
 */
function wrapHandler<TRequest, TResponse>(
	handler: GrpcHandler<TRequest, TResponse>,
	controller: Controller,
): grpc.handleUnaryCall<TRequest, TResponse> {
	return async (call: grpc.ServerUnaryCall<TRequest, TResponse>, callback: grpc.sendUnaryData<TResponse>) => {
		try {
			log(`ProtoBus request: ${call.getPath()}`)
			const result = await handler(controller, call.request)
			callback(null, result)
		} catch (err: any) {
			log(`ProtoBus handler error: ${call.getPath()}\n${err.stack}`)
			callback({
				code: grpc.status.INTERNAL,
				message: err.message || "Internal error",
			} as grpc.ServiceError)
		}
	}
}

function wrapStreamingResponseHandler<TRequest, TResponse>(
	handler: GrpcStreamingResponseHandler<TRequest, TResponse>,
	controller: Controller,
): grpc.handleServerStreamingCall<TRequest, TResponse> {
	return async (call: grpc.ServerWritableStream<TRequest, TResponse>) => {
		try {
			const requestId = call.metadata.get("request-id").pop()?.toString() ?? randomUUID()
			call.once("close", () => getRequestRegistry().cancelRequest(requestId))
			log(`ProtoBus gRPC streaming request: ${call.getPath()}`)

			const responseHandler: StreamingResponseHandler<TResponse> = (response, isLast, _sequenceNumber) =>
				new Promise<void>((resolve, reject) => {
					call.write(response, (error?: Error | null) => {
						if (error) {
							reject(error)
							return
						}
						if (isLast === true) {
							log(`Closing ProtoBus stream for ${requestId}`)
							call.end()
						}
						resolve()
					})
				})
			await handler(controller, call.request, responseHandler, requestId)
		} catch (err: any) {
			log(`ProtoBus handler error: ${call.getPath()}\n${err.stack}`)
			call.destroy({
				code: grpc.status.INTERNAL,
				message: err.message || "Internal error",
			} as grpc.ServiceError)
		}
	}
}
