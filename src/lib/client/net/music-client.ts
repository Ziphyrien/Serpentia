import { Schema } from "effect";
import {
  MusicSearchResponse,
  MusicSourceErrorCode,
  MusicSourceErrorResponse,
  MusicSourceResolveResponse,
  MusicSourceStatusResponse,
  type BackendDescriptor,
  type MusicSearchRequest,
  type MusicSearchResponse as MusicSearchResponseType,
  type MusicSourceErrorCode as MusicSourceErrorCodeType,
  type MusicSourceResolveRequest,
  type MusicSourceResolveResponse as MusicSourceResolveResponseType,
  type MusicSourceStatusResponse as MusicSourceStatusResponseType,
} from "$lib/protocol";

type MusicFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MusicClientError extends Schema.TaggedErrorClass<MusicClientError>()(
  "MusicClientError",
  {
    stage: Schema.Literals(["aborted", "transport", "protocol", "server"]),
    code: Schema.optionalKey(MusicSourceErrorCode),
    cause: Schema.Defect(),
  },
) {}

export class MusicClient {
  constructor(
    private readonly statusPath = "/api/music",
    private readonly searchPath = "/api/music/search",
    private readonly resolvePath = "/api/music/resolve",
    private readonly fetcher: MusicFetch = globalThis.fetch,
  ) {}

  static fromDescriptor(
    descriptor: BackendDescriptor,
    fetcher: MusicFetch = globalThis.fetch,
  ): MusicClient {
    return new MusicClient(
      descriptor.musicPath,
      descriptor.musicSearchPath,
      descriptor.musicResolvePath,
      fetcher,
    );
  }

  async readStatus(signal?: AbortSignal): Promise<MusicSourceStatusResponseType> {
    const response = await this.request(this.statusPath, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) throw await this.serverError(response);
    return this.decode(Schema.decodeUnknownPromise(MusicSourceStatusResponse), response, "status");
  }

  async search(
    request: MusicSearchRequest,
    signal?: AbortSignal,
  ): Promise<MusicSearchResponseType> {
    const response = await this.request(this.searchPath, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await this.serverError(response);
    return this.decode(Schema.decodeUnknownPromise(MusicSearchResponse), response, "search");
  }

  async resolve(
    request: MusicSourceResolveRequest,
    signal?: AbortSignal,
  ): Promise<MusicSourceResolveResponseType> {
    const response = await this.request(this.resolvePath, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await this.serverError(response);
    return this.decode(
      Schema.decodeUnknownPromise(MusicSourceResolveResponse),
      response,
      "resolve",
    );
  }

  private async request(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (cause) {
      throw MusicClientError.make({
        stage: init.signal?.aborted ? "aborted" : "transport",
        cause,
      });
    }
  }

  private async serverError(response: Response): Promise<MusicClientError> {
    try {
      const body = await Schema.decodeUnknownPromise(MusicSourceErrorResponse)(
        await response.json(),
      );
      return MusicClientError.make({ stage: "server", code: body.error, cause: body.error });
    } catch (cause) {
      if (cause instanceof MusicClientError) return cause;
      return MusicClientError.make({ stage: "protocol", cause });
    }
  }

  private async decode<A>(
    decode: (input: unknown) => Promise<A>,
    response: Response,
    operation: string,
  ): Promise<A> {
    try {
      return await decode(await response.json());
    } catch (cause) {
      throw MusicClientError.make({
        stage: "protocol",
        cause: new Error(`Invalid music ${operation} response`, { cause }),
      });
    }
  }
}

export function isMusicServerError(
  error: MusicClientError,
  code: MusicSourceErrorCodeType,
): boolean {
  return error.stage === "server" && error.code === code;
}
