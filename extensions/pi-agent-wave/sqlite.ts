import { DatabaseSync, type SQLInputValue } from "node:sqlite";

interface StatementQuery<TRow, TParams extends unknown[]> {
	run(...params: TParams): void;
	get(...params: TParams): TRow | undefined;
	all(...params: TParams): TRow[];
}

/** Normalizes Node's synchronous SQLite statements behind the small query API used by the store. */
export class Database {
	private readonly database: DatabaseSync;

	constructor(path: string, _options: { create?: boolean; strict?: boolean; readonly?: boolean } = {}) {
		this.database = new DatabaseSync(path);
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	query<TRow = Record<string, unknown>, TParams extends unknown[] = unknown[]>(sql: string): StatementQuery<TRow, TParams> {
		const statement = this.database.prepare(sql);
		const normalize = (params: TParams): SQLInputValue[] => params as SQLInputValue[];
		return {
			run: (...params) => {
				statement.run(...normalize(params));
			},
			get: (...params) => statement.get(...normalize(params)) as TRow | undefined,
			all: (...params) => statement.all(...normalize(params)) as TRow[],
		};
	}

	close(): void {
		this.database.close();
	}
}
