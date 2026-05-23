import path from 'node:path'

import {$} from 'execa'
import type Umbreld from '../../index.js'

const BACKUP_PREFIX = 'umbrel-factory-reset'

// Factory reset using Rugix Ctrl's state management. This triggers an immediate reboot.
// We use the --backup flag which renames the old state directory instead of deleting
// it during boot. This makes boot fast (mv is instant) and we clean up the old
// state in the background after umbreld starts.
export async function performReset() {
	throw new Error("Factory reset is not supported in a Docker container, just remove the volume instead!")
}

// Clean up state backups from factory resets
export async function cleanupFactoryResetBackups(umbreld: Umbreld) {
	return
}
