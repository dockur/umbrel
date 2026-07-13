import os from 'node:os'
import {isIPv4} from 'node:net'
import {randomBytes} from 'node:crypto'
import {setTimeout} from 'node:timers/promises'

import systemInformation from 'systeminformation'
import {$, type ExecaError} from 'execa'
import fse from 'fs-extra'
import PQueue from 'p-queue'

import type Umbreld from '../../index.js'

import getDirectorySize from '../utilities/get-directory-size.js'
import {escapeSpecialRegExpLiterals} from '../utilities/regexp.js'
import pWaitFor from 'p-wait-for'

export async function getCpuTemperature(): Promise<{
	warning: 'normal' | 'warm' | 'hot'
	temperature: number
}> {
	// Get CPU temperature
	const cpuTemperature = await systemInformation.cpuTemperature()
	if (typeof cpuTemperature.main !== 'number') throw new Error('Could not get CPU temperature')
	const temperature = cpuTemperature.main

	// Generic Intel thresholds
	let temperatureThreshold = {warm: 90, hot: 95}

	// Raspberry Pi thresholds
	if (await isRaspberryPi()) temperatureThreshold = {warm: 80, hot: 85}

	// Set warning level based on temperature
	let warning: 'normal' | 'warm' | 'hot' = 'normal'
	if (temperature >= temperatureThreshold.hot) warning = 'hot'
	else if (temperature >= temperatureThreshold.warm) warning = 'warm'

	return {
		warning,
		temperature,
	}
}

type DiskUsage = {
	id: string
	used: number
}

export async function getDiskUsageByPath(path: string): Promise<{size: number; totalUsed: number; available: number}> {
	if (typeof path !== 'string' || path === '') throw new Error('path must be a non-empty string')

	// Piggy back on df and get the result in bytes
	const df = await $`df --output=size,used,avail --block-size=1 ${path}`
	const [size, totalUsed, available] = df.stdout.split('\n').slice(-1)[0].split(' ').map(Number)

	return {size, totalUsed, available}
}

export async function getSystemDiskUsage(
	umbreld: Umbreld,
): Promise<{size: number; totalUsed: number; available: number}> {
	// TODO: Do this a cleaner way
	if (await umbreld.hardware.umbrelPro.isUmbrelPro()) {
		const pool = await umbreld.hardware.raid.getStatus()
		if (pool.exists) {
			return {
				size: pool.usableSpace ?? 0,
				totalUsed: pool.usedSpace ?? 0,
				available: pool.freeSpace ?? 0,
			}
		}
	}
	return await getDiskUsageByPath(umbreld.dataDirectory)
}

export async function getDiskUsage(
	umbreld: Umbreld,
): Promise<{size: number; totalUsed: number; system: number; files: number; apps: DiskUsage[]}> {
	const {size, totalUsed} = await getSystemDiskUsage(umbreld)

	// Get app disk usage
	const apps = await Promise.all(
		umbreld.apps.instances.map(async (app) => ({
			id: app.id,
			used: await app.getDiskUsage(),
		})),
	)
	const appsTotal = apps.reduce((total, app) => total + app.used, 0)

	const filesTotalUsage = (
		await Promise.all(
			[
				umbreld.files.getBaseDirectory('/Home'),
				umbreld.files.getBaseDirectory('/Trash'),
				umbreld.files.thumbnails.thumbnailDirectory,
			].map((directory) => getDirectorySize(directory).catch(() => 0)),
		)
	).reduce((total, usage) => total + usage, 0)

	const minSystemUsage = 2 * 1024 * 1024 * 1024 // 2GB

	return {
		size,
		totalUsed,
		system: Math.max(minSystemUsage, totalUsed - (appsTotal + filesTotalUsage)),
		files: filesTotalUsage,
		apps,
	}
}

function getProcMemoryField(contents: string, field: string): number | null {
	const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(contents)
	if (!match) return null
	const value = Number(match[1])
	if (!Number.isFinite(value) || value < 0) return null
	return clampByteCount(value * 1024)
}

function clampNonNegativeNumber(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.max(0, value)
}

function clampByteCount(value: number, max = Number.MAX_SAFE_INTEGER): number {
	const safeMax = clampNonNegativeNumber(max)
	const safeValue = clampNonNegativeNumber(value)
	return Math.min(safeMax, Math.round(safeValue))
}

// Parses Docker memory values such as "512MiB", "1.5GiB", or "200MB".
function parseDockerByteSize(value: string): number {
	const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)$/i)
	if (!match) return 0

	const amount = Number(match[1])
	if (!Number.isFinite(amount) || amount < 0) return 0

	const unit = match[2].toLowerCase()
	const multipliers: Record<string, number> = {
		b: 1,
		kb: 1_000,
		mb: 1_000_000,
		gb: 1_000_000_000,
		tb: 1_000_000_000_000,
		pb: 1_000_000_000_000_000,
		eb: 1_000_000_000_000_000_000,
		kib: 1024,
		mib: 1024 ** 2,
		gib: 1024 ** 3,
		tib: 1024 ** 4,
		pib: 1024 ** 5,
		eib: 1024 ** 6,
	}

	return clampByteCount(amount * (multipliers[unit] ?? 0))
}

// Returns the memory used by every running Docker container, keyed by name.
async function getDockerContainerMemory(umbreld: Umbreld): Promise<Map<string, number>> {
	try {
		const {stdout} = await $`docker stats --no-stream --format={{json .}}`
		const result = new Map<string, number>()

		for (const line of stdout.trim().split('\n')) {
			if (!line) continue

			try {
				const stats = JSON.parse(line) as {Name?: string; MemUsage?: string}
				const name = stats.Name ?? ''
				const memoryUsage = stats.MemUsage?.split('/')[0]?.trim() ?? ''

				if (name) result.set(name, parseDockerByteSize(memoryUsage))
			} catch (error) {
				umbreld.logger.error('Failed to parse Docker memory statistics', error)
			}
		}

		return result
	} catch (error) {
		umbreld.logger.error('Failed to read Docker memory statistics', error)
		return new Map()
	}
}

// Returns the reclaimable portion of ZFS ARC in bytes. ARC is a filesystem
// cache that MemAvailable doesn't account for. Under high memory pressure
// the ARC can shrink down to c_min, so the reclaimable portion is size - c_min.
async function getReclaimableZfsArcSize(): Promise<number> {
	try {
		const arcstats = await fse.readFile('/proc/spl/kstat/zfs/arcstats', 'utf8')
		const getField = (name: string) => {
			const match = arcstats.match(new RegExp(`^${name}\\s+\\d+\\s+(\\d+)$`, 'm'))
			return match ? parseInt(match[1], 10) : 0
		}
		return clampNonNegativeNumber(getField('size') - getField('c_min'))
	} catch {
		return 0
	}
}

// Returns total and pressure-relevant used memory from /proc/meminfo.
// Uses MemAvailable which reflects reclaimable memory and matches free/htop semantics.
// Also subtracts reclaimable ZFS ARC since MemAvailable doesn't account for it.
async function getSystemMemoryFromMeminfo(): Promise<{size: number; totalUsed: number}> {
	const [meminfo, arcSize] = await Promise.all([fse.readFile('/proc/meminfo', 'utf8'), getReclaimableZfsArcSize()])
	const size = clampByteCount(getProcMemoryField(meminfo, 'MemTotal') ?? 0)
	const memAvailable = clampByteCount(getProcMemoryField(meminfo, 'MemAvailable') ?? 0)
	const totalUsed = clampByteCount(size - memAvailable - arcSize, size)
	return {size, totalUsed}
}

type MemoryUsage = {
	id: string
	used: number
}

export async function getSystemMemoryUsage(): Promise<{
	size: number
	totalUsed: number
}> {
	return await getSystemMemoryFromMeminfo()
}

export async function getMemoryUsage(umbreld: Umbreld): Promise<{
	size: number
	totalUsed: number
	system: number
	apps: MemoryUsage[]
}> {
	// Read meminfo first so the measurement is not affected by Docker.
	const {size, totalUsed} = await getSystemMemoryFromMeminfo()
	const containerMemory = await getDockerContainerMemory(umbreld)

	const apps = await Promise.all(
		umbreld.apps.instances.map(async (app) => {
			try {
				const containerNames = await app.getContainerNames()
				const appUsed = containerNames.reduce((total, name) => total + (containerMemory.get(name) ?? 0), 0)

				return {
					id: app.id,
					used: clampByteCount(appUsed, size),
				}
			} catch (error) {
				umbreld.logger.error(`Error getting memory`, error)
				return {
					id: app.id,
					used: 0,
				}
			}
		}),
	)

	// Calculate memory used by the system (total - apps)
	const appsTotal = clampByteCount(apps.reduce((total, app) => total + app.used, 0))
	const system = clampByteCount(totalUsed - appsTotal, totalUsed)

	return {
		size,
		totalUsed,
		system,
		apps,
	}
}

// Returns a list of all processes and their cpu usage
async function getProcessesCpu() {
	// The container shares the host PID namespace, so top can run directly.
	const top = await $`top --batch-mode --iterations 1`

	// Get lines
	const lines = top.stdout.split('\n').map((line) => line.trim().split(/\s+/))

	// Find header and CPU column
	const headerIndex = lines.findIndex((line) => line[0] === 'PID')
	if (headerIndex === -1) {
		throw new Error('Unable to locate process header in top output')
	}

	const cpuIndex = lines[headerIndex].findIndex((column) => column === '%CPU')
	if (cpuIndex === -1) {
		throw new Error('Unable to locate CPU column in top output')
	}

	// Get CPU threads
	const threads = os.cpus().length

	// Ignore lines before the header
	return lines
		.slice(headerIndex + 1)
		.map((line) => ({
			pid: parseInt(line[0], 10),
			// Convert to % of total system, not % of a single thread
			cpu: parseFloat(line[cpuIndex]) / threads,
		}))
		.filter((process) => Number.isFinite(process.pid) && Number.isFinite(process.cpu))
}

type CpuUsage = {
	id: string
	used: number
}

export async function getCpuUsage(umbreld: Umbreld): Promise<{
	threads: number
	totalUsed: number
	system: number
	apps: CpuUsage[]
}> {
	// Get a snapshot of system CPU usage
	const processes = await getProcessesCpu()

	// Calculate total CPU used by all processes
	const totalUsed = processes.reduce((total, process) => total + process.cpu, 0)

	// Calculate CPU used by the processes owned by each app
	const apps = await Promise.all(
		umbreld.apps.instances.map(async (app) => {
			let appUsed = 0
			try {
				const appPids = await app.getPids()
				appUsed = processes
					.filter((process) => appPids.includes(process.pid))
					.reduce((total, process) => total + process.cpu, 0)
			} catch (error) {
				umbreld.logger.error(`Error getting cpu`, error)
			}
			return {
				id: app.id,
				used: appUsed,
			}
		}),
	)

	// Calculate CPU used by the system (total - apps)
	const appsTotal = apps.reduce((total, app) => total + app.used, 0)
	const system = Math.max(0, totalUsed - appsTotal)

	// Get total CPU threads
	const threads = os.cpus().length

	return {
		threads,
		totalUsed,
		system,
		apps,
	}
}

// TODO: For powercycle methods we will probably want to handle cleanly stopping
// as much Umbrel stuff as possible ourselves before handing over to the OS.
// This will give us more control over the order of things terminating and allow
// us to communicate shutdown progress with the user for as long as possible before
// umbreld gets killed.

export async function shutdown(): Promise<boolean> {
	process.kill(process.pid, 'SIGTERM')

	return true
}

export async function reboot(): Promise<boolean> {
	process.kill(process.pid, 'SIGUSR1')

	return true
}

export async function commitOsPartition(umbreld: Umbreld): Promise<boolean> {
	return true
}

export async function detectDevice() {
	let {manufacturer, model, serial, uuid, sku, version} = await systemInformation.system()
	let productName = model
	model = sku
	let device = productName // TODO: Maybe format this better in the future.

	// Used for update server
	let deviceId = 'unknown'

	if (model === 'U130120') device = 'Umbrel Home (2023)'
	if (model === 'U130121') device = 'Umbrel Home (2024)'
	if (model === 'U130122') device = 'Umbrel Home (2025)'
	if (productName === 'Umbrel Home') deviceId = model

	// No year suffix for Umbrel Pro until if/when a newer model exists
	if (model === 'U4XN1') device = 'Umbrel Pro'
	if (productName === 'Umbrel Pro') deviceId = model

	// I haven't been able to find another way to reliably detect Pi hardware. Most existing
	// solutions don't actually detect Pi hardware but just detect Pi OS which we don't match.
	// e.g systemInformation includes Pi detection which fails here. Also there's no SMBIOS so
	// no values like manufacturer or model to check. I did notice the Raspberry Pi model is
	// appended to the output of `/proc/cpuinfo` so we can use that to detect Pi hardware.
	try {
		const cpuInfo = await fse.readFile('/proc/cpuinfo')
		if (cpuInfo.includes('Raspberry Pi ')) {
			manufacturer = 'Raspberry Pi'
			productName = 'Raspberry Pi'
			model = version
			if (cpuInfo.includes('Raspberry Pi 5 ')) {
				device = 'Raspberry Pi 5'
				deviceId = 'pi-5'
			}
			if (cpuInfo.includes('Raspberry Pi 4 ')) {
				device = 'Raspberry Pi 4'
				deviceId = 'pi-4'
			}
		}
	} catch {
		// /proc/cpuinfo might not exist on some systems, do nothing.
	}

	// Blank out model and serial for non Umbrel devices
	if (productName !== 'Umbrel Home' && productName !== 'Umbrel Pro') {
		model = ''
		serial = ''
	}

	return {deviceId, device, productName, manufacturer, model, serial, uuid}
}

export async function isRaspberryPi() {
	const {productName} = await detectDevice()
	return productName === 'Raspberry Pi'
}

export async function isUmbrelOS() {
	return fse.exists('/umbrelOS')
}

export async function setCpuGovernor(governor: string) {
	await fse.writeFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', governor)
}

export async function setupPiCpuGovernor(umbreld: Umbreld): Promise<void> {
	try {
		if (await isRaspberryPi()) {
			await setCpuGovernor('ondemand')
			umbreld.logger.log(`Set ondemand cpu governor`)
		}
	} catch (error) {
		umbreld.logger.error(`Failed to set ondemand cpu governor`, error)
	}
}

export async function hasWifi() {
	return false
}

export async function getWifiNetworks() {
	return []
}

export async function deleteWifiConnections({inactiveOnly = false}: {inactiveOnly?: boolean}) {
	return
}

export async function connectToWiFiNetwork({ssid, password}: {ssid: string; password?: string}) {
	return false
}

export async function restoreWiFi(umbreld: Umbreld): Promise<void> {
	return
}

// Get IP addresses of the device
export function getIpAddresses(): string[] {
	// Known good interfaces:
	// - Umbrel Home 2024: enp1s0, wlo1 (predictable naming)
	// - Raspberry Pi 4/5: end0, wlan0 (custom naming)
	// - Docker Dev: eth0 (traditional naming)
	const excludeInterfaceNames = [
		// Bridge interfaces
		/^br\-/,
		// Known Docker-specific interfaces
		/^docker/,
		/^services/,
		// Virtual ethernet (pairs)
		/^veth/,
		// TODO: Tunnel interfaces?
		// /^tun/,
	]
	// Known good IPv4 ranges:
	// - Class A private: 10.0.0.0/8 := /^10\./
	// - Class B private: 172.16.0.0/12 := /^172\.(1[6-9]|2[0-9]|3[0-1])\./
	// - Class C private: 192.168.0.0/16 := /^192\.168\./
	const excludeAddressRanges = [
		// Local loopback (127.0.0.0/8)
		/^127\./,
		// Docker internal network (10.21.0.0/16)
		/^10\.21\./,
		// Non-routable APIPA (169.254.0.0/16), e.g. misconfigured DHCP
		/^169\.254\./,
	]
	return (
		Object.entries(os.networkInterfaces())
			// Omit interfaces with excluded names
			.filter(([name]) => !excludeInterfaceNames.some((expression) => expression.test(name)))
			// Flatten interface map to an array of addresses
			.flatMap(([name, addresses = []]) => addresses.map((address) => ({name, ...address})))
			// Select valid non-loopback IPv4 addresses
			.filter((entry) => entry.family === 'IPv4' && !entry.internal && isIPv4(entry.address))
			// Omit addresses within excluded ranges
			.filter((entry) => !excludeAddressRanges.some((expression) => expression.test(entry.address)))
			// Return remaining addresses
			.map((entry) => entry.address)
	)
}

type NetworkInterface = {
	id: string
	mac: string
	type: 'ethernet' | 'wifi'
	connected: boolean
	configuredStaticSettings?: {
		ip: string
		subnetPrefix: number
		gateway: string
		dns: string[]
	}
	ipMethod?: 'dhcp' | 'static'
	ip?: string
	subnetPrefix?: number
	gateway?: string
	dns?: string[]
}

// Get all physical network interfaces with connection details
export async function getNetworkInterfaces(umbreld?: Umbreld): Promise<NetworkInterface[]> {
	return []
}

// Track confirmed static IP — set by confirmStaticIp endpoint when client pings back
let confirmedStaticIp = ''

export function confirmStaticIp(ip: string) {
	confirmedStaticIp = ip
}

// Set a static IP configuration on a network interface
export async function setStaticIp(
	umbreld: Umbreld,
	config: {mac: string; ip: string; subnetPrefix: number; gateway: string; dns: string[]},
) {
	return
}

// Clear static IP and revert to DHCP
export async function clearStaticIp(umbreld: Umbreld, {mac}: {mac: string}) {
	return
}

// Restore static IP settings from store on startup
export async function restoreStaticIp(umbreld: Umbreld): Promise<void> {
	return
}

const syncDnsQueue = new PQueue({concurrency: 1})

// Update DNS configuration to match user settings
export async function syncDns() {
	return true
}

// Wait for Pi system time to be synced for up to the number of seconds passed in.
export async function waitForSystemTime(umbreld: Umbreld, timeout: number): Promise<void> {
	try {
		// Only run on Pi
		if (!(await isRaspberryPi())) return

		umbreld.logger.log('Checking if system time is synced before continuing...')
		let tries = 0
		while (tries < timeout) {
			tries++
			const timeStatus = await $`timedatectl status`
			const isSynced = timeStatus.stdout.includes('System clock synchronized: yes')
			if (isSynced) {
				umbreld.logger.log('System time is synced. Continuing...')
				return
			}
			umbreld.logger.log('System time is not currently synced, waiting...')
			await setTimeout(1000)
		}
		umbreld.logger.error('System time is not synced but timeout was reached. Continuing...')
	} catch (error) {
		umbreld.logger.error(`Failed to check system time`, error)
	}
}

export async function getHostname() {
	const hostname = await fse.readFile('/etc/hostname', 'utf8')
	return hostname.trim()
}

async function applyHostname(umbreld: Umbreld, hostname: string) {
	return hostname
}

export async function setHostname(umbreld: Umbreld, hostname: string) {
	const previousConfiguredHostname = await umbreld.store.get('settings.hostname')

	await umbreld.store.set('settings.hostname', hostname)
	try {
		return await applyHostname(umbreld, hostname)
	} catch (error) {
		if (previousConfiguredHostname) await umbreld.store.set('settings.hostname', previousConfiguredHostname)
		else await umbreld.store.delete('settings.hostname')
		throw error
	}
}

export async function restoreHostname(umbreld: Umbreld) {
	const configuredHostname = await umbreld.store.get('settings.hostname')
	if (!configuredHostname) return
	try {
		await applyHostname(umbreld, configuredHostname)
	} catch (error) {
		umbreld.logger.error(`Failed to restore hostname`, error)
	}
}
