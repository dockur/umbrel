import type Umbreld from '../../index.js'

export type SsdDevice = {
	type: 'ssd'
	transport: 'nvme' | 'sata'
	device: string
	id?: string
	pciSlotNumber?: number
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize: number
	temperature?: number
	temperatureWarning?: number
	temperatureCritical?: number
	lifetimeUsed?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
}

export type HddDevice = {
	type: 'hdd'
	transport: 'sata'
	device: string
	id?: string
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize: number
	temperature?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
}

export type StorageDevice = SsdDevice | HddDevice

export async function getInternalStorageDevices(): Promise<StorageDevice[]> {
	return []
}

export default class InternalStorage {
	logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`hardware:${name.toLowerCase()}`)
	}

	async start() {
		this.logger.log('Starting internal storage')
	}

	async stop() {
		this.logger.log('Stopping internal storage')
	}

	async getDevices(): Promise<StorageDevice[]> {
		return []
	}
}
