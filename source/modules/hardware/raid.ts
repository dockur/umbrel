import crypto from 'node:crypto'
import os from 'node:os'
import {setTimeout} from 'node:timers/promises'

import fse from 'fs-extra'
import {$} from 'execa'
import pRetry from 'p-retry'
import prettyBytes from 'pretty-bytes'

import type Umbreld from '../../index.js'
import FileStore from '../utilities/file-store.js'
import {reboot} from '../system/system.js'
import {setSystemStatus} from '../system/routes.js'
import runEvery from '../utilities/run-every.js'

// Get the size of a block device or partition in bytes
async function getDeviceSize(device: string): Promise<number> {
	const {stdout} = await $`lsblk --output SIZE --bytes --nodeps --noheadings ${device}`
	return parseInt(stdout.trim(), 10)
}

// Round device size down to nearest 250GB if over 1TB
// Round device size down to nearest 25GB if over 250GB
// This ensures drives of slightly different sizes can be used together in RAID
// e.g 512GB + 500GB can be used together
export function getRoundedDeviceSize(sizeInBytes: number): number {
	const twoFiftyGigabytes = 250_000_000_000
	const oneTerabyte = 1_000_000_000_000
	const twentyFiveGigabytes = 25_000_000_000
	if (sizeInBytes >= oneTerabyte) return Math.floor(sizeInBytes / twoFiftyGigabytes) * twoFiftyGigabytes
	if (sizeInBytes >= twoFiftyGigabytes) return Math.floor(sizeInBytes / twentyFiveGigabytes) * twentyFiveGigabytes
	return sizeInBytes
}

export type RaidType = 'storage' | 'failsafe'
export type Topology = 'stripe' | 'raidz' | 'mirror'

export type ExpansionStatus = {
	state: 'expanding' | 'finished' | 'canceled'
	progress: number
}

export type FailsafeTransitionStatus = {
	state: 'syncing' | 'rebooting' | 'rebuilding' | 'complete' | 'error'
	progress: number
	error?: string
}

export type RebuildStatus = {
	state: 'rebuilding' | 'finished' | 'canceled'
	progress: number
}

export type FailsafeMirrorTransitionPair = {
	existingDeviceId: string
	newDeviceId: string
}

export type ReplaceStatus = {
	state: 'rebuilding' | 'expanding' | 'finished' | 'canceled'
	progress: number
}

type AcceleratorConfig = {
	devices: string[]
}

// Types for zpool status --json --json-int --json-flat-vdevs output
type State = 'ONLINE' | 'DEGRADED' | 'FAULTED' | 'OFFLINE' | 'UNAVAIL' | 'REMOVED' | 'CANT_OPEN'

type ConfigStore = {
	user?: {
		name: string
		hashedPassword?: string
		password?: string
		language: string
	}
	raid?: {
		poolName: string
		state: 'normal' | 'transitioning-to-failsafe'
		devices: string[]
		raidType: RaidType
		accelerator?: AcceleratorConfig
	}
}

export default class Raid {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	configStore: FileStore<ConfigStore>
	isTransitioningToFailsafe = false
	isReplacing = false
	failsafeTransitionStatus?: FailsafeTransitionStatus
	replaceStatus?: ReplaceStatus
	initialRaidSetupError?: Error
	poolNameBase = 'umbrelos'
	temporaryDevicePath = '/tmp/umbrelos-temporary-migration-device.img'

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`hardware:${name.toLowerCase()}`)

	}

	async hasConfigStore() {
		return false
	}

	// Generate a unique pool name with random suffix to avoid collisions
	// when SSDs from other Umbrel installations are connected
	generatePoolName(): string {
		const suffix = crypto.randomBytes(4).toString('hex')
		return `${this.poolNameBase}-${suffix}`
	}

	async start() {
		return
	}

	async stop() {
		return
	}

	// Get status of the main RAID pool with migration error if any
	async getStatus() {
		return null
	}

	// Get status of a RAID pool
	async getPoolStatus(poolName: string): Promise<{
		exists: boolean
		raidType?: RaidType
		totalSpace?: number
		usableSpace?: number
		usedSpace?: number
		freeSpace?: number
		status?: State
		devices?: Array<{
			id: string
			status: State
			readErrors: number
			writeErrors: number
			checksumErrors: number
		}>
		mirrors?: string[][]
		topology?: Topology
		accelerator?: {
			exists: boolean
			l2arcSize?: number
			specialSize?: number
			devices?: Array<{
				id: string
				status: State
			}>
		}
		expansion?: ExpansionStatus
		rebuild?: RebuildStatus
	}> {
		return null
	}

	// Trigger initial RAID setup boot process
	async triggerInitialRaidSetupBootFlow(
		raidDevices: string[],
		raidType: RaidType,
		acceleratorDevices: string[] | undefined,
		user: {name: string; password: string; language: string},
	) {
		return true
	}

	// Handle initial RAID setup after first boot with the new array
	async handlePostBootRaidSetupProcess() {
		return
	}

	// Check the status of the RAID setup boot process
	async checkInitialRaidSetupStatus(): Promise<boolean> {
		return false
	}

	// Check if RAID mount failed during boot
	async checkRaidMountFailure(): Promise<boolean> {
		return fse.pathExists('/run/rugix/mounts/data/.rugix/data-mount-error.log')
	}

	// Get details about why RAID mount failed by running a test import
	async checkRaidMountFailureDevices(): Promise<Array<{name: string; isOk: boolean}>> {
		return null
	}

	// Setup RAID array from a list of devices
	// This will:
	// 1. Partition each device with a state partition and data partition (remaining space)
	// 2. Create a ZFS pool from all data partitions
	// 3. Write RAID config to boot partition to signal the boot process to mount the array
	async setup(deviceIds: string[], raidType: RaidType, acceleratorDeviceIds?: string[]): Promise<boolean> {
		return
	}

	// Add one device to a stripe (storage) or raidz (failsafe SSD) array.
	// Mirror failsafe arrays must use addMirror().
	async addDevice(deviceId: string): Promise<boolean> {
		return true
	}

	// Add one mirror pair to a mirror (failsafe HDD) array.
	async addMirror(deviceIds: [string, string]): Promise<boolean> {
		return true
	}

	// Add SSD accelerator device to an HDD pool.
	//
	// The SSD is partitioned into L2Arc (read cache) and special vdev (metadata + small blocks) partitions.
	// In FailSafe mode 2 SSDs are required: L2Arc is striped (data is volatile) but the special vdev is
	// mirrored (losing it means losing the entire pool).
	//
	// L2Arc is capped at 5x RAM (or 50% of device, whichever is smaller) per device. In FailSafe mode
	// this means 10x RAM total since L2Arc is striped across both devices. This prevents L2Arc entry
	// addressing from consuming too much L1Arc (RAM). At 128k block size, the 10x total cap results
	// in ~1% of memory dedicated to L2Arc addressing. The remainder of each device goes to the special vdev.
	//
	// We set special_small_blocks=32k so any block that compresses to ≤32k (or any file ≤32k total) lands
	// on the special vdev. This captures most OS/app files (configs, logs, container layers) while keeping
	// bulk data on HDDs. On a 2TB Umbrel dataset this is ~15GB. 64k would jump to ~150GB which is
	// unpredictable on larger/different workloads, so we stay conservative.
	async addAccelerator(deviceIds: string[]): Promise<boolean> {
		return true
	}

	// Replace a storage or accelerator device in the RAID array.
	async replaceDevice(oldDeviceId: string, newDeviceId: string): Promise<boolean> {
		return
	}

	// Transition an SSD storage array to a failsafe (raidz1) array.
	// This creates a degraded raidz1 pool with the new disk and syncs data from the old pool.
	async transitionToFailsafeRaidz(newDeviceId: string): Promise<boolean> {
        return
	}

    // Transition an HDD storage array to failsafe mirrors by attaching a new disk to each existing disk.
    // This is an in-place operation that does not require a reboot.
    async transitionToFailsafeMirror(
		pairs: FailsafeMirrorTransitionPair[],
		acceleratorDeviceId?: string,
	): Promise<boolean> {
		return false
}
