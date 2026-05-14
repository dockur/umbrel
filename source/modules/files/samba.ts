import nodePath from 'node:path'

import fse from 'fs-extra'
import {$} from 'execa'

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
	async getSharePassword() {
		const sharePasswordFile = `${this.#umbreld.dataDirectory}/secrets/share-password`

		const sharePassword = await fse.readFile(sharePasswordFile, 'utf8').catch(async () => {
			this.logger.log('Creating share password on first run')
			const sharePassword = randomToken(128)
			await fse.writeFile(sharePasswordFile, sharePassword)
			return sharePassword
		})

		return sharePassword
	}

	// Apply shares — no-op in Docker (Samba not running)
	async applyShares() {
		// Samba is not started in Docker mode
	}

	// Compute a client-facing sharename
	async #computeSharename(name: string, path: string) {
		let sharename = `${name} (Umbrel)`
		if (path === '/Home') {
			const user = await this.#umbreld.user.get()
			const username = user?.name
			if (username) sharename = `${username}'s Umbrel`
		}
		return sharename
	}

	// Read current shares from the store
	async #get() {
		const shares = await this.#umbreld.store.get('files.shares')
		return shares || []
	}

	// Remove shares on deletion
	async #handleFileChange(event: FileChangeEvent) {
		if (event.type !== 'delete') return
		const shares = await this.#get()
		const virtualDeletedPath = this.#umbreld.files.systemToVirtualPath(event.path)
		const deletedShares = shares.filter((share) => share.path.startsWith(virtualDeletedPath))
		for (const share of deletedShares) await this.removeShare(share.path)
	}

	// List shares
	async listShares() {
		const shares = await this.#get()

		const mappedShares = await Promise.all(
			shares.map(async (share) => {
				const systemPath = await this.#umbreld.files.virtualToSystemPath(share.path)
				const file = await this.#umbreld.files.status(systemPath).catch(() => undefined)
				if (file?.type !== 'directory') return undefined
				return share
			}),
		)
		const filteredShares = mappedShares.filter((share) => share !== undefined)

		const sharesWithSharenames = await Promise.all(
			filteredShares.map(async (share) => ({
				...share,
				sharename: await this.#computeSharename(share.name, share.path),
			})),
		)
		return sharesWithSharenames
	}

	// Share a new directory
	async addShare(virtualPath: string) {
		const allowedOperations = await this.#umbreld.files.getAllowedOperations(virtualPath)
		if (!allowedOperations.includes('share')) throw new Error('[operation-not-allowed]')

		this.logger.log(`Adding share for ${virtualPath}`)

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const shares = await this.#get()

			const shareExists = shares.some((share) => share.path === virtualPath)
			if (shareExists) throw new Error('[share-already-exists]')

			let name = nodePath.basename(virtualPath)
			let i = 1
			while (shares.some((share) => share.name === name)) {
				i++
				if (i > 10) throw new Error('[share-name-generation-failed]')
				name = `${nodePath.basename(virtualPath)} (${i})`
			}

			await set('files.shares', [...shares, {name, path: virtualPath}])
		})

		await this.applyShares()

		return virtualPath
	}

	// Remove a share
	async removeShare(virtualPath: string) {
		this.logger.log(`Removing share for ${virtualPath}`)

		let deleted = false
		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const shares = await this.#get()
			const newShares = shares.filter((share) => share.path !== virtualPath)
			deleted = newShares.length < shares.length
			if (deleted) await set('files.shares', newShares)
		})

		if (deleted) {
			await this.applyShares()
		}

		return deleted
	}
}
