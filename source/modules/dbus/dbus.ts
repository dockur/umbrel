// Stub dbus module for Docker — D-Bus is not available inside a container.

import type Umbreld from '../../index.js'

export default class Dbus {
	#umbreld: Umbreld
	logger: Umbreld['logger']

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
}
