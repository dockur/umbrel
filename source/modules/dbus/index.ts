import type Umbreld from '../../index.js'
import UDisks from './udisks.js'

class DBus {
	logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLowerCase())
	}

	get system() {
		throw new Error('System bus not connected')
	}

	get session() {
		throw new Error('Session bus not implemented')
	}

	async start() {
    return
	}

	async stop() {
		return
	}
}

export default DBus
