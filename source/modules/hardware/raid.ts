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
type Vdev = {
	vdev_type: 'root' | 'raidz' | 'mirror' | 'disk' | 'file'
	path?: string
	rep_dev_size?: number
	phys_space?: number
	slow_ios?: number
	name: string
	guid: number
	class: 'normal' | 'special' | 'l2cache' | string
	parent?: string
	state: State
	alloc_space: number
	total_space: number
	def_space: number
	read_errors: number
	write_errors: number
	checksum_errors: number
}
type ScanStats = {
	function: 'SCRUB' | 'RESILVER'
	state: 'SCANNING' | 'FINISHED' | 'CANCELED'
	start_time: number
	end_time: number
	to_examine: number
	examined: number
	skipped: number
	processed: number
	errors: number
	bytes_per_scan: number
	pass_start: number
	scrub_pause: number
	scrub_spent_paused: number
	issued_bytes_per_scan: number
	issued: number
}
type RaidzExpandStats = {
	name: string
	state: 'SCANNING' | 'FINISHED' | 'CANCELED'
	expanding_vdev: number
	start_time: number
	end_time: number
	to_reflow: number
	reflowed: number
	waiting_for_resilver: number
}
type Pool = {
	name: string
	state: State
	pool_guid: number
	txg: number
	spa_version: number
	zpl_version: number
	error_count: number
	status?: string
	action?: string
	msgid?: string
	moreinfo?: string
	scan_stats?: ScanStats
	raidz_expand_stats?: RaidzExpandStats
	vdevs: Record<string, Vdev>
}
type ZpoolStatusOutput = {
	output_version: {
		command: string
		vers_major: number
		vers_minor: number
	}
	pools: Record<string, Pool>
}

type AcceleratorPoolDevice = {
	id: string
	status: State
	l2arcPartition: string
	l2arcSize: number
	specialPartition: string
	specialSize: number
}

type ParsedAccelerator = {
	devices: AcceleratorPoolDevice[]
	totalL2arcSize: number
	totalSpecialUsableSize: number
}

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
	failsafeTransitionStatus?: FailsafeTransitionStatus
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

	// Create GPT partition table and partitions on a device
	async #partitionDevice(device: string): Promise<{statePartition: string; dataPartition: string}> {
		return
	}

	async #partitionAcceleratorDevice(
		device: string,
		sizes?: {l2arcSizeBytes: number; specialSizeBytes: number},
	): Promise<{statePartition: string; l2arcPartition: string; specialPartition: string}> {
		return
	}

	// Create ZFS pool from data partitions with a given topology
	// For mirror topology, partitions are assumed to be in pairs
	async #createPool(poolName: string, dataPartitions: string[], topology: Topology): Promise<void> {
		// Build vdev specification from topology
		let vdevSpec = dataPartitions
		if (topology === 'raidz') {
			vdevSpec = ['raidz1', ...dataPartitions]
		} else if (topology === 'mirror') {
			vdevSpec = []
			for (let i = 0; i < dataPartitions.length; i += 2) {
				vdevSpec.push('mirror', dataPartitions[i], dataPartitions[i + 1])
			}
		}

		// Pool options (-o):
		//   ashift=12: 4K sectors (optimal for NVMe SSDs)
		//   autotrim=on: Enable automatic TRIM for SSDs
		//   autoexpand=on: Automatically expand pool when devices are replaced with larger ones
		//   cachefile=none: Don't write to /etc/zfs/zpool.cache since it won't exist before we've mounted the pool
		//   -m none: Don't mount the pool itself
		this.logger.log(`Creating ZFS pool '${poolName}' (${topology}) with partitions: ${dataPartitions.join(', ')}`)
		await $`zpool create -f -o ashift=12 -o autotrim=on -o autoexpand=on -o cachefile=none -m none ${poolName} ${vdevSpec}`
		this.logger.log(`ZFS pool '${poolName}' created successfully`)
	}

	// Create the data dataset on a pool
	async #createDataset(poolName: string): Promise<void> {
		// We use a hardcoded encryption password for now. This obviously doesn't provide any security.
		// However initialising encryption now means we can enable full disk encryption in the future
		// by simply updating the password to something secure without requiring an entire backup and restore
		// of all data into a new encrypted dataset.
		// Must be minimum 8 characters so we use umbrelumbrel.
		const defaultEncryptionPassword = 'umbrelumbrel'

		// Dataset options (-o):
		//   encryption=aes-256-gcm: Enable encryption with AES-256-GCM
		//   keyformat=passphrase: Use a passphrase for the encryption key
		//   keylocation=prompt: Key will be provided via stdin
		//   mountpoint=legacy: We want to handle mounting manually
		//   compression=lz4: Fastest compression for minimal overhead
		//   atime=off: Disable access time updates (significantly reduces writes)
		//   xattr=sa: Store extended attributes in inodes for significant performance gains.
		//   acltype=posixacl: Enable POSIX ACLs for proper permission handling.
		this.logger.log(`Creating data dataset on pool '${poolName}'`)
		await $({
			input: defaultEncryptionPassword,
		})`zfs create -o encryption=aes-256-gcm -o keyformat=passphrase -o keylocation=prompt -o mountpoint=legacy -o compression=lz4 -o atime=off -o xattr=sa -o acltype=posixacl ${poolName}/data`
		this.logger.log(`Encrypted dataset created successfully`)
	}

	// Setup RAID array from a list of devices
	// This will:
	// 1. Partition each device with a state partition and data partition (remaining space)
	// 2. Create a ZFS pool from all data partitions
	// 3. Write RAID config to boot partition to signal the boot process to mount the array
	async setup(deviceIds: string[], raidType: RaidType, acceleratorDeviceIds?: string[]): Promise<boolean> {
		return
	}

	// Assert that a device matches the type (SSD or HDD) of the RAID array
	async #assertDeviceTypeMatchesPool(deviceId: string): Promise<void> {
		const devices = await this.#umbreld.hardware.internalStorage.getDevices()
		const pool = await this.getStatus()
		const poolDeviceId = pool.devices?.[0]?.id
		if (!poolDeviceId) throw new Error("RAID array doesn't exist or has no devices")
		const newDevice = devices.find((d) => d.id === deviceId)
		const poolDevice = devices.find((d) => d.id === poolDeviceId)
		if (!newDevice) throw new Error(`Device not found: ${deviceId}`)
		if (!poolDevice) throw new Error(`Device not found: ${poolDeviceId}`)
		if (newDevice.type !== poolDevice.type) throw new Error(`Cannot mix SSDs and HDDs in the same RAID array`)
	}

	// Get the device type (SSD or HDD) of the RAID array based on its first device
	async #getPoolDeviceType(): Promise<'ssd' | 'hdd'> {
		const pool = await this.getStatus()
		const poolDeviceId = pool.devices?.[0]?.id
		if (!poolDeviceId) throw new Error("RAID array doesn't exist or has no devices")
		const devices = await this.#umbreld.hardware.internalStorage.getDevices()
		const device = devices.find((d) => d.id === poolDeviceId)
		if (!device) throw new Error(`Device not found: ${poolDeviceId}`)
		return device.type
	}

	async #getDeviceInfo(deviceId: string) {
		const devices = await this.#umbreld.hardware.internalStorage.getDevices()
		const device = devices.find((d) => d.id === deviceId)
		if (!device) throw new Error(`Device not found: ${deviceId}`)
		return device
	}

	async #assertAcceleratorDeviceType(deviceId: string): Promise<void> {
		const device = await this.#getDeviceInfo(deviceId)
		if (device.type !== 'ssd') throw new Error('Accelerator devices must be SSDs')
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
		// Verify we're in a state that can be migrated
		const pool = await this.getStatus()
		if (!pool.exists) throw new Error('No RAID array exists')
		if (pool.raidType !== 'storage') throw new Error('Can only transition from storage mode')

		// Raidz transition only supports SSD arrays with a single existing device
		const deviceType = await this.#getPoolDeviceType()
		if (deviceType !== 'ssd') throw new Error('transitionToFailsafeRaidz is only supported for SSD arrays')
		if (pool.devices?.length !== 1) throw new Error('Can only transition single-disk SSD arrays')

		// Validate new device exists, isn't in the pool, and matches pool type
		const newDevice = `/dev/disk/by-umbrel-id/${newDeviceId}`
		if (!(await fse.pathExists(newDevice))) throw new Error(`Device not found: ${newDevice}`)
		const poolDeviceIds = pool.devices?.map((d) => d.id) ?? []
		if (poolDeviceIds.includes(newDeviceId))
			throw new Error('Cannot transition with a device that is already in the RAID array')
		await this.#assertDeviceTypeMatchesPool(newDeviceId)

		// Check if new device is at least as large as the current device
		const currentDeviceId = pool.devices![0].id
		const currentDevice = `/dev/disk/by-umbrel-id/${currentDeviceId}`
		const currentDeviceSize = await getDeviceSize(currentDevice)
		const newDeviceSize = await getDeviceSize(newDevice)
		if (getRoundedDeviceSize(newDeviceSize) < getRoundedDeviceSize(currentDeviceSize))
			throw new Error('Cannot transition to a device smaller than the current device')

		if (this.isTransitioningToFailsafe) throw new Error('Already transitioning to failsafe mode')
		this.isTransitioningToFailsafe = true

		this.logger.log(`Starting raidz failsafe transition with ${newDevice}`)
		const migrationPoolName = `${pool.name}-migration`
		try {
			// Partition the new device
			this.logger.log(`Partitioning new device: ${newDevice}`)
			const {dataPartition: newDataPartition} = await this.#partitionDevice(newDevice)

			// Get the size of the existing data partition for creating the temp file
			const currentDeviceDataPartition = `${currentDevice}-part2`
			const currentDeviceDataPartitionSize = await getDeviceSize(currentDeviceDataPartition)

			// Create a sparse temp file the same size as the current device partition
			this.logger.log(
				`Creating sparse temp file: ${this.temporaryDevicePath} (${currentDeviceDataPartitionSize} bytes)`,
			)
			await $`truncate -s ${currentDeviceDataPartitionSize} ${this.temporaryDevicePath}`

			// Create the migration pool as raidz1 with new partition + temp file
			// ZFS can use a file path directly without needing a loopback device
			await this.#createPool(migrationPoolName, [newDataPartition, this.temporaryDevicePath], 'raidz')

			// Remove the temp file from the migration pool (making it degraded)
			this.logger.log(`Removing temp device from pool to create degraded raidz1`)
			await $`zpool offline ${migrationPoolName} ${this.temporaryDevicePath}`
			await fse.remove(this.temporaryDevicePath)

			// Create a snapshot of the active pool
			const baseSnapshot = 'migration'
			this.logger.log(`Creating snapshot: ${pool.name}@${baseSnapshot}`)
			await $`zfs snapshot -r ${pool.name}@${baseSnapshot}`

			// Get the estimated size of the snapshot to send (must match flags used in actual send)
			// Using --raw to preserve encryption (sends encrypted blocks without needing key loaded)
			this.logger.log('Estimating snapshot size...')
			const sizeResult =
				await $`zfs send --dryrun --raw --replicate --parsable --large-block --compressed ${pool.name}@${baseSnapshot}`
			const sizeOutput = sizeResult.stderr || sizeResult.stdout
			// --parsable outputs "size\t<bytes>" on the last line
			const sizeMatch = sizeOutput.match(/^size\s+(\d+)/m)
			const estimatedSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0
			this.logger.log(`Estimated snapshot size: ${estimatedSize} bytes`)

			// Initialize transition status
			this.failsafeTransitionStatus = {state: 'syncing', progress: 0}
			this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)

			// Kick off non-blocking data migration to avoid blocking the API response
			this.logger.log('Starting async data migration...')
			Promise.resolve()
				.then(async () => {
					// Send the active pool snapshot to the migration pool
					// Using --raw to preserve encryption (sends encrypted blocks without needing key loaded)
					this.logger.log(`Sending snapshot to migration pool (this may take a while)...`)
					const sendProcess = $({
						shell: true,
					})`zfs send --raw --replicate --large-block --compressed ${pool.name}@${baseSnapshot} | zfs receive -Fu ${migrationPoolName}`

					// Poll progress while sending
					const stopProgressMonitor = runEvery(
						'1 second',
						async () => {
							try {
								const migrationStatus = await this.getPoolStatus(migrationPoolName)
								if (migrationStatus.exists && estimatedSize > 0) {
									const usedSpace = migrationStatus.usedSpace ?? 0
									// Scale sync progress to 0-49% (first half of transition)
									const rawProgress = Math.min(99, Math.floor((usedSpace / estimatedSize) * 100))
									const progress = Math.floor((rawProgress / 100) * 49)
									if (this.failsafeTransitionStatus && progress > this.failsafeTransitionStatus.progress) {
										this.logger.log(`Sync progress: ${progress}%`)
										this.failsafeTransitionStatus = {state: 'syncing', progress}
										this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
									}
								}
							} catch {
								// Ignore errors during progress polling
							}
						},
						{runInstantly: true},
					)

					try {
						await sendProcess
					} finally {
						stopProgressMonitor()
					}

					// Mark RAID config state as transitioning to failsafe
					// This allows easy detection by the boot script
					this.logger.log('Updating RAID config')
					await this.configStore.set('raid.state', 'transitioning-to-failsafe')

					// Emit rebooting state at 50% (rebuild will complete the remaining 50%)
					this.failsafeTransitionStatus = {state: 'rebooting', progress: 50}
					this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)

					// Set status and wait 11 seconds before rebooting so the UI has time to poll
					// and show the restarting state (UI polls every 10 seconds)
					this.logger.log(`Initial sync complete, rebooting to complete migration`)
					setSystemStatus('restarting')
					await setTimeout(11_000)
					reboot()
				})
				.catch(async (error) => {
					// Reset system status in case we set it to restarting before the error
					setSystemStatus('running')

					// Emit error state
					this.failsafeTransitionStatus = {state: 'error', progress: 0, error: (error as Error).message}
					this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)

					// Clean up on failure
					this.logger.error(`Migration failed, cleaning up...`, error)
					await $`zpool destroy ${migrationPoolName}`.catch(() => {})
					await $`zfs destroy -r ${pool.name}@migration`.catch(() => {})
					await fse.remove(this.temporaryDevicePath).catch(() => {})
					this.isTransitioningToFailsafe = false
				})

			return true
		} catch (error) {
			// Emit error state
			this.failsafeTransitionStatus = {state: 'error', progress: 0, error: (error as Error).message}
			this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)

			// Clean up on failure
			this.logger.error(`Migration setup failed, cleaning up...`)
			await $`zpool destroy ${migrationPoolName}`.catch(() => {})
			await $`zfs destroy -r ${pool.name}@migration`.catch(() => {})
			await fse.remove(this.temporaryDevicePath).catch(() => {})
			this.isTransitioningToFailsafe = false
			throw error
		}
	}

	// Transition an HDD storage array to failsafe mirrors by attaching a new disk to each existing disk.
	// This is an in-place operation that does not require a reboot.
	async transitionToFailsafeMirror(
		pairs: FailsafeMirrorTransitionPair[],
		acceleratorDeviceId?: string,
	): Promise<boolean> {
		if (pairs.length === 0) throw new Error('At least one mirror pair is required')

		// Verify we're in a state that can be migrated
		const pool = await this.getStatus()
		if (!pool.exists) throw new Error('No RAID array exists')
		if (pool.raidType !== 'storage') throw new Error('Can only transition from storage mode')

		// Mirror transition only supports HDD arrays
		const deviceType = await this.#getPoolDeviceType()
		if (deviceType !== 'hdd') throw new Error('transitionToFailsafeMirror is only supported for HDD arrays')

		const existingDeviceIds = pool.devices?.map((d) => d.id) ?? []
		if (pairs.length !== existingDeviceIds.length)
			throw new Error(
				`Need exactly ${existingDeviceIds.length} mirror pair(s) to transition to failsafe mode, got ${pairs.length}`,
			)

		const existingPoolDeviceIds = new Set(existingDeviceIds)
		const seenExisting = new Set<string>()
		const seenNew = new Set<string>()

		for (const pair of pairs) {
			if (!existingPoolDeviceIds.has(pair.existingDeviceId))
				throw new Error(`Device ${pair.existingDeviceId} is not in the RAID array`)
			if (seenExisting.has(pair.existingDeviceId))
				throw new Error(`Duplicate existing device in mirror pairs: ${pair.existingDeviceId}`)
			if (seenNew.has(pair.newDeviceId)) throw new Error(`Duplicate new device in mirror pairs: ${pair.newDeviceId}`)
			if (existingPoolDeviceIds.has(pair.newDeviceId))
				throw new Error('Cannot transition with a device that is already in the RAID array')

			const newDevice = `/dev/disk/by-umbrel-id/${pair.newDeviceId}`
			if (!(await fse.pathExists(newDevice))) throw new Error(`Device not found: ${newDevice}`)

			await this.#assertDeviceTypeMatchesPool(pair.newDeviceId)

			seenExisting.add(pair.existingDeviceId)
			seenNew.add(pair.newDeviceId)
		}

		for (const existingDeviceId of existingDeviceIds) {
			if (!seenExisting.has(existingDeviceId))
				throw new Error(`Missing mirror pair for existing device: ${existingDeviceId}`)
		}

		// Validate each new device is at least as large as the existing device it mirrors
		for (const pair of pairs) {
			const existingDevice = `/dev/disk/by-umbrel-id/${pair.existingDeviceId}`
			const newDevice = `/dev/disk/by-umbrel-id/${pair.newDeviceId}`
			const existingSize = await getDeviceSize(existingDevice)
			const newSize = await getDeviceSize(newDevice)
			if (getRoundedDeviceSize(newSize) < getRoundedDeviceSize(existingSize))
				throw new Error('Cannot transition with a device smaller than an existing device')
		}

		// If we have an accelerator device, check we have a valid new accelerator device to mirror to
		const existingAccelerator = pool.accelerator
		const existingAcceleratorDeviceIds = existingAccelerator?.devices?.map((device) => device.id) ?? []
		const existingAcceleratorDevices = existingAcceleratorDeviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`)
		// Check the live pool status instead of config.
		if (existingAcceleratorDeviceIds.length > 0) {
			if (!acceleratorDeviceId)
				throw new Error(
					'Transitioning to failsafe with an accelerator requires an additional SSD for the accelerator mirror',
				)
			const existingAcceleratorIds = new Set(existingAcceleratorDeviceIds)
			if (
				existingPoolDeviceIds.has(acceleratorDeviceId) ||
				seenNew.has(acceleratorDeviceId) ||
				existingAcceleratorIds.has(acceleratorDeviceId)
			)
				throw new Error('Cannot reuse a RAID device as the accelerator mirror')

			const acceleratorDevice = `/dev/disk/by-umbrel-id/${acceleratorDeviceId}`
			if (!(await fse.pathExists(acceleratorDevice))) throw new Error(`Device not found: ${acceleratorDevice}`)
			await this.#assertAcceleratorDeviceType(acceleratorDeviceId)

			// Use the same rounded size check as normal RAID devices.
			const existingAcceleratorDevicePath = existingAcceleratorDevices[0]
			const existingAcceleratorSize = await getDeviceSize(existingAcceleratorDevicePath)
			const newAcceleratorSize = await getDeviceSize(acceleratorDevice)
			if (getRoundedDeviceSize(newAcceleratorSize) < getRoundedDeviceSize(existingAcceleratorSize))
				throw new Error('Cannot transition with an accelerator device smaller than the existing accelerator')
		} else if (acceleratorDeviceId) {
			throw new Error('Cannot supply an accelerator mirror SSD when no accelerator exists')
		}

		if (this.isTransitioningToFailsafe) throw new Error('Already transitioning to failsafe mode')
		this.isTransitioningToFailsafe = true

		const newDevices = pairs.map((pair) => `/dev/disk/by-umbrel-id/${pair.newDeviceId}`)
		this.logger.log(`Starting mirror failsafe transition with ${newDevices.join(', ')}`)

		try {
			// Partition all new devices
			this.logger.log(`Partitioning ${newDevices.length} new device(s)`)
			const partitionEntries = await Promise.all(
				pairs.map(async (pair) => {
					const newDevice = `/dev/disk/by-umbrel-id/${pair.newDeviceId}`
					const {dataPartition} = await this.#partitionDevice(newDevice)
					return [pair.newDeviceId, dataPartition] as const
				}),
			)
			const newDataPartitions = new Map(partitionEntries)

			// Attach each new device to the explicitly specified existing device
			for (const pair of pairs) {
				const existingPartition = `/dev/disk/by-umbrel-id/${pair.existingDeviceId}-part2`
				const newDataPartition = newDataPartitions.get(pair.newDeviceId)
				if (!newDataPartition) throw new Error(`Missing partition for device: ${pair.newDeviceId}`)

				this.logger.log(`Attaching ${newDataPartition} to ${existingPartition} in pool '${pool.name}'`)
				await $`zpool attach -f ${pool.name} ${existingPartition} ${newDataPartition}`
			}

			// If we have an existing accelerator device, mirror it against the new one
			if (existingAcceleratorDeviceIds.length > 0 && acceleratorDeviceId) {
				const newAcceleratorDevice = `/dev/disk/by-umbrel-id/${acceleratorDeviceId}`
				const existingL2arcPartition = `${existingAcceleratorDevices[0]}-part2`
				const existingSpecialPartition = `${existingAcceleratorDevices[0]}-part3`
				// Reuse the existing partition sizes.
				const {l2arcPartition, specialPartition} = await this.#partitionAcceleratorDevice(newAcceleratorDevice, {
					l2arcSizeBytes: await getDeviceSize(existingL2arcPartition),
					specialSizeBytes: await getDeviceSize(existingSpecialPartition),
				})

				this.logger.log(`Adding accelerator cache partition ${l2arcPartition} to pool '${pool.name}'`)
				await $`zpool add -f ${pool.name} cache ${l2arcPartition}`

				// Mirror the existing special vdev.
				this.logger.log(`Mirroring accelerator special vdev ${existingSpecialPartition} with ${specialPartition}`)
				await $`zpool attach -f ${pool.name} ${existingSpecialPartition} ${specialPartition}`
			}

			// Keep config order deterministic: existing pool order, then mirror partners in that same order
			const newDeviceByExisting = new Map(pairs.map((pair) => [pair.existingDeviceId, pair.newDeviceId]))
			const orderedNewDeviceIds = existingDeviceIds.map((existingDeviceId) => {
				const newDeviceId = newDeviceByExisting.get(existingDeviceId)
				if (!newDeviceId) throw new Error(`Missing mirror pair for existing device: ${existingDeviceId}`)
				return newDeviceId
			})

			// Update config with new RAID configuration
			const allDevices = [
				...existingDeviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`),
				...orderedNewDeviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`),
			]
			await this.configStore.getWriteLock(async ({set}) => {
				const raid = await this.configStore.get('raid')
				await set('raid', {
					...raid,
					raidType: 'failsafe',
					devices: allDevices,
					accelerator:
						existingAcceleratorDeviceIds.length > 0 && acceleratorDeviceId
							? {
									devices: [...existingAcceleratorDevices, `/dev/disk/by-umbrel-id/${acceleratorDeviceId}`],
								}
							: raid?.accelerator,
				})
			})

			// Initialize transition status and monitor rebuild progress in the background
			this.failsafeTransitionStatus = {state: 'rebuilding', progress: 0}
			this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)

			Promise.resolve()
				.then(async () => {
					while (true) {
						try {
							const status = await this.getPoolStatus(pool.name)
							if (status.rebuild) {
								const cappedProgress = status.rebuild.state === 'finished' ? 100 : Math.min(status.rebuild.progress, 99)
								if (cappedProgress > (this.failsafeTransitionStatus?.progress ?? 0)) {
									this.failsafeTransitionStatus = {state: 'rebuilding', progress: cappedProgress}
									this.logger.log(`Mirror rebuild progress: ${cappedProgress}%`)
									this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
								}
								if (status.rebuild.state === 'finished') break
							} else {
								// No rebuild status means resilver completed before first poll
								const allOnline = status.devices?.every((d) => d.status === 'ONLINE')
								if (allOnline && (status.devices?.length ?? 0) > existingDeviceIds.length) break
							}
						} catch (error) {
							this.logger.error('Error polling mirror rebuild progress', error)
						}
						await setTimeout(1000)
					}

					this.failsafeTransitionStatus = {state: 'complete', progress: 100}
					this.logger.log('Mirror failsafe transition complete')
					this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
					this.isTransitioningToFailsafe = false
				})
				.catch((error) => {
					this.failsafeTransitionStatus = {state: 'error', progress: 0, error: (error as Error).message}
					this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
					this.isTransitioningToFailsafe = false
				})

			return true
		} catch (error) {
			this.failsafeTransitionStatus = {state: 'error', progress: 0, error: (error as Error).message}
			this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
			this.isTransitioningToFailsafe = false
			throw error
		}
	}

}
