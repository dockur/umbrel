import fse from 'fs-extra'
import yaml from 'js-yaml'

import type Umbreld from '../../index.js'

async function readYaml(path: string) {
	return yaml.load(await fse.readFile(path, 'utf8'))
}

async function writeYaml(path: string, data: any) {
	return fse.writeFile(path, yaml.dump(data))
}

class Migration {
	umbreld: Umbreld
	logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		this.umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLowerCase())
	}

	async activateImportedDataDirectory() {
		const importData = `${this.umbreld.dataDirectory}/import`
		const importDataExists = await fse.exists(importData)
		if (!importDataExists) return
		this.logger.log('Found Umbrel data to import, activating...')
		// We have to move the import dir parrallel to the data dir and then overwrte.
		// This is because fse.move doesn't work if the source is a subdirectory of the destination.
		// This is fine to do on Umbrel Home because all of /home is on the large data partition.
		// On Rasperry Pi the data partition is small on the SD card and only the data dir on the
		// large external USB storage. We don't currently support data import on Pi so it's ok for now
		// but we'll need to handle this if we want to support it in the future.
		const temporaryData = `${this.umbreld.dataDirectory}-import-temp`
		await fse.move(importData, temporaryData, {overwrite: true})
		await fse.move(temporaryData, this.umbreld.dataDirectory, {overwrite: true})
	}

	async migrateBackThatMacUpPort() {
		// Check if the Back That Mac Up app is installed
		const isBackThatMacUpInstalled = ((await this.umbreld.store.get('apps')) || []).includes('back-that-mac-up')
		if (!isBackThatMacUpInstalled) return

		// Check if app has already been migrated
		const composePath = `${this.umbreld.dataDirectory}/app-data/back-that-mac-up/docker-compose.yml`
		const newSambaPortMapping = '1445:445'
		const compose = (await readYaml(composePath)) as any
		if (compose.services.timemachine.ports[0] === newSambaPortMapping) return
		this.logger.log('Old Back That Mac Up app found, migrating...')

		// Update the docker-compose.yml file to use the new samba port mapping
		// to avoid collisions with umbrelOS Samba port
		compose.services.timemachine.ports = [newSambaPortMapping]
		await writeYaml(composePath, compose)
		this.logger.log('Back That Mac Up app migrated')

		// Add notification
		await this.umbreld.notifications.add('migrated-back-that-mac-up')
	}

	async migrateDownloadsDirectory() {
		const legacyDownloadsPath = `${this.umbreld.dataDirectory}/data/storage/downloads`
		const newDownloadsPath = `${this.umbreld.files.getBaseDirectory('/Home')}/Downloads`
		const legacyDownloadsPathExists = await fse.exists(legacyDownloadsPath)
		const newDownloadsPathHasData =
			(await fse.exists(newDownloadsPath)) && (await fse.readdir(newDownloadsPath)).length > 0
		if (!legacyDownloadsPathExists || newDownloadsPathHasData) return
		this.logger.log('Found legacy Downloads directory, migrating...')
		await fse.ensureDir(newDownloadsPath)
		await fse.move(legacyDownloadsPath, newDownloadsPath, {overwrite: true})
		this.logger.log('Downloads directory migrated')
	}

	async start() {
		this.logger.log('Checking if any migrations are needed...')

		// Ensure data directory exists
		// await fse.ensureDir(this.umbreld.dataDirectory)

		// Check for Mender to Rugix state migration and complete it if needed
		// try {
		// 	const {reboot} = await this.finalizeMenderToRugixStateMigration()
		// 	// We don't want to continue with any other migrations
		// 	if (reboot) return {reboot: true}
		// } catch (error) {
		// 	this.logger.error(`Failed to finalize Mender to Rugix state migration`, error)
		//}

		// Check for a data directory to import
		try {
			await this.activateImportedDataDirectory()
		} catch (error) {
			this.logger.error(`Failed to activate imported Umbrel data`, error)
		}

		// Check for a legacy <1.0 Umbrel data directory and migrate to 1.0 format if found
		//try {
		//	await this.migrateLegacyData()
		//} catch (error) {
		//	this.logger.error(`Failed to migrate legacy data`, error)
		//}

		// Check for first boot of an unknown device and migrate legacy Linux install data if it exists
		// try {
		// 	await this.migrateLegacyLinuxData()
		// } catch (error) {
		// 	this.logger.error(`Failed to migrate legacy Linux data`, error)
		//}

		// Check for the Back That Mac Up app and migrate it if it exists
		try {
			await this.migrateBackThatMacUpPort()
		} catch (error) {
			this.logger.error(`Failed to migrate Back That Mac Up app`, error)
		}

		// Migrate Downloads directory to Home/Downloads
		try {
			await this.migrateDownloadsDirectory()
		} catch (error) {
			this.logger.error(`Failed to migrate Downloads directory`, error)
		}

		// Write the current version to signal what version we've migrated up to.
		// This also serves as a read/write permission check on the first run.
		const previousVersion = await this.umbreld.store.get('version')
		if (previousVersion && previousVersion !== this.umbreld.version) {
			await this.umbreld.store.set('previousVersion', previousVersion)
		} else if (!previousVersion) {
			await this.umbreld.store.delete('previousVersion')
		}
		await this.umbreld.store.set('version', this.umbreld.version)

		// Add notification if version changed
		if (previousVersion && previousVersion !== this.umbreld.version) {
			await this.umbreld.notifications.add('umbrelos-updated').catch(() => {})
		}

		this.logger.log('Migrations complete')
		return {reboot: false}
	}
}

export default Migration
