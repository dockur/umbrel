import {$} from 'execa'
import type {ProgressStatus} from '../apps/schema.js'
import {detectDevice, isUmbrelOS} from './system.js'
import Umbreld from '../../index.js'

type UpdateStatus = ProgressStatus

let updateStatus: UpdateStatus
resetUpdateStatus()

function resetUpdateStatus() {
	updateStatus = {
		running: false,
		progress: 0,
		description: '',
		error: false,
	}
}

function setUpdateStatus(properties: Partial<UpdateStatus>) {
	updateStatus = {...updateStatus, ...properties}
}

export function getUpdateStatus() {
	return updateStatus
}

export async function getLatestRelease(umbreld: Umbreld) {
	let deviceId = 'unknown'
	try {
		deviceId = (await detectDevice()).deviceId
	} catch (error) {
		umbreld.logger.error(`Failed to detect device type`, error)
	}

	let platform = 'unknown'
	try {
		if (await isUmbrelOS()) {
			platform = 'umbrelOS'
		}
	} catch (error) {
		umbreld.logger.error(`Failed to detect platform`, error)
	}

	let channel = 'stable'
	try {
		channel = (await umbreld.store.get('settings.releaseChannel')) || 'stable'
	} catch (error) {
		umbreld.logger.error(`Failed to get release channel`, error)
	}

	const updateUrl = new URL('https://api.umbrel.com/latest-release')
	// Provide context to the update server about the underlying device and platform
	// so we can avoid the 1.0 update situation where we need to shim multiple update
	// mechanisms and error-out updates for unsupported platforms. This also helps
	// notifying users for critical security updates that are be relevant only to their specific
	// platform, and avoids notififying users of updates that aren't yet available for their
	// platform.
	updateUrl.searchParams.set('version', umbreld.version)
	updateUrl.searchParams.set('device', deviceId)
	updateUrl.searchParams.set('platform', platform)
	updateUrl.searchParams.set('channel', channel)

	const result = await fetch(updateUrl, {
		headers: {'User-Agent': `umbrelOS ${umbreld.version}`},
	})
	const data = await result.json()
	return data as {version: string; name: string; releaseNotes: string; updateScript?: string}
}

export async function performUpdate(umbreld: Umbreld) {

	setUpdateStatus({running: true, progress: 5, description: 'Updating...', error: false})
        await setTimeout(1000);

	setUpdateStatus({error: 'Updates not supported, update the Docker image instead!'})

	// Reset the state back to running but leave the error message so ui polls
	// can differentiate between a successful update after reboot and a failed
	// update that didn't reboot.
	const errorStatus = updateStatus.error
	resetUpdateStatus()
	setUpdateStatus({error: errorStatus})

	return false
}
