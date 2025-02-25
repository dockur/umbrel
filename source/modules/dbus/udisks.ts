import {EventEmitter} from 'node:events'

import type DBus from './index.js'

const changeDebounceTimeout = 2000

class UDisks extends EventEmitter {
	dbus: DBus
	logger: DBus['logger']
	manager: EventEmitter | null = null
	timeout: NodeJS.Timeout | null = null

	constructor(dbus: DBus) {
		super()
		this.dbus = dbus
		const {name: parentName} = dbus.constructor
		const {name} = this.constructor
		this.logger = dbus.logger.createChildLogger(`${parentName.toLocaleLowerCase()}:${name.toLowerCase()}`)
	}

	async start() {
		return
	}

	async stop() {
		return
	}

	#handleInterfacesChanged = () => {
		if (this.timeout) clearTimeout(this.timeout)
		this.timeout = setTimeout(() => {
			this.logger.log('Interfaces changed')
			this.timeout = null
			this.emit('change')
		}, changeDebounceTimeout)
	}
}

export default UDisks
