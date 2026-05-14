import {$} from 'execa'
import { setTimeout } from 'node:timers/promises';
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

        const data =
        {
	        name: "umbrelOS",
                version: "v" + umbreld.version,
		releaseNotes: "",
	        updateScript: ""
        };

	return data
}

export async function performUpdate(umbreld: Umbreld) {

	setUpdateStatus({running: true, progress: 5, description: 'Updating...', error: false})
        await setTimeout(1000);

	setUpdateStatus({error: 'Updates not supported, update the container instead!'})

	// Reset the state back to running but leave the error message so ui polls
	// can differentiate between a successful update after reboot and a failed
	// update that didn't reboot.
	const errorStatus = updateStatus.error
	resetUpdateStatus()
	setUpdateStatus({error: errorStatus})

	return false
}
