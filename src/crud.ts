// CRUD operations
import { z } from "../deps.ts";
import { PentagonCreateItemError, PentagonDeleteItemError } from "./errors.ts";
import {
  keysToIndexes,
  schemaToKeys,
  selectFromEntries,
  whereToKeys,
} from "./keys.ts";
import { isToManyRelation } from "./relation.ts";
import {
  CreateArgs,
  CreateManyArgs,
  DatabaseValue,
  QueryArgs,
  QueryKvOptions,
  TableDefinition,
  WithMaybeVersionstamp,
  WithVersionstamp,
} from "./types.ts";
import { mergeValueAndVersionstamp } from "./util.ts";

export async function listTable<T>(kv: Deno.Kv, tableName: string) {
  const items = new Array<Deno.KvEntry<T>>();
  for await (const item of kv.list<T>({ prefix: [tableName] })) {
    items.push(item);
  }
  return items;
}

export async function read<T extends readonly unknown[]>(
  kv: Deno.Kv,
  keys: readonly [...{ [K in keyof T]: Deno.KvKey }],
  kvOptions?: QueryKvOptions,
) {
  const res = await kv.getMany<T>(keys, kvOptions);
  return res;
}

export async function remove(
  kv: Deno.Kv,
  keys: Deno.KvKey[],
): Promise<WithVersionstamp<Record<string, DatabaseValue>>> {
  let res = kv.atomic();

  // @todo: do we need these checks here for delete ops?
  /* for (let i = 0; i < keys.length; i++) {
    res = chainAccessKeyCheck(res, keys[i], null);
  } */

  for (const key of keys) {
    res = res.delete(key);
  }

  const commitResult = await res.commit();

  if (commitResult.ok) {
    return {
      versionstamp: commitResult.versionstamp,
    };
  }
  throw new PentagonDeleteItemError(`Could not delete item.`);
}

export async function update<
  T extends TableDefinition,
  Item extends z.output<T["schema"]>,
>(
  kv: Deno.Kv,
  entries: Deno.KvEntry<Item>[],
): Promise<WithVersionstamp<Item>[]> {
  let res = kv.atomic();

  // Checks
  for (const entry of entries) {
    res = res.check(entry);
  }

  // Sets
  for (const { value, key } of entries) {
    res = res.set(key, value);
  }

  const commitResult = await res.commit();

  if (commitResult.ok) {
    return entries.map(({ value }) => ({
      ...value,
      versionstamp: commitResult.versionstamp,
    }));
  }

  throw new PentagonCreateItemError(`Could not update item.`);
}

export async function create<T extends TableDefinition>(
  kv: Deno.Kv,
  tableName: string,
  tableDefinition: T,
  createArgs: CreateArgs<T>,
): Promise<WithVersionstamp<z.output<T["schema"]>>> {
  let res = kv.atomic();
  const keys = schemaToKeys(tableDefinition.schema, createArgs.data);
  const indexKeys = keysToIndexes(tableName, keys);
  const item: z.output<T["schema"]> = tableDefinition.schema.parse(
    createArgs.data,
  );

  for (const key of indexKeys) {
    res = res.check({ key, versionstamp: null }).set(key, item); // TODO: Currently checks ALL keys, should only check unique ones
  }

  const commitResult = await res.commit();

  if (commitResult.ok) {
    return {
      ...item,
      versionstamp: commitResult.versionstamp,
    };
  }

  throw new PentagonCreateItemError(`Could not create item.`);
}

export async function createMany<T extends TableDefinition>(
  kv: Deno.Kv,
  tableName: string,
  tableDefinition: T,
  createManyArgs: CreateManyArgs<T>,
): Promise<WithVersionstamp<z.output<T["schema"]>>[]> {
  let res = kv.atomic();
  const items: z.output<T["schema"]>[] = [];

  for (const data of createManyArgs.data) {
    const keys = schemaToKeys(tableDefinition.schema, data);
    const indexKeys = keysToIndexes(tableName, keys);
    const item: z.output<T["schema"]> = tableDefinition.schema.parse(data);

    for (const key of indexKeys) {
      res = res.check({ key, versionstamp: null }).set(key, item); // TODO: Currently checks ALL keys, should only check unique ones
    }

    items.push(item);
  }

  const commitResult = await res.commit();

  if (commitResult.ok) {
    return items.map((item) => ({
      ...item,
      versionstamp: commitResult.versionstamp,
    }));
  }

  throw new PentagonCreateItemError(`Could not create items.`);
}

export async function findMany<T extends TableDefinition>(
  kv: Deno.Kv,
  tableName: string,
  tableDefinition: T,
  queryArgs: QueryArgs<T>,
) {
  const keys = schemaToKeys(tableDefinition.schema, queryArgs.where ?? []);
  const indexKeys = keysToIndexes(tableName, keys);
  const foundItems = await whereToKeys(
    kv,
    tableName,
    indexKeys,
    queryArgs.where ?? {},
  );

  if (queryArgs.include) {
    for (
      const [relationName, relationValue] of Object.entries(
        queryArgs.include,
      )
    ) {
      // Relation name
      const relationDefinition = tableDefinition.relations?.[relationName];
      if (!relationDefinition) {
        throw new Error(
          `No relation found for relation name "${relationName}", make sure it's ∂efined in your Pentagon configuration.`,
        );
      }
      const tableName = relationDefinition[0];
      const localKey = relationDefinition[2];
      const foreignKey = relationDefinition[3];

      for (let i = 0; i < foundItems.length; i++) {
        const foundRelationItems = await findMany(
          kv,
          tableName,
          tableDefinition,
          {
            select: relationValue === true ? undefined : relationValue,
            where: {
              [foreignKey]: foundItems[i].value[localKey],
            } as Partial<WithMaybeVersionstamp<z.infer<T["schema"]>>>,
          },
        );

        // Add included relation value
        foundItems[i].value[relationName] = isToManyRelation(relationDefinition)
          ? foundRelationItems
          : foundRelationItems?.[0];
      }
    }
  }

  // Select
  const selectedItems = queryArgs.select
    ? selectFromEntries(foundItems, queryArgs.select)
    : foundItems;

  return selectedItems.map((item) => mergeValueAndVersionstamp(item));
}
