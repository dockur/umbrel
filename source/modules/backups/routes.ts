import z from 'zod'

import {router, privateProcedure, publicProcedureWhenNoUserExists} from '../server/trpc/trpc.js'

const unsupportedRepositoryMessage =
	'Creating backup repositories is not supported in Docker. Configure a supported backup destination outside Umbrel.'

export default router({
	// Get all backup repositories
	getRepositories: privateProcedure.query(async ({ctx}) => {
		const repositories = await ctx.umbreld.backups.getRepositories()

		// Only return properties we want to expose
		return repositories.map(({id, path, lastBackup}) => ({id, path, lastBackup}))
	}),

	// Get size of a repository
	getRepositorySize: privateProcedure
		.input(z.object({repositoryId: z.string()}))
		.query(async ({ctx, input}) => ctx.umbreld.backups.getRepositorySize(input.repositoryId)),

	// Creating backup repositories is unavailable because Docker storage destinations are managed externally
	createRepository: privateProcedure
		.input(z.object({path: z.string(), password: z.string()}))
		.mutation(async () => {
			throw new Error(unsupportedRepositoryMessage)
		}),

	// Forget a repository
	forgetRepository: privateProcedure
		.input(z.object({repositoryId: z.string()}))
		.mutation(async ({ctx, input}) => ctx.umbreld.backups.forgetRepository(input.repositoryId)),

	// Do a backup right now
	backup: privateProcedure
		.input(z.object({repositoryId: z.string()}))
		.mutation(async ({ctx, input}) => ctx.umbreld.backups.backup(input.repositoryId)),

	// List backups for a repository
	listBackups: publicProcedureWhenNoUserExists
		.input(z.object({repositoryId: z.string()}))
		.query(async ({ctx, input}) => ctx.umbreld.backups.listBackups(input.repositoryId)),

	// List all backups for all repositories
	listAllBackups: privateProcedure.query(async ({ctx}) => ctx.umbreld.backups.listAllBackups()),

	// List files in a backup
	// Only really used for testing and debug
	listBackupFiles: privateProcedure
		.input(
			z.object({
				backupId: z.string(),
				path: z.string().optional(),
			}),
		)
		.query(async ({ctx, input}) => ctx.umbreld.backups.listBackupFiles(input.backupId, input.path)),

	// Mount-dependent backup browsing is unavailable in Docker
	mountBackup: privateProcedure
		.input(z.object({backupId: z.string()}))
		.mutation(async () => {
			throw new Error('Browsing backups is not supported in Docker.')
		}),

	// Mount-dependent backup browsing is unavailable in Docker
	unmountBackup: privateProcedure
		.input(z.object({directoryName: z.string()}))
		.mutation(async () => {
			throw new Error('Browsing backups is not supported in Docker.')
		}),

	// Get progress of backup operations
	backupProgress: privateProcedure.query(async ({ctx}) => ctx.umbreld.backups.backupsInProgress),

	// Get ignored paths
	getIgnoredPaths: privateProcedure.query(async ({ctx}) => ctx.umbreld.backups.getIgnoredPaths()),

	// Add an ignored path
	addIgnoredPath: privateProcedure
		.input(z.object({path: z.string()}))
		.mutation(async ({ctx, input}) => ctx.umbreld.backups.addIgnoredPath(input.path)),

	// Remove an ignored path
	removeIgnoredPath: privateProcedure
		.input(z.object({path: z.string()}))
		.mutation(async ({ctx, input}) => ctx.umbreld.backups.removeIgnoredPath(input.path)),

	// Connecting backup repositories is unavailable because Docker storage destinations are managed externally
	connectToExistingRepository: publicProcedureWhenNoUserExists
		.input(z.object({path: z.string(), password: z.string()}))
		.mutation(async () => {
			throw new Error(unsupportedRepositoryMessage)
		}),

	// Mount-dependent backup restoration is unavailable in Docker
	restoreBackup: publicProcedureWhenNoUserExists
		.input(z.object({backupId: z.string()}))
		.mutation(async () => {
			throw new Error('Restoring backups is not supported in Docker.')
		}),

	// Get status of restore operations
	restoreStatus: publicProcedureWhenNoUserExists.query(async ({ctx}) => ctx.umbreld.backups.restoreStatus),
})
