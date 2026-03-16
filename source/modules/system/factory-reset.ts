import {setTimeout} from 'node:timers/promises'
import {$} from 'execa'

// TODO: import packageJson from '../../package.json' assert {type: 'json'}
const packageJson = (await import('../../../package.json', {assert: {type: 'json'}})).default

import type {ProgressStatus} from '../apps/schema.js'
import type Umbreld from '../../index.js'
import {UMBREL_APP_STORE_REPO} from '../../constants.js'
import {performUpdate, getUpdateStatus} from './update.js'

type ResetStatus = ProgressStatus

let resetStatus: ResetStatus
resetResetStatus()

function resetResetStatus() {
	resetStatus = {
		running: false,
		progress: 0,
		description: '',
		error: false,
	}
}

function setResetStatus(properties: Partial<ResetStatus>) {
	resetStatus = {...resetStatus, ...properties}
}

export function getResetStatus() {
	return resetStatus
}

export async function performReset(umbreld: Umbreld) {

	setResetStatus({running: true, progress: 5, description: 'Resetting...', error: false})
        await setTimeout(1000);

	// The following must try hard to even complete on a heavily broken system.
	// For instance, the user might be unable to log in, networking might be
	// unavailable, and even the Umbreld codebase might have been altered. As a
	// precaution, wrap anything that could fail in a try/catch or similar.

	function failWithError(error: string) {
		try {
			umbreld.logger.error(`Factory reset failed at ${resetStatus.progress}%`, error)
		} catch {}
		resetResetStatus()
		setResetStatus({error})
		return false
	}

        return failWithError(`Factory reset is not supported in a Docker container, just remove the volume!`)
}
