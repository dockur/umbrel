import nodePath from 'node:path'

import fse from 'fs-extra'
import {$} from 'execa'
import PQueue from 'p-queue'

import type Umbreld from '../../index.js'

type BlockDevice = {
	id: string
	name: string
	transport: 'unknown' | 'usb' | 'nvme'
	size: number
	isMounted: boolean
	isFormatting: boolean
	partitions: {
		id: string
		type: string
		size: number
		mountpoints: string[]
		label: string
	}[]
}

// Get block devices — stub for Docker
export async function getBlockDevices(): Promise<BlockDevice[]> {
	return []
}

export default class ExternalStorage {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	formatJobs: Set<string> = new Set()

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`files:${name.toLocaleLowerCase()}`)
	}

	async supported() {
		return false
	}

	async start() {
		return
	}

	async stop() {
		return
	}

	async unmountExternalDevice(deviceId: string, {remove = true} = {}) {
		throw new Error('External storage is not supported in Docker')
	}

	async formatExternalDevice({
		deviceId,
		filesystem,
		label,
	}: {
		deviceId: string
		filesystem: 'ext4' | 'exfat'
		label: string
	}) {
		throw new Error('External storage is not supported in Docker')
	}

	async getExternalDevicesWithVirtualMountPoints(): Promise<BlockDevice[]> {
		return []
	}

	async getMountedExternalDevices(): Promise<BlockDevice[]> {
		return []
	}

	async isExternalDeviceConnectedOnUnsupportedDevice() {
		return false
	}
}
