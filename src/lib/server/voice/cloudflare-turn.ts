import { Effect, Schema } from "effect";
import { IceServer, type TurnCredentialsResponse } from "../../protocol";

export const TURN_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;
export const TURN_CREDENTIAL_REFRESH_MARGIN_SECONDS = 15 * 60;

const TURN_KEY_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const TURN_KEY_API_TOKEN_PATTERN = /^[0-9a-f]{64}$/iu;
const MAXIMUM_TURN_CREDENTIAL_TTL_SECONDS = 48 * 60 * 60;
const CLOUDFLARE_TURN_REQUEST_TIMEOUT_MILLISECONDS = 5_000;

const CloudflareTurnResponse = Schema.Struct({
  iceServers: Schema.Array(IceServer),
});

export interface CloudflareTurnConfig {
  readonly turnKeyId: string;
  readonly turnKeyApiToken: string;
}

export interface CloudflareTurnRequestOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: number;
  readonly ttlSeconds?: number;
}

export class TurnCredentialsError extends Schema.TaggedErrorClass<TurnCredentialsError>()(
  "TurnCredentialsError",
  {
    reason: Schema.Union([
      Schema.Literal("MISCONFIGURED"),
      Schema.Literal("REQUEST_FAILED"),
      Schema.Literal("INVALID_RESPONSE"),
    ]),
  },
) {}

export function isCloudflareTurnConfigured(config: CloudflareTurnConfig): boolean {
  return (
    TURN_KEY_ID_PATTERN.test(config.turnKeyId) &&
    TURN_KEY_API_TOKEN_PATTERN.test(config.turnKeyApiToken)
  );
}

export const requestCloudflareTurnCredentials = Effect.fn("requestCloudflareTurnCredentials")(
  function* (
    config: CloudflareTurnConfig,
    playerId: string,
    options: CloudflareTurnRequestOptions = {},
  ) {
    const ttlSeconds = options.ttlSeconds ?? TURN_CREDENTIAL_TTL_SECONDS;
    if (
      !isCloudflareTurnConfigured(config) ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds <= TURN_CREDENTIAL_REFRESH_MARGIN_SECONDS ||
      ttlSeconds > MAXIMUM_TURN_CREDENTIAL_TTL_SECONDS
    ) {
      return yield* Effect.fail(TurnCredentialsError.make({ reason: "MISCONFIGURED" }));
    }

    const fetcher = options.fetcher ?? fetch;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${config.turnKeyId}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.turnKeyApiToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ ttl: ttlSeconds, customIdentifier: playerId }),
            signal: AbortSignal.timeout(CLOUDFLARE_TURN_REQUEST_TIMEOUT_MILLISECONDS),
          },
        ),
      catch: () => TurnCredentialsError.make({ reason: "REQUEST_FAILED" }),
    });
    if (response.status !== 201) {
      return yield* Effect.fail(TurnCredentialsError.make({ reason: "REQUEST_FAILED" }));
    }

    const raw = yield* Effect.tryPromise({
      try: () => readResponseJson(response),
      catch: () => TurnCredentialsError.make({ reason: "INVALID_RESPONSE" }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(CloudflareTurnResponse)(raw).pipe(
      Effect.mapError(() => TurnCredentialsError.make({ reason: "INVALID_RESPONSE" })),
    );
    const iceServers = browserSafeIceServers(decoded.iceServers);
    if (!hasAuthenticatedTurnServer(iceServers)) {
      return yield* Effect.fail(TurnCredentialsError.make({ reason: "INVALID_RESPONSE" }));
    }

    const now = Math.floor(options.now ?? Date.now());
    const expiresAt = now + ttlSeconds * 1_000;
    return {
      iceServers,
      expiresAt,
      refreshAfter: expiresAt - TURN_CREDENTIAL_REFRESH_MARGIN_SECONDS * 1_000,
    } satisfies TurnCredentialsResponse;
  },
);

function browserSafeIceServers(iceServers: ReadonlyArray<IceServer>): Array<IceServer> {
  const result: Array<IceServer> = [];
  for (const iceServer of iceServers) {
    const urls = iceServer.urls.filter((url) => !/:53(?:\?|$)/u.test(url));
    if (urls.length === 0) continue;
    if (iceServer.username === undefined && iceServer.credential === undefined) {
      result.push({ urls });
      continue;
    }
    if (iceServer.username !== undefined && iceServer.credential !== undefined) {
      result.push({ urls, username: iceServer.username, credential: iceServer.credential });
    }
  }
  return result;
}

function hasAuthenticatedTurnServer(iceServers: ReadonlyArray<IceServer>): boolean {
  return iceServers.some(
    (iceServer) =>
      iceServer.username !== undefined &&
      iceServer.credential !== undefined &&
      iceServer.urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:")),
  );
}

async function readResponseJson(response: Response): Promise<unknown> {
  return response.json();
}
