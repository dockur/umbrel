import {router, privateProcedure, publicProcedureWhenNoUserExists} from '../server/trpc/trpc.js'

import {getMigrationStatus} from './migration.js'
import isUmbrelHome from '../is-umbrel-home.js'

const unsupportedMessage = 'Migration from an external Umbrel installation is not supported in Docker.'

export default router({
	isUmbrelHome: privateProcedure.query(() => isUmbrelHome()),
	// TODO: Implement
	isMigratingFromUmbrelHome: privateProcedure.query(() => false),

	canMigrate: privateProcedure.query(async () => {
		throw new Error(unsupportedMessage)
	}),

	// TODO: Refactor this into a subscription
	migrationStatus: publicProcedureWhenNoUserExists.query(() => getMigrationStatus()),

	migrate: privateProcedure.mutation(async () => {
		throw new Error(unsupportedMessage)
	}),
})
