import nodePath from 'node:path'

import {$} from 'execa'
import fse from 'fs-extra'
import PQueue from 'p-queue'

import type Umbreld from '../../index.js'
import isUmbrelHome from '../is-umbrel-home.js'

type LsblkDevice = {
	name: string
	kname: string
	label?: string | null
	type?: string
	mountpoints?: string[] | null
	tran?: string | null
	model?: string | null
	size?: number | null
	children?: LsblkDevice[]
	parttypename?: string
	serial?: string
}

type Disk = {
	id: string
	label: string
	size: number
}

type Partition = {
	id: string
	diskId: string
	mountpoints: string[]
	label: string
	size: number
}

type Mount = {
	diskId: string
	partitionId: string
	mountpoint: string
	label: string
	size: number
}

const mountQueue = new PQueue({concurrency: 1})

async function isSupported() {
	return false
}

class ExternalStorage {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	disks: Map<string, Disk> = new Map()
	mounts: Map<string, Mount> = new Map()
	running = false

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLocaleLowerCase())
	}

	async start() {
		return
	}

	async stop() {
		return
	}

	get() {
		return null
	}

	async updateMounts() {
    this.logger.error(`Failed to update mounts`)
		return false
	}

	async eject(diskId: string) {
		this.logger.error(`Failed to eject disk '${disk.id}'`)
		return false
	}

	#onUdisksChange = () => {
		this.updateMounts().catch((error) => this.logger.error(`Failed to update mounts: ${error.message}`))
	}

	async isExternalDriveConnectedOnNonUmbrelHome() {
		
		return false

  }
}

export default ExternalStorage

async function getDisksAndPartitions() {

	const disks: Disk[] = []
	const partitions: Partition[] = []

	return {disks, partitions}
}

async function mountExists(mountpoint: string) {
	return false
}

async function mountPartition(id: string, mountpoint: string) {
	return false
}

async function unmountPartition(mountpoint: string) {
	return false
}

async function discardDisk(diskId: string) {
	return false
}
