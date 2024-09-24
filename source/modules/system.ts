import os from 'node:os'

import systemInformation from 'systeminformation'
import {$} from 'execa'
import fse from 'fs-extra'

import type Umbreld from '../index.js'

import getDirectorySize from './utilities/get-directory-size.js'

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

export async function getSystemDiskUsage(umbreld: Umbreld): Promise<{size: number; totalUsed: number}> {
	if (typeof umbreld.dataDirectory !== 'string' || umbreld.dataDirectory === '') {
		throw new Error('umbreldDataDir must be a non-empty string')
	}

	// to calculate the disk usage of each app
	const fileSystemSize = await systemInformation.fsSize()

	// Get the disk usage information for the file system containing the Umbreld data dir.
	// Sort by mount length to get the most specific mount point
	const df = await $`df -h ${umbreld.dataDirectory}`
	const partition = df.stdout.split('\n').slice(-1)[0].split(' ')[0]
	const dataDirectoryFilesystem = fileSystemSize.find((filesystem) => filesystem.fs === partition)

	if (!dataDirectoryFilesystem) {
		throw new Error('Could not find file system containing Umbreld data directory')
	}

	const {size, used} = dataDirectoryFilesystem

	return {
		size,
		totalUsed: used,
	}
}

export async function getDiskUsage(
	umbreld: Umbreld,
): Promise<{size: number; totalUsed: number; system: number; downloads: number; apps: DiskUsage[]}> {
	const {size, totalUsed} = await getSystemDiskUsage(umbreld)

	// Get app disk usage
	const apps = await Promise.all(
		umbreld.apps.instances.map(async (app) => ({
			id: app.id,
			used: await app.getDiskUsage(),
		})),
	)
	const appsTotal = apps.reduce((total, app) => total + app.used, 0)

	const downloadsDirectory = `${umbreld.dataDirectory}/data/storage/downloads/`
	let downloads = 0
	if (await fse.pathExists(downloadsDirectory)) downloads = await getDirectorySize(downloadsDirectory)

	const minSystemUsage = 2 * 1024 * 1024 * 1024 // 2GB

	return {
		size,
		totalUsed,
		system: Math.max(minSystemUsage, totalUsed - (appsTotal + downloads)),
		downloads,
		apps,
	}
}

// Returns a list of all processes and their memory usage
async function getProcessesMemory() {
	// Get a snapshot of system CPU and memory usage
	const ps = await $`ps -Ao pid,pss --no-header`

	// Format snapshot data
	const processes = ps.stdout.split('\n').map((line) => {
		// Parse values
		const [pid, pss] = line
			.trim()
			.split(/\s+/)
			.map((value) => Number(value))
		return {
			pid,
			// Convert proportional set size from kilobytes to bytes
			memory: pss * 1000,
		}
	})

	return processes
}

type MemoryUsage = {
	id: string
	used: number
}

export async function getSystemMemoryUsage(): Promise<{
	size: number
	totalUsed: number
}> {
	// Get total memory size
	const {total: size} = await systemInformation.mem()

	// Get a snapshot of system memory usage
	const processes = await getProcessesMemory()

	// Calculate total memory used by all processes
	const totalUsed = processes.reduce((total, process) => total + process.memory, 0)

	return {
		size,
		totalUsed,
	}
}

export async function getMemoryUsage(umbreld: Umbreld): Promise<{
	size: number
	totalUsed: number
	system: number
	apps: MemoryUsage[]
}> {
	// Get a snapshot of system memory usage
	const processes = await getProcessesMemory()

	// Get total and used memory size
	const {size, totalUsed} = await getSystemMemoryUsage()

	// Calculate memory used by the processes owned by each app
	const apps = await Promise.all(
		umbreld.apps.instances.map(async (app) => {
			let appUsed = 0
			try {
				const appPids = await app.getPids()
				appUsed = processes
					.filter((process) => appPids.includes(process.pid))
					.reduce((total, process) => total + process.memory, 0)
			} catch (error) {
				umbreld.logger.error(`Error getting memory: ${(error as Error).message}`)
			}
			return {
				id: app.id,
				used: appUsed,
			}
		}),
	)

	// Calculate memory used by the system (total - apps)
	const appsTotal = apps.reduce((total, app) => total + app.used, 0)
	const system = Math.max(0, totalUsed - appsTotal)

	return {
		size,
		totalUsed,
		system,
		apps,
	}
}

// Returns a list of all processes and their cpu usage
async function getProcessesCpu() {
	// Get a snapshot of system CPU and memory usage
	const top = await $`top --batch-mode --iterations 1`

	// Get lines
	const lines = top.stdout.split('\n').map((line) => line.trim().split(/\s+/))

	// Find header and CPU column
	const headerIndex = lines.findIndex((line) => line[0] === 'PID')
	const cpuIndex = lines[headerIndex].findIndex((column) => column === '%CPU')

	// Get CPU threads
	const threads = os.cpus().length

	// Ignore lines before the header
	const processes = lines.slice(headerIndex + 1).map((line) => {
		// Parse values
		return {
			pid: parseInt(line[0], 10),
			// Convert to % of total system not % of a single thread
			cpu: parseFloat(line[cpuIndex]) / threads,
		}
	})

	return processes
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
				umbreld.logger.error(`Error getting cpu: ${(error as Error).message}`)
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
	await $`pkill -f umbreld`

	return true
}

export async function reboot(): Promise<boolean> {
	await $`pkill -f umbreld`

	return true
}

export async function commitOsPartition(umbreld: Umbreld): Promise<boolean> {
	umbreld.logger.error(`Failed to commit OS partition`)
	return false
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
	if (productName === 'Umbrel Home') deviceId = model

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
	} catch (error) {
		// /proc/cpuinfo might not exist on some systems, do nothing.
	}

	// Blank out model and serial for non Umbrel Home devices
	if (productName !== 'Umbrel Home') {
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

export async function hasWifi() {
	return false
}

export async function getWifiNetworks() {
	return []
}

export async function deleteWifiConnections({inactiveOnly = false}: {inactiveOnly?: boolean}) {
	throw new Error('Not supported')
}

export async function connectToWiFiNetwork({ssid, password}: {ssid: string; password?: string}) {
	throw new Error('Not supported')
}

// Get IP addresses of the device
export async function getIpAddresses(): Promise<string[]> {
	const interfaces =
		(await systemInformation.networkInterfaces()) as systemInformation.Systeminformation.NetworkInterfacesData[]

	// Filter out virtual interfaces, non-wired/wireless interfaces, bridge
	// interfaces starting with 'br-', and interfaces without ip4
	const validInterfaces = interfaces.filter(
		(iface) =>
			!iface.virtual &&
			(iface.type === 'wired' || iface.type === 'wireless') &&
			!iface.ifaceName.startsWith('br-') &&
			iface.ip4,
	)

	// Get the ip4 addresses
	const ipAddresses = validInterfaces.map((iface) => iface.ip4)

	return ipAddresses
}
