import type { CursorCatalogCache } from "./catalog-cache.js";
import type { CursorModelCatalog } from "./model-mapper.js";

const CACHE_SAVE_FAILED = "Cursor model catalog cache persistence failed.";
const CACHE_CLEAR_FAILED = "Cursor model catalog cache clear failed.";

interface ScopeMutationLane {
	generation: number;
	pendingInvalidations: number;
	invalidated: boolean;
	running: boolean;
	tail: Promise<void>;
}

export interface CursorCacheMutationCoordinatorOptions {
	readonly cache: CursorCatalogCache;
	readonly onError?: (error: Error) => void;
}

export class CursorCacheMutationCoordinator {
	readonly #cache: CursorCatalogCache;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #lanes = new Map<string, ScopeMutationLane>();

	constructor(options: CursorCacheMutationCoordinatorOptions) {
		this.#cache = options.cache;
		this.#onError = options.onError;
	}

	load(credentialScope: string): CursorModelCatalog | null {
		const lane = this.#lanes.get(credentialScope);
		if (lane && (lane.pendingInvalidations > 0 || lane.invalidated)) return null;
		return this.#cache.load(credentialScope);
	}

	save(catalog: CursorModelCatalog, credentialScope: string): void {
		const lane = this.#lane(credentialScope);
		const generation = lane.generation;
		this.#enqueue(credentialScope, lane, async () => {
			if (lane.generation !== generation) return;
			try {
				await this.#cache.save(catalog, credentialScope);
				if (lane.generation === generation) lane.invalidated = false;
			} catch {
				this.#onError?.(new Error(CACHE_SAVE_FAILED));
			}
		});
	}

	clear(credentialScope: string): void {
		const lane = this.#lane(credentialScope);
		lane.generation += 1;
		const generation = lane.generation;
		lane.invalidated = true;
		lane.pendingInvalidations += 1;
		this.#enqueue(credentialScope, lane, async () => {
			try {
				// Without a physical clear, retain the tombstone until a successful replacement save.
				if (this.#cache.clear === undefined) return;
				await this.#cache.clear(credentialScope);
				if (lane.generation === generation) lane.invalidated = false;
			} catch {
				this.#onError?.(new Error(CACHE_CLEAR_FAILED));
			} finally {
				lane.pendingInvalidations -= 1;
			}
		});
	}

	async waitForIdle(credentialScope: string): Promise<void> {
		await this.#lanes.get(credentialScope)?.tail;
	}

	#lane(credentialScope: string): ScopeMutationLane {
		const existing = this.#lanes.get(credentialScope);
		if (existing) return existing;
		const created: ScopeMutationLane = {
			generation: 0,
			pendingInvalidations: 0,
			invalidated: false,
			running: false,
			tail: Promise.resolve(),
		};
		this.#lanes.set(credentialScope, created);
		return created;
	}

	#enqueue(credentialScope: string, lane: ScopeMutationLane, operation: () => Promise<void>): void {
		const task = lane.running ? lane.tail.then(operation, operation) : operation();
		lane.running = true;
		lane.tail = task.then(() => undefined, () => undefined);
		const tail = lane.tail;
		void tail.then(() => {
			if (lane.tail !== tail) return;
			lane.running = false;
			if (lane.pendingInvalidations === 0 && !lane.invalidated) this.#lanes.delete(credentialScope);
		});
	}
}
