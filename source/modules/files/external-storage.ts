import fse from 'fs-extra'

import type Umbreld from '../../index.js'

// Get block devices — stub for Docker
export async function getBlockDevices() {
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

	// Only enable this module on non raspberry pi devices.
	// We disable on Pi due to unreliable power issues when running USB storage devices
	// and also due to complexities with the current mount script.
	async supported() {
		return false
	}

	// Add listener
	async start() {
		return
	}

	// Remove listener
	async stop() {
		return
	}

	// Unmount partition from external disk
	async unmountExternalDevice(deviceId: string, {remove = true} = {}) {
        return
	}

	// Format external device
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

	// Get external devices but only show mount points that are under /External
	// Also decorate with useful flags like isMounted and isFormatting
	async getExternalDevicesWithVirtualMountPoints() {
		return []
	}

	// Get all umbreld mounted external devices
	async getMountedExternalDevices() {
		return []
	}

	// Check if an external drive is connected on unsupported hardware
	// This is used to notify unsupported users why they can't see their hardware.
	async isExternalDeviceConnectedOnUnsupportedDevice() {
		return false
	}
}
