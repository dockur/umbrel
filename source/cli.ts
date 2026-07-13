#!/usr/bin/env tsx
import process from 'node:process'

import arg from 'arg'
import camelcaseKeys from 'camelcase-keys'

import {cliClient} from './modules/cli-client.js'
import Umbreld, {type UmbreldOptions} from './index.js'
import {setSystemStatus} from './modules/system/routes.js'

// Quick trpc client for testing
if (process.argv.includes('client')) {
	const clientIndex = process.argv.indexOf('client')
	const query = process.argv[clientIndex + 1]
	const args = process.argv.slice(clientIndex + 2)

	await cliClient({query, args})
	process.exit(0)
}

const showHelp = () =>
	console.log(`
    Usage
        $ umbreld

    Options
        --help                    Shows this help message
        --data-directory          Your Umbrel data directory
        --port                    The port to listen on
        --log-level               The logging intensity: silent|normal|verbose
		--default-app-store-repo  The default app store repository

    Examples
        $ umbreld --data-directory ~/umbrel
`)

const args = camelcaseKeys(
	arg({
		'--help': Boolean,
		'--data-directory': String,
		'--port': Number,
		'--log-level': String,
		'--default-app-store-repo': String,
	}),
)

if (args.help) {
	showHelp()
	process.exit(0)
}

// TODO: Validate these args are valid
const umbreld = new Umbreld(args as UmbreldOptions)

// Shutdown cleanly on SIGINT and SIGTERM
let isShuttingDown = false
async function cleanShutdown(signal: string) {
	if (isShuttingDown) return
	isShuttingDown = true

	try {
		umbreld.logger.log(`Received ${signal}, shutting down cleanly...`)
		await umbreld.stop()
	} catch (error) {
		umbreld.logger.error('Failed to shut down Umbrel cleanly', error)
	} finally {
		process.exit(130)
	}
}
process.on('SIGINT', cleanShutdown.bind(null, 'SIGINT'))
process.on('SIGTERM', cleanShutdown.bind(null, 'SIGTERM'))

let isRebooting = false
async function doReboot() {
	if (isRebooting || isShuttingDown) return
	isRebooting = true

	try {
		umbreld.logger.log(`Restarting Umbrel services...`)

		const stopped = await umbreld.stop()
		if (!stopped) {
			umbreld.logger.error('One or more Umbrel services failed to stop cleanly')
		}

		await Promise.all([
			umbreld.user.start(),
			umbreld.files.start(),
			umbreld.hardware.start(),
			umbreld.apps.start(),
			umbreld.appStore.start(),
			umbreld.dbus.start(),
			umbreld.systemNg.start(),
		])

		// Start backups last because it depends on files
		await umbreld.backups.start()
		setSystemStatus('running')
	} catch (error) {
		umbreld.logger.error('Failed to restart Umbrel services', error)
		setSystemStatus('running')
	} finally {
		isRebooting = false
	}
}
process.on('SIGUSR1', doReboot)

try {
	await umbreld.start()
} catch (error) {
	console.error(process.env.NODE_ENV === 'production' ? (error as Error).message : error)
	process.exit(1)
}
