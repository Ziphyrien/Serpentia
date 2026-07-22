import { Effect, Schema } from "effect";
import { identifyAccessKey } from "./access-key";

const AccessKeyRecord = Schema.Struct({
  playerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  hash: Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64)),
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
    catch: () => new AccessRegistryError({ message: "Access key registry is not JSON" }),
  });
  const records = yield* Schema.decodeUnknownEffect(AccessKeyRecords)(raw).pipe(
    Effect.mapError((error) => new AccessRegistryError({ message: error.message })),
  );
  return new Map(records.map((record) => [record.hash.toLowerCase(), record.playerId]));
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
