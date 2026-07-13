import {createHash} from 'node:crypto'
import nodePath from 'node:path'
import {setTimeout} from 'node:timers/promises'

import {execa, ExecaError, ExecaChildProcess} from 'execa'
import fse from 'fs-extra'
import pQueue from 'p-queue'
import prettyBytes from 'pretty-bytes'

import randomToken from '../../modules/utilities/random-token.js'
import {copyWithProgress} from '../utilities/copy-with-progress.js'

// TODO: These should be refactored into proper umbreld modules
import {getSystemDiskUsage} from '../system/system.js'
import {setSystemStatus} from '../system/routes.js'
import {reboot} from '../system/system.js'
import {BACKUP_RESTORE_FIRST_START_FLAG} from '../../constants.js'
import type Umbreld from '../../index.js'
import type {ProgressStatus} from '../apps/schema.js'

type Backup = {
	// Our internal id in the format: <repositoryId>:<snapshotId>
	id: string
	time: number
	size: number
}

type BackupProgress = {
	repositoryId: string
	percent: number
}

// RestoreStatus extends ProgressStatus with optional restore-specific fields
// ProgressStatus includes: running: boolean, progress: number (0-100), description: string, error: boolean | string
export type RestoreStatus = ProgressStatus & {
	backupId?: string
	bytesPerSecond?: number
	secondsRemaining?: number
}

export type BackupsInProgress = BackupProgress[]

export default class Backups {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	internalMountPath: string
	backupRoot: string
	backupsInProgress: BackupsInProgress = []
	restoreStatus: RestoreStatus = {
		running: false,
		progress: 0,
		description: '',
		error: false,
		// backupId, bytesPerSecond, and secondsRemaining are undefined by default
	}
	running = false
	startedAt?: number
	backupInterval = 1000 * 60 * 60 // 1 hour
	backupJobPromise?: Promise<void>
	kopiaQueue = new pQueue({concurrency: 1})
	backupDirectoryName = 'Umbrel Backup.backup'
	runningKopiaProcesses: ExecaChildProcess[] = []

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLocaleLowerCase())
		this.internalMountPath = nodePath.join(umbreld.dataDirectory, 'backup-mounts')
		this.backupRoot = umbreld.files.getBaseDirectory('/Backups')
	}

	async start() {
		this.logger.log('Starting backups')
		this.running = true
		this.startedAt = Date.now()

		// Fire off background backup process
		this.backupJobPromise = this.backupOnInterval().catch((error) =>
			this.logger.error('Error running backups on interval', error),
		)
	}

	async stop() {
		this.logger.log('Stopping backups')
		this.running = false

		const ONE_SECOND = 1000

		// Kill any running kopia processes
		for (const process of this.runningKopiaProcesses) process.kill('SIGTERM', {forceKillAfterTimeout: ONE_SECOND * 3})

		// Wait for any backup jobs (up to 5s)
		await Promise.race([
			setTimeout(ONE_SECOND * 5),
			(async () => {
				this.logger.log('Waiting for any backup job to finish')
				if (this.backupJobPromise) await this.backupJobPromise.catch(() => {})
				await Promise.allSettled(this.runningKopiaProcesses)
			})(),
		])
	}

	// Run backups in background
	async backupOnInterval() {
		this.logger.log('Scheduling backups interval')
		let lastRun = Date.now()
		while (this.running) {
			await setTimeout(100)
			const userExists = await this.#umbreld.user.exists()
			const shouldRun = userExists && !this.restoreStatus.running && Date.now() - lastRun >= this.backupInterval
			if (!shouldRun) continue
			lastRun = Date.now()

			this.logger.log('Running backups interval')
			const repositories = await this.getRepositories().catch((error) => {
				this.logger.error('Error getting repositories', error)
				return []
			})

			// Run each backup
			for (const repository of repositories) {
				// Skip if we're shutting down
				if (!this.running) break

				// Skip if we already have a backup in progress
				const isAlreadyBackingUp = this.backupsInProgress.some((progress) => progress.repositoryId === repository.id)
				if (isAlreadyBackingUp) {
					this.logger.log(`Backup already in progress for ${repository.path}`)
				} else {
					await this.backup(repository.id).catch((error) =>
						this.logger.error(`Error backing up ${repository.id}`, error),
					)
				}

				// Alert the user if backups have failed for over 24 hours
				const {lastBackup} = await this.getRepository(repository.id)
				const hoursSinceLastBackup = (Date.now() - (lastBackup || this.startedAt!)) / (1000 * 60 * 60)
				if (hoursSinceLastBackup > 24) {
					this.logger.error(`Backup for ${repository.path} has not run in over 24 hours`)
					await this.#umbreld.notifications.add(`backups-failing:${repository.id}`).catch(() => {})
				}
			}

			this.logger.log('Backups interval complete')
		}
	}

	async getRepositories() {
		return (await this.#umbreld.store.get('backups.repositories')) || []
	}

	async getRepository(id: string) {
		const repositories = await this.getRepositories()
		const repository = repositories.find((repository) => repository.id === id)
		if (!repository) throw new Error(`Repository ${id} not found`)
		return repository
	}

	async kopia(
		flags: string[] = [],
		{onOutput, bypassQueue = true}: {onOutput?: (output: string) => void; bypassQueue?: boolean} = {},
	) {
		if (!this.running) throw new Error('[shutting-down] Refusing to spawn new kopia processes')

		const spawnKopiaProcess = async () => {
			const env = {
				KOPIA_CHECK_FOR_UPDATES: 'false',
				XDG_CACHE_HOME: '/kopia/cache',
				XDG_CONFIG_HOME: '/kopia/config',
			}
			const process = execa('kopia', flags, {env})

			this.runningKopiaProcesses.push(process)
			process
				.finally(() => (this.runningKopiaProcesses = this.runningKopiaProcesses.filter((p) => p !== process)))
				.catch(() => {})

			const handleOutput = (data: Buffer) => {
				const line = data.toString()
				this.logger.verbose(line.trim())
				onOutput?.(line)
			}
			process.stdout?.on('data', (data) => handleOutput(data))
			process.stderr?.on('data', (data) => handleOutput(data))

			return process
		}

		return bypassQueue ? spawnKopiaProcess() : this.kopiaQueue.add(spawnKopiaProcess)
	}

	async createRepository(virtualPath: string, password: string) {
		const createNew = true
		return this.addRepository(virtualPath, password, createNew)
	}

	async connectToExistingRepository(virtualPath: string, password: string) {
		const createNew = false
		return this.addRepository(virtualPath, password, createNew)
	}

	async addRepository(virtualPath: string, password: string, createNew = true) {
		virtualPath = nodePath.join(virtualPath, this.backupDirectoryName)

		const systemPath = await this.#umbreld.files.virtualToSystemPath(virtualPath).catch(() => '')
		const isNetworkPath = systemPath.startsWith(this.#umbreld.files.getBaseDirectory('/Network'))
		const isExternalPath = systemPath.startsWith(this.#umbreld.files.getBaseDirectory('/External'))
		if (!isNetworkPath && !isExternalPath) throw new Error(`Invalid path ${virtualPath}`)

		password = createHash('sha256').update(password).digest('hex').slice(0, 16)
		const id = createHash('sha256').update(virtualPath).digest('hex').slice(0, 8)

		if (createNew) {
			this.logger.log(`Creating repository ${id}`)
			await fse.mkdir(systemPath, {recursive: false}).catch((error) => {
				if (error.code === 'EEXIST') throw new Error(`Repository already exists at ${virtualPath}`)
				throw error
			})
			await this.#umbreld.files.chownSystemPath(systemPath).catch(() => {})

			await this.kopia([
				'repository',
				'create',
				'filesystem',
				`--path=${systemPath}`,
				`--config-file=/kopia/config/${id}.config`,
				`--password=${password}`,
			])
		}

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const repositories = await this.getRepositories()
			const repositoryExists = repositories.some((existingRepository) => existingRepository.id === id)
			if (!repositoryExists) repositories.push({id, path: virtualPath, password})
			await set('backups.repositories', repositories)
		})

		await this.connect(id).catch(async (error) => {
			if (!createNew) await this.forgetRepository(id).catch(() => {})
			throw error
		})

		this.logger.log(`Connected to repository ${id}`)
		return id
	}

	async forgetRepository(repositoryId: string) {
		this.logger.log(`Forgetting repository ${repositoryId}`)

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			let repositories = await this.getRepositories()
			repositories = repositories.filter((repository) => repository.id !== repositoryId)
			await set('backups.repositories', repositories)
		})

		this.logger.log(`Forgot repository ${repositoryId}`)
	}

	async restoreBackup(backupId: string) {
		if (this.restoreStatus.running) throw new Error('[in-progress] Restore already in progress')
		let success = false

		const backup = await this.getBackup(backupId)
		const diskUsage = await getSystemDiskUsage(this.#umbreld)
		const buffer = 1024 * 1024 * 1024 * 5
		const neededSpace = backup.size + buffer
		if (diskUsage.available < neededSpace) throw new Error('[not-enough-space] Not enough free space to restore backup')

		this.logger.log(`Restoring backup ${backupId}`)
		setSystemStatus('restoring')
		const temporaryData = `${this.#umbreld.dataDirectory}/.temporary-migration`
		const finalData = `${this.#umbreld.dataDirectory}/import`

		this.restoreStatus = {
			running: true,
			progress: 0,
			description: 'Restoring backup',
			error: false,
			backupId,
			bytesPerSecond: 0,
		}
		this.#umbreld.eventBus.emit('backups:restore-progress', this.restoreStatus)

		try {
			const backupDirectoryName = await this.mountBackup(backupId)
			const internalBackupMountpoint = nodePath.join(this.internalMountPath, backupDirectoryName)

			await fse.remove(temporaryData)
			let previousProgress: number
			await copyWithProgress(`${internalBackupMountpoint}/`, temporaryData, (progress) => {
				this.restoreStatus.progress = progress.progress
				this.restoreStatus.bytesPerSecond = progress.bytesPerSecond
				this.restoreStatus.secondsRemaining = progress.secondsRemaining
				this.#umbreld.eventBus.emit('backups:restore-progress', this.restoreStatus)
				if (previousProgress !== this.restoreStatus.progress) {
					previousProgress = this.restoreStatus.progress
					this.logger.log(`Restored ${this.restoreStatus.progress}% of backup`)
				}
			})

			await fse.ensureFile(`${temporaryData}/${BACKUP_RESTORE_FIRST_START_FLAG}`).catch(() => {})
			await fse.move(temporaryData, finalData, {overwrite: true})
			success = true
		} finally {
			if (!success) {
				fse.remove(temporaryData).catch(() => {})
				this.unmountAll().catch(() => {})

				this.restoreStatus = {
					running: false,
					progress: 0,
					description: 'Restore failed',
					error: 'Restore failed',
				}
				this.#umbreld.eventBus.emit('backups:restore-progress', this.restoreStatus)
			}

			if (!success || process.env.UMBRELD_RESTORE_SKIP_REBOOT === 'true') setSystemStatus('running')
		}

		if (success) {
			this.restoreStatus = {
				running: false,
				progress: 100,
				description: 'Restore complete',
				error: false,
			}
			this.#umbreld.eventBus.emit('backups:restore-progress', this.restoreStatus)

			if (process.env.UMBRELD_RESTORE_SKIP_REBOOT !== 'true') {
				this.logger.log(`Rebooting into newly recovered data`)
				setSystemStatus('restarting')
				await this.#umbreld.stop().catch(() => {})
				await reboot()
			}
		}
	}

	private async connect(repositoryId: string) {
		const repository = await this.getRepository(repositoryId)
		const systemPath = this.#umbreld.files.virtualToSystemPathUnsafe(repository.path)

		await this.kopia([
			'repository',
			'connect',
			'filesystem',
			`--path=${systemPath}`,
			`--config-file=/kopia/config/${repository.id}.config`,
			`--password=${repository.password}`,
			'--override-hostname=umbrel',
		])
	}

	async repository(
		repositoryId: string,
		flags: string[] = [],
		{onOutput, bypassQueue = true}: {onOutput?: (output: string) => void; bypassQueue?: boolean} = {},
	) {
		await this.connect(repositoryId)
		return this.kopia([...flags, `--config-file=/kopia/config/${repositoryId}.config`], {onOutput, bypassQueue})
	}

	async getRepositorySize(repositoryId: string) {
		const repository = await this.getRepository(repositoryId)
		const stats = await this.repository(repository.id, ['content', 'stats', '--raw'])
		const sizeLinePattern = 'Total Packed: '
		const sizeLine = stats.stdout.split('\n').find((line) => line.startsWith(sizeLinePattern)) || ''
		const used = Number(sizeLine.replace(sizeLinePattern, '').split(' ')[0])

		const status = await this.repository(repository.id, ['repository', 'status', '--json'])
		const {capacity, available} = JSON.parse(status.stdout).volume
		return {used, capacity, available}
	}

	async backup(repositoryId: string) {
		const repository = await this.getRepository(repositoryId)
		this.logger.log(`Backing up to ${repository.path}`)

		this.logger.log(`Ensuring policy is enforced`)
		await this.repository(repository.id, [
			'policy',
			'set',
			'--global',
			'--keep-latest=10',
			'--keep-hourly=24',
			'--keep-daily=7',
			'--keep-weekly=4',
			'--keep-monthly=12',
			'--keep-annual=0',
			'--compression=zstd-fastest',
			'--one-file-system=true',
			'--max-parallel-file-reads=1',
		])

		this.logger.log(`Retention policy enforced`)
		this.logger.verbose(`Ensuring ignore file is up to date`)
		await this.createIgnoreFile()

		const backupProgress: BackupProgress = {repositoryId, percent: 0}
		this.backupsInProgress.push(backupProgress)
		this.#umbreld.eventBus.emit('backups:backup-progress', this.backupsInProgress)

		try {
			this.logger.log(`Creating snapshot`)
			await this.repository(repository.id, ['snapshot', 'create', this.#umbreld.dataDirectory], {
				onOutput: (output) => {
					const match = output.match(/estimated.*\((\d+(?:\.\d+)?)%\).*left/)
					if (!match) return

					backupProgress.percent = Number(match[1])
					this.#umbreld.eventBus.emit('backups:backup-progress', this.backupsInProgress)
				},
			})

			await this.#umbreld.notifications.clear(`backups-failing:${repository.id}`).catch(() => {})
			this.logger.log(`Backed up ${repository.path}`)

			await this.#umbreld.store.getWriteLock(async ({set}) => {
				const repositories = await this.getRepositories()
				repositories.find((repository) => repository.id === repositoryId)!.lastBackup = Date.now()
				await set('backups.repositories', repositories)
			})

			const size = await this.getRepositorySize(repository.id)
			this.logger.log(
				`${repository.path} size after backup: Used ${prettyBytes(size.used)} of ${prettyBytes(size.capacity)}`,
			)

			return true
		} finally {
			this.backupsInProgress = this.backupsInProgress.filter((progress) => progress !== backupProgress)
			this.#umbreld.eventBus.emit('backups:backup-progress', this.backupsInProgress)
		}
	}

	async getIgnoredPaths() {
		return (await this.#umbreld.store.get('backups.ignore')) || []
	}

	async addIgnoredPath(path: string) {
		path = nodePath.resolve(path)
		const isHomePath = path === '/Home' || path.startsWith('/Home/')
		if (!isHomePath) throw new Error(`Path to exclude must be in /Home`)

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const ignore = Array.from(new Set([...(await this.getIgnoredPaths()), path]))
			await set('backups.ignore', ignore)
		})

		return true
	}

	async removeIgnoredPath(path: string) {
		path = nodePath.resolve(path)
		const isHomePath = path === '/Home' || path.startsWith('/Home/')
		if (!isHomePath) throw new Error(`Path to exclude must be in /Home`)

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			let ignore = await this.getIgnoredPaths()
			ignore = ignore.filter((p) => p !== path)
			await set('backups.ignore', ignore)
		})

		return true
	}

	async createIgnoreFile() {
		const ignoreFilePath = nodePath.join(this.#umbreld.dataDirectory, '.kopiaignore')
		let ignoreFileContents: string[] = []

		ignoreFileContents.push('app-stores')
		ignoreFileContents.push(this.#umbreld.files.thumbnails.thumbnailDirectory)
		ignoreFileContents.push('.temporary-migration')
		ignoreFileContents.push(this.internalMountPath)
		ignoreFileContents.push(this.backupRoot)

		const alwaysIgnoredPaths = ['/External', '/Network']
		const userIgnoredPaths = await this.getIgnoredPaths().catch(() => [])
		;[...alwaysIgnoredPaths, ...userIgnoredPaths].forEach((path) => {
			try {
				const systemPath = this.#umbreld.files.virtualToSystemPathUnsafe(path)
				ignoreFileContents.push(systemPath)
			} catch (error) {
				this.logger.error(`Failed to get system path for ignored path ${path}`, error)
			}
		})

		await Promise.all(
			this.#umbreld.apps.instances.map(async (app) => {
				const isIgnored = await app.isBackupIgnored().catch((error) => {
					this.logger.error(`Failed to get backup ignored status for ${app.id}`, error)
					return false
				})
				if (isIgnored) ignoreFileContents.push(app.dataDirectory)

				const backupIgnore = await app.getBackupIgnoredFilePaths().catch((error) => {
					this.logger.error(`Failed to get backup ignored file paths for ${app.id}`, error)
					return []
				})
				ignoreFileContents.push(...backupIgnore)
			}),
		)

		ignoreFileContents = ignoreFileContents.map((path) => {
			if (path.startsWith(this.#umbreld.dataDirectory)) path = nodePath.relative(this.#umbreld.dataDirectory, path)
			if (!path.startsWith('/')) path = `/${path}`
			return path
		})

		const temporaryIgnoreFilePath = `${ignoreFilePath}.${randomToken(32)}`
		await fse.writeFile(temporaryIgnoreFilePath, ignoreFileContents.join('\n'))
		await fse.move(temporaryIgnoreFilePath, ignoreFilePath, {overwrite: true})
	}

	async listBackups(repositoryId: string) {
		const repository = await this.getRepository(repositoryId)
		this.logger.log(`Listing backups for ${repository.path}`)

		const snapshots = await this.repository(repository.id, ['snapshot', 'list', '--json'])
		const snapshotsParsed = JSON.parse(snapshots.stdout)

		const backups: Backup[] = []
		for (const snapshot of snapshotsParsed) {
			backups.push({
				id: `${repositoryId}:${snapshot.id}`,
				time: new Date(snapshot.startTime).getTime(),
				size: Number(snapshot.stats.totalSize),
			})
		}

		return backups.sort((a, b) => a.time - b.time)
	}

	async listAllBackups() {
		const repositories = await this.getRepositories()
		const backups: Backup[] = []

		await Promise.all(
			repositories.map(async (repository) => {
				const repositoryBackups = await this.listBackups(repository.id).catch((error) => {
					this.logger.error(`Failed to list backups for ${repository.id}`, error)
					return []
				})
				backups.push(...repositoryBackups)
			}),
		)

		return backups.sort((a, b) => a.time - b.time)
	}

	parseBackupId(backupId: string) {
		const [repositoryId, snapshotId] = backupId.split(':')
		return {repositoryId, snapshotId}
	}

	async getBackup(backupId: string) {
		const {repositoryId} = this.parseBackupId(backupId)
		const backups = await this.listBackups(repositoryId)
		const backup = backups.find((backup) => backup.id === backupId)
		if (!backup) throw new Error(`[not-found] Backup ${backupId} not found`)
		return backup
	}

	async listBackupFiles(backupId: string, path = '/') {
		const {repositoryId, snapshotId} = this.parseBackupId(backupId)
		const ls = await this.repository(repositoryId, ['ls', `${snapshotId}${path}`])
		return ls.stdout.split('\n')
	}

	async mountBackup(backupId: string) {
		const {repositoryId, snapshotId} = this.parseBackupId(backupId)
		const backup = await this.getBackup(backupId)
		if (!backup) throw new Error(`Backup ${backupId} not found`)

		this.logger.log(`Mounting backup ${backupId}`)
		const directoryName = new Date(backup.time).toISOString()
		const internalMountpoint = nodePath.join(this.internalMountPath, directoryName)
		await fse.mkdir(internalMountpoint, {recursive: true})

		let mountProcessExitCode = null
		this.repository(repositoryId, ['mount', snapshotId, internalMountpoint], {bypassQueue: true})
			.then((process) => (mountProcessExitCode = process.exitCode))
			.catch((error) => {
				this.logger.error(`Failed to mount backup ${backupId}`, error)
				mountProcessExitCode = (error as ExecaError).exitCode
			})

		const startTime = Date.now()
		const timeout = 10_000

		while (true) {
			if (Date.now() - startTime > timeout) throw new Error(`Mount timeout after ${timeout}ms`)
			if (mountProcessExitCode !== null) throw new Error(`Mount exited with code ${mountProcessExitCode}`)

			const contents = await fse.readdir(internalMountpoint).catch(() => [])
			if (contents.length > 0) break

			await setTimeout(100)
		}

		const backupRoot = nodePath.join(this.backupRoot, directoryName)
		const homeMount = nodePath.join(backupRoot, 'Home')
		const appsMount = nodePath.join(backupRoot, 'Apps')

		await fse.mkdir(homeMount, {recursive: true})
		await fse.mkdir(appsMount, {recursive: true})
		await execa('mount', ['--bind', nodePath.join(internalMountpoint, 'home'), homeMount])
		await execa('mount', ['--bind', nodePath.join(internalMountpoint, 'app-data'), appsMount])

		return directoryName
	}

	async unmountBackup(directoryName: string) {
		this.logger.log(`Unmounting backup ${directoryName}`)

		const backupRoot = nodePath.join(this.backupRoot, directoryName)
		const homeMount = nodePath.join(backupRoot, 'Home')
		const appsMount = nodePath.join(backupRoot, 'Apps')

		await execa('umount', [homeMount]).catch((error) =>
			this.logger.error(`Failed to unmount ${homeMount}: ${error.message}`),
		)
		await execa('umount', [appsMount]).catch((error) =>
			this.logger.error(`Failed to unmount ${appsMount}: ${error.message}`),
		)
		await fse.remove(backupRoot).catch((error) => this.logger.error(`Failed to remove ${backupRoot}: ${error.message}`))

		const internalMountpoint = nodePath.join(this.internalMountPath, directoryName)
		await execa('umount', [internalMountpoint]).catch((error) =>
			this.logger.error(`Failed to unmount ${internalMountpoint}: ${error.message}`),
		)
		await fse
			.remove(internalMountpoint)
			.catch((error) => this.logger.error(`Failed to remove ${internalMountpoint}: ${error.message}`))

		this.logger.log(`Unmounted backup ${directoryName}`)
		return true
	}

	async unmountAll(): Promise<void> {
		const backups = await fse.readdir(this.backupRoot).catch(() => [])

		await Promise.all(
			backups.map((backup) =>
				this.unmountBackup(backup).catch((error) => this.logger.error(`Failed to unmount ${backup}: ${error.message}`)),
			),
		)

		const internalMounts = await fse.readdir(this.internalMountPath).catch(() => [])
		await Promise.all(
			internalMounts.map((internalMount) =>
				this.unmountBackup(internalMount).catch((error) =>
					this.logger.error(`Failed to unmount ${internalMount}: ${error.message}`),
				),
			),
		)
	}
}
