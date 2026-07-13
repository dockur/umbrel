import os from 'node:os'

import {z} from 'zod'
import {$} from 'execa'
import fse from 'fs-extra'
import stripAnsi from 'strip-ansi'

import {getUpdateStatus, performUpdate, getLatestRelease} from './update.js'
import {
	getCpuTemperature,
	getSystemDiskUsage,
	getDiskUsage,
	getMemoryUsage,
	getCpuUsage,
	reboot,
	shutdown,
	detectDevice,
	getSystemMemoryUsage,
	getIpAddresses,
	getNetworkInterfaces,
	getHostname,
} from './system.js'

import {privateProcedure, publicProcedure, publicProcedureWhenNoUserExists, router} from '../server/trpc/trpc.js'

type SystemStatus = 'running' | 'updating' | 'shutting-down' | 'restarting' | 'migrating' | 'resetting' | 'restoring'
let systemStatus: SystemStatus = 'running'

const unsupportedNetworkMessage = 'Network configuration is not supported in Docker.'
const unsupportedUpdateMessage = 'Updates are not supported in Docker. Update the Docker image instead.'

// Quick hack so we can set system status from migration module until we refactor this
export function setSystemStatus(status: SystemStatus) {
	systemStatus = status
}

export default router({
	online: publicProcedure.query(() => true),

	version: publicProcedure.query(async ({ctx}) => {
		return {
			version: ctx.umbreld.version,
			name: ctx.umbreld.versionName,
			previousVersion: await ctx.umbreld.store.get('previousVersion'),
		}
	}),

	status: publicProcedure.query(() => systemStatus),

	updateStatus: privateProcedure.query(() => getUpdateStatus()),

	uptime: privateProcedure.query(() => os.uptime()),

	// Docker installations are updated by pulling a newer container image.
	checkUpdate: privateProcedure.query(async ({ctx}) => {
		const {version, name, releaseNotes} = await getLatestRelease(ctx.umbreld)
		const available = version.replace('v', '') !== ctx.umbreld.version

		if (available) {
			throw new Error(unsupportedUpdateMessage)
		}

		return {available, version, name, releaseNotes}
	}),

	getReleaseChannel: privateProcedure.query(() => 'stable'),

	setReleaseChannel: privateProcedure
		.input(
			z.object({
				channel: z.enum(['stable', 'beta']),
			}),
		)
		.mutation(async () => {
			throw new Error(unsupportedUpdateMessage)
		}),

	isExternalDns: privateProcedure.query(() => true),

	setExternalDns: privateProcedure.input(z.boolean()).mutation(async () => {
		throw new Error(unsupportedNetworkMessage)
	}),

	update: privateProcedure.mutation(async ({ctx}) => {
		systemStatus = 'updating'
		let success = false

		try {
			success = await performUpdate(ctx.umbreld)
		} finally {
			if (!success) {
				systemStatus = 'running'
			}
		}

		return success
	}),

	hiddenService: privateProcedure.query(async ({ctx}) => {
		try {
			return await fse.readFile(`${ctx.umbreld.dataDirectory}/tor/data/web/hostname`, 'utf-8')
		} catch (error) {
			ctx.umbreld.logger.error('Failed to read hidden service for ui', error)
			return ''
		}
	}),

	// Public during onboarding to show device-specific UI (Pro/Home images, video background)
	device: publicProcedureWhenNoUserExists.query(() => detectDevice()),

	cpuTemperature: privateProcedure.query(() => getCpuTemperature()),

	systemDiskUsage: privateProcedure.query(({ctx}) => getSystemDiskUsage(ctx.umbreld)),

	diskUsage: privateProcedure.query(({ctx}) => getDiskUsage(ctx.umbreld)),

	systemMemoryUsage: privateProcedure.query(() => getSystemMemoryUsage()),

	memoryUsage: privateProcedure.query(({ctx}) => getMemoryUsage(ctx.umbreld)),

	cpuUsage: privateProcedure.query(({ctx}) => getCpuUsage(ctx.umbreld)),

	getIpAddresses: privateProcedure.query(() => getIpAddresses()),

	getHostname: privateProcedure.query(() => getHostname()),

	getNetworkInterfaces: privateProcedure.query(({ctx}) => getNetworkInterfaces(ctx.umbreld)),

	setHostname: privateProcedure
		.input(
			z.object({
				hostname: z
					.string()
					.trim()
					.toLowerCase()
					.regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Invalid hostname'),
			}),
		)
		.mutation(async () => {
			throw new Error('Changing the hostname is not supported in Docker.')
		}),

	setStaticIp: privateProcedure
		.input(
			z.object({
				mac: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, 'Invalid MAC address'),
				ip: z.string().ip({
					version: 'v4',
					message: 'Invalid IPv4 address',
				}),
				subnetPrefix: z.number().int().min(0).max(32),
				gateway: z.string().ip({
					version: 'v4',
					message: 'Invalid IPv4 gateway',
				}),
				dns: z
					.array(
						z.string().ip({
							version: 'v4',
							message: 'Invalid IPv4 DNS address',
						}),
					)
					.min(1),
			}),
		)
		.mutation(async () => {
			throw new Error(unsupportedNetworkMessage)
		}),

	// Public so it can be called from a new origin after an IP change, where no JWT is available.
	confirmStaticIp: publicProcedure
		.input(
			z.object({
				ip: z.string().ip({
					version: 'v4',
					message: 'Invalid IPv4 address',
				}),
			}),
		)
		.mutation(async () => {
			throw new Error(unsupportedNetworkMessage)
		}),

	clearStaticIp: privateProcedure
		.input(
			z.object({
				mac: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, 'Invalid MAC address'),
			}),
		)
		.mutation(async () => {
			throw new Error(unsupportedNetworkMessage)
		}),

	// Public during onboarding and recovery mode so users can shut down during RAID setup or mount failure
	shutdown: publicProcedureWhenNoUserExists.mutation(async () => {
		systemStatus = 'shutting-down'
		await shutdown()

		return true
	}),

	// Public during onboarding and recovery mode
	restart: publicProcedureWhenNoUserExists.mutation(async () => {
		systemStatus = 'restarting'
		await reboot()

		return true
	}),

	logs: privateProcedure
		.input(
			z.object({
				type: z.enum(['umbrelos', 'system']),
			}),
		)
		.query(async ({input}) => {
			if (input.type === 'system') {
				return 'System logs are not available in the Docker version of Umbrel.'
			}

			const containerName = process.env.UMBREL_CONTAINER_NAME

			if (!containerName) {
				throw new Error('Failed to determine the Umbrel container name.')
			}

			const logs = await $`docker logs --tail 1500 ${containerName}`

			return stripAnsi(`${logs.stdout}\n${logs.stderr}`.trim())
		}),

	// Factory reset is unavailable because container state is managed through the bound data directory.
	factoryReset: publicProcedureWhenNoUserExists
		.input(
			z.object({
				password: z.string().optional(),
			}),
		)
		.mutation(async () => {
			throw new Error('Factory reset is not supported in Docker. Remove the data volume to reset Umbrel.')
		}),
})
