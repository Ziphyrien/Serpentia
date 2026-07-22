import { Effect, Schema } from "effect";
import { PlayerId } from "../../protocol/state";
import { identifyAccessKey } from "./access-key";

const AccessKeyRecord = Schema.Struct({
  playerId: PlayerId,
  hash: Schema.String.check(
    Schema.isMinLength(64),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[0-9a-fA-F]{64}$/u),
  ),
});
const AccessKeyRecords = Schema.Array(AccessKeyRecord);

export class AccessRegistryError extends Schema.TaggedErrorClass<AccessRegistryError>()(
  "AccessRegistryError",
  { message: Schema.String },
) {}

export const parseAccessKeyRegistry = Effect.fn("parseAccessKeyRegistry")(function* (
  serialized: string,
) {
  const raw = yield* Effect.try({
    try: () => parseJson(serialized),
    catch: () => AccessRegistryError.make({ message: "Access key registry is not JSON" }),
  });
  const records = yield* Schema.decodeUnknownEffect(AccessKeyRecords)(raw).pipe(
    Effect.mapError((error) => AccessRegistryError.make({ message: error.message })),
  );
  const registry = new Map<string, string>();
  const playerIds = new Set<string>();
  for (const record of records) {
    const hash = record.hash.toLowerCase();
    if (registry.has(hash) || playerIds.has(record.playerId)) {
      return yield* Effect.fail(
        AccessRegistryError.make({
          message: "Access key registry contains duplicate hashes or player IDs",
        }),
      );
    }
    registry.set(hash, record.playerId);
    playerIds.add(record.playerId);
  }
  return registry;
});

export async function identifyPlayer(
  accessKey: string,
  registry: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  return identifyAccessKey(accessKey, registry);
}

function parseJson(serialized: string): unknown {
  return JSON.parse(serialized);
}
