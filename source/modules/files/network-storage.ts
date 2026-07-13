import type Umbreld from '../../index.js'

type NetworkShareInput = {
    host: string
    share: string
    username: string
    password: string
}

export default class NetworkStorage {
    #umbreld: Umbreld
    logger: Umbreld['logger']
    shareWatchInterval = 1000 * 60

    constructor(umbreld: Umbreld) {
        this.#umbreld = umbreld
        const {name} = this.constructor
        this.logger = umbreld.logger.createChildLogger(`files:${name.toLowerCase()}`)
    }

    async start() {
        this.logger.log('Network storage is disabled in Docker')
    }

    async stop() {
        return
    }

    async getShares() {
        return []
    }

    async getShareInfo() {
        return []
    }

    async addShare(_share: NetworkShareInput) {
        throw new Error('Network storage is not supported in Docker.')
    }

    async removeShare(_mountPath: string) {
        throw new Error('Network storage is not supported in Docker.')
    }

    async discoverServers() {
        return []
    }

    async discoverSharesOnServer(_host: string, _username: string, _password: string) {
        throw new Error('Network storage is not supported in Docker.')
    }

    async isServerAnUmbrelDevice(_address: string) {
        return false
    }
}
