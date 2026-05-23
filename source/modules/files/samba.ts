import fse from 'fs-extra'

import randomToken from '../utilities/random-token.js'

import type Umbreld from '../../index.js'
import type {FileChangeEvent} from './watcher.js'

export default class Samba {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	#removeFileChangeListener?: () => void

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`files:${name.toLocaleLowerCase()}`)
	}

	// Add listener
	async start() {
        // Samba is disabled in Docker because it may conflict with the host daemon (since we use pid:host)
		// We still handle share management in the store so the UI state is preserved.
 
		// Attach listener to clean up shares when directories are deleted
		this.#removeFileChangeListener = this.#umbreld.eventBus.on(
			'files:watcher:change',
			this.#handleFileChange.bind(this),
		)
	}

	// Remove listener
	async stop() {
		this.#removeFileChangeListener?.()
	}

	// Gets the share password
	// On first run it will generate a random password and save it to the file.
	// TODO: Some kind of umbreld.secrets.get() api for dealing with this kind
	// of stuff might be nice in the future.
	async getSharePassword() {
		const sharePasswordFile = `${this.#umbreld.dataDirectory}/secrets/share-password`

		// Get or create the share password
		const sharePassword = await fse.readFile(sharePasswordFile, 'utf8').catch(async () => {
			this.logger.log('Creating share password on first run')
			const sharePassword = randomToken(128)
			await fse.writeFile(sharePasswordFile, sharePassword)
			return sharePassword
		})

		return sharePassword
	}

    async applySharePassword() {
		// Samba is not started in Docker mode
		return
	}

	// Apply shares — no-op in Docker (Samba not running)
	async applyShares({excludePaths}: {excludePaths?: string[]} = {}) {
		// Samba is not started in Docker mode
		return
	}

    // Remove shares on deletion
	// Note: The watcher only covers /Home, /Trash, and /Apps. External drives are not watched,
	// so if a shared folder on an external drive is deleted outside the UI while the drive is
	// connected, the share will remain in the store but be marked as unavailable by listShares()
	// and skipped by applyShares(). (UI-initiated deletes handle share removal in files.ts.)
	// TODO: It would be nice if we could handle updating favorites when the favorited directory is
	// moved/renamed. It's not trivial because this can happen via something external like an app or SMB
	// and there's no way to tell the difference between a move/rename and a deletion/recreation.
	async #handleFileChange(event: FileChangeEvent) {
		return
	}

	// List favorited directories
	async listShares() {
		return []
	}

	// Share a new directory
	async addShare(virtualPath: string) {
		throw new Error('Not supported in Docker!')
	}

	// Remove a share
	async removeShare(virtualPath: string) {
		return true
	}
}
